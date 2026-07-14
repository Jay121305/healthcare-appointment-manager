// backend/src/services/booking/bookingService.ts
// Core booking engine: holds, confirm, cancel, reschedule

import crypto from 'crypto';
import { prisma } from '../../config/prisma';
import { redisClient, holdKey } from '../../config/redis';
import { getAvailableSlots } from '../slotService';
import { preVisitQueue } from '../../workers/preVisitWorker';
import { calendarSyncQueue } from '../../workers/calendarSyncWorker';
import { enqueueBookingConfirmationNotifications, enqueueBookingCancellationNotifications } from '../../services/notification/notificationService';
// crypto is used for generateHoldToken, but the import is unused if we use the global crypto
// import crypto from 'crypto'; // Not needed as Node.js has global crypto

export interface PlaceHoldInput {
  doctorId: string;
  dateIso: string;      // YYYY-MM-DD
  startTimeIso: string; // HH:mm or full ISO
  patientUserId: string;
  patientProfileId: string;
  ttlSeconds?: number;  // default 300
}

export interface PlaceHoldResult {
  holdToken: string;
  expiresAt: string;
  doctorId: string;
  date: string;
  startTime: string;
  ttlSeconds: number;
}

export interface SymptomFormInput {
  primaryComplaint: string;
  durationDays?: number | null;
  severity?: 'MILD' | 'MODERATE' | 'SEVERE' | null;
  description?: string | null;
  currentMedications?: string[] | null;
  allergies?: string[] | null;
}

export interface ConfirmBookingInput {
  holdToken: string;
  doctorId: string;
  dateIso: string;
  startTimeIso: string;
  symptomForm: SymptomFormInput;
  patientUserId: string;
  patientProfileId: string;
}

export interface BookingResponse {
  id: string;
  patientId: string;
  doctorId: string;
  bookingDate: string;
  startTime: string;
  status: string;
  bookedAt: string;
  updatedAt: string;
  symptomForm?: {
    id: string;
    primaryComplaint: string;
    durationDays: number | null;
    severity: string | null;
    description: string | null;
    currentMedications: string[];
    allergies: string[];
    submittedAt: string;
  } | null;
}

export interface CancelBookingResult {
  booking: BookingResponse;
  message: string;
}

export interface RescheduleBookingResult {
  oldBooking: BookingResponse;
  newBooking: BookingResponse;
  message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Generate UUID-style hold token
// ─────────────────────────────────────────────────────────────────────────────

function generateHoldToken(): string {
  return `hold_${crypto.randomBytes(16).toString('hex')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Parse ISO time string to Date (UTC)
// ─────────────────────────────────────────────────────────────────────────────

function parseStartTime(timeStr: string, dateIso: string): Date {
  // If already full ISO, use it; otherwise combine date + time
  if (timeStr.includes('T')) {
    return new Date(timeStr);
  }
  const [hours, minutes] = timeStr.split(':').map(Number);
  const date = new Date(dateIso);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Format Date to HH:mm
// ─────────────────────────────────────────────────────────────────────────────

function formatTimeHHmm(date: Date): string {
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /bookings/holds — place a slot hold
// ─────────────────────────────────────────────────────────────────────────────

export async function placeHold(input: PlaceHoldInput): Promise<PlaceHoldResult> {
  const { doctorId, dateIso, startTimeIso, patientUserId, patientProfileId, ttlSeconds = 300 } = input;

  // 1. Verify doctor exists and is active
  const doctor = await prisma.doctorProfile.findUnique({
    where: { id: doctorId },
    include: { user: { select: { isActive: true } } },
  });

  if (!doctor || !doctor.user.isActive) {
    throw new Error('DOCTOR_NOT_FOUND');
  }

  // 2. Check if slot is still available (advisory, M2 service)
  const slotCheck = await getAvailableSlots(doctorId, dateIso);
  const timeStr = formatTimeHHmm(parseStartTime(startTimeIso, dateIso));
  const stillAvailable = slotCheck.slots.some(s => {
    const slotTime = new Date(s.startUTC);
    return formatTimeHHmm(slotTime) === timeStr;
  });

  if (!stillAvailable) {
    throw { code: 'SLOT_UNAVAILABLE', message: 'Slot is no longer available' };
  }

  // 3. Generate hold token and try to SET with NX
  const holdToken = generateHoldToken();
  const key = holdKey(doctorId, dateIso, startTimeIso);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  const payload = JSON.stringify({
    holdToken,
    patientUserId,
    patientProfileId,
    doctorId,
    dateIso,
    startTimeIso,
    formPayload: null,
  });

  const result = await redisClient.setnx(key, payload);
  if (result === 1) {
    await redisClient.expire(key, ttlSeconds);
  } else {
    // result === 0 means key already exists
    // Slot is already held
    const existing = await redisClient.get(key);
    if (existing) {
      const parsed = JSON.parse(existing);
      throw {
        code: 'SLOT_HELD',
        message: 'Slot is currently held by another patient',
        retryAfterSeconds: ttlSeconds,
        currentHolderDifferent: parsed.patientUserId !== patientUserId,
      };
    }
    throw { code: 'SLOT_HELD', message: 'Slot is currently held', retryAfterSeconds: ttlSeconds };
  }

  return {
    holdToken,
    expiresAt: expiresAt.toISOString(),
    doctorId,
    date: dateIso,
    startTime: startTimeIso,
    ttlSeconds,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /bookings/:holdToken/symptom-form — attach form to hold
// ─────────────────────────────────────────────────────────────────────────────

export async function attachFormToHold(
  holdToken: string,
  formPayload: SymptomFormInput,
  patientUserId: string
): Promise<{ holdToken: string; formSubmitted: boolean; expiresAt: string }> {
  // Find the hold by scanning keys (MVP approach)
  const keys = await redisClient.keys('bh:*');
  let matchedKey: string | null = null;
  let matchedPayload: any = null;

  for (const key of keys) {
    const data = await redisClient.get(key);
    if (!data) continue;
    const parsed = JSON.parse(data);
    if (parsed.holdToken === holdToken) {
      matchedKey = key;
      matchedPayload = parsed;
      break;
    }
  }

  if (!matchedKey) {
    throw { code: 'HOLD_EXPIRED', message: 'Hold has expired' };
  }

  if (matchedPayload.patientUserId !== patientUserId) {
    throw { code: 'HOLD_BELONGS_TO_OTHER_PATIENT', message: 'Hold belongs to another patient' };
  }

  // Update payload with form data and extend TTL
  matchedPayload.formPayload = formPayload;
  const ttlSeconds = 300;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

const result = await redisClient.set(matchedKey, JSON.stringify(matchedPayload), 'EX', ttlSeconds);
  if (!result) {
    throw { code: 'HOLD_EXPIRED', message: 'Hold expired during form submission' };
  }

  return {
    holdToken,
    formSubmitted: true,
    expiresAt: expiresAt.toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /bookings/:holdToken/confirm — commit the booking
// ─────────────────────────────────────────────────────────────────────────────

export async function confirmBooking(input: ConfirmBookingInput): Promise<BookingResponse> {
  const { holdToken, doctorId, dateIso, startTimeIso, symptomForm, patientUserId, patientProfileId } = input;

  // 1. Find and validate the hold
  const keys = await redisClient.keys('bh:*');
  let matchedKey: string | null = null;
  let matchedPayload: any = null;

  for (const key of keys) {
    const data = await redisClient.get(key);
    if (!data) continue;
    const parsed = JSON.parse(data);
    if (parsed.holdToken === holdToken) {
      matchedKey = key;
      matchedPayload = parsed;
      break;
    }
  }

  if (!matchedKey) {
    throw { code: 'HOLD_EXPIRED', message: 'Hold has expired' };
  }

  if (matchedPayload.patientUserId !== patientUserId) {
    throw { code: 'HOLD_BELONGS_TO_OTHER_PATIENT', message: 'Hold belongs to another patient' };
  }

  // Use form from hold or inline
  const form = matchedPayload.formPayload ?? symptomForm;
  if (!form || !form.primaryComplaint) {
    throw { code: 'SYMPTOM_FORM_REQUIRED', message: 'Symptom form is required' };
  }

  // 2. Parse times
  const bookingDate = new Date(dateIso);
  const startTime = parseStartTime(startTimeIso, dateIso);

  // 3. Insert Booking + SymptomForm in a single Prisma $transaction
  let booking: any;
  try {
    booking = await prisma.$transaction(async tx => {
      // 3a. Defense-in-depth: check if doctor is on leave for this date
      const leaveDay = await tx.leaveDay.findUnique({
        where: {
          doctorId_leaveDate: {
            doctorId,
            leaveDate: bookingDate,
          },
        },
      });
      if (leaveDay) {
        throw { code: 'DOCTOR_ON_LEAVE', message: 'Doctor is on leave for this date' };
      }

      // 3b. Insert Booking with nested SymptomForm (atomic)
      const createdBooking = await tx.booking.create({
        data: {
          patientId: patientProfileId,
          doctorId,
          bookingDate,
          startTime,
          status: 'CONFIRMED' as const,
          symptomForm: {
            create: {
              patientId: patientProfileId,
              primaryComplaint: form.primaryComplaint,
              durationDays: form.durationDays ?? null,
              severity: form.severity ?? null,
              description: form.description ?? null,
              currentMedications: form.currentMedications ?? [],
              allergies: form.allergies ?? [],
            },
          },
        },
        include: {
          symptomForm: true,
          patient: { include: { user: { select: { id: true, email: true } } } },
          doctor: { include: { user: { select: { id: true, email: true } } } },
        },
      });

      // 3c. Pre-create PreVisitSummary row in PENDING state so the async worker
      // can update it without P2025 (record-not-found) on first run.
      // Rule 4: this is part of the booking tx; the LLM call itself still runs async post-commit.
      if (createdBooking.symptomForm) {
        await tx.preVisitSummary.create({
          data: {
            bookingId: createdBooking.id,
            symptomFormId: createdBooking.symptomForm.id,
            summaryText: '',
            llmStatus: 'PENDING',
          },
        });
      }

      return createdBooking;
    });
  } catch (err: any) {
    // Check for Prisma unique constraint violation (P2002)
    if (err?.code === 'P2002' && err.meta?.target) {
      // Check if it's the bookings unique index
      const target = Array.isArray(err.meta.target) ? err.meta.target : [];
      if (target.includes('doctorId') && target.includes('bookingDate') && target.includes('startTime')) {
        throw {
          code: 'SLOT_ALREADY_BOOKED',
          message: 'This slot was booked by another patient before yours could complete',
          retryable: false,
        };
      }
    }
    if (err?.code === 'DOCTOR_ON_LEAVE') {
      throw err;
    }
    throw err;
  }

  // 4. Release hold (best-effort)
  try {
    await redisClient.del(matchedKey);
  } catch (err) {
    // Hold will auto-expire; booking is already committed
    console.warn('Failed to release hold:', matchedKey);
  }

  // 5. Fire async triggers (Rule 4: AFTER tx commit, never roll back)
  fireAsyncTriggers(booking);

  // 6. Return booking response
  return mapBookingToResponse(booking);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /bookings/:bookingId/cancel — cancel a booking
// ─────────────────────────────────────────────────────────────────────────────

export async function cancelBooking(
  bookingId: string,
  patientUserId: string,
  _reason?: string
): Promise<CancelBookingResult> {
// 1. Find booking and verify ownership
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      patient: { select: { user: { select: { id: true, email: true } } } },
      doctor: { select: { user: { select: { id: true, email: true } } } },
    },
  });

  if (!booking) {
    throw { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' };
  }

  // Ownership check: patient or doctor
  const isPatient = booking.patient.user.id === patientUserId;
  const isDoctor = booking.doctor.user.id === patientUserId;
  if (!isPatient && !isDoctor) {
    throw { code: 'NOT_OWNER', message: 'You do not own this booking' };
  }

  // 2. Check cancel cutoff (default 6 hours)
  const cutoffHours = parseInt(process.env.BOOKING_CANCEL_CUTOFF_HOURS || '6', 10);
  const now = new Date();
  const timeUntilStart = booking.startTime.getTime() - now.getTime();
  const hoursUntilStart = timeUntilStart / (1000 * 60 * 60);

  if (hoursUntilStart < cutoffHours) {
    throw {
      code: 'TOO_LATE_TO_CANCEL',
      message: `Cannot cancel within ${cutoffHours} hours of the appointment`,
    };
  }

  // 3. Update status to CANCELLED
  const updated = await prisma.booking.update({
    where: { id: bookingId },
    data: { status: 'CANCELLED' },
    include: {
      symptomForm: true,
      patient: { select: { fullName: true, user: { select: { id: true, email: true } } } },
      doctor: { select: { fullName: true, specialisation: true, user: { select: { id: true, email: true } } } },
    },
  });

  // 4. Fire async triggers (Rule 6/8: queue email + calendar delete)
  fireCancelAsyncTriggers(updated);

  return {
    booking: mapBookingToResponse(updated),
    message: 'Booking cancelled successfully',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /bookings/:bookingId/reschedule — move to a new slot
// ─────────────────────────────────────────────────────────────────────────────

export async function rescheduleBooking(
  bookingId: string,
  patientUserId: string,
  newHoldToken: string
): Promise<RescheduleBookingResult> {
  // 1. Find and validate old booking
  const oldBooking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      patient: { select: { fullName: true, user: { select: { id: true, email: true } } } },
      doctor: { select: { fullName: true, specialisation: true, user: { select: { id: true, email: true } } } },
    },
  });

  if (!oldBooking) {
    throw { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' };
  }

  const isPatient = oldBooking.patient.user.id === patientUserId;
  const isDoctor = oldBooking.doctor.user.id === patientUserId;
  if (!isPatient && !isDoctor) {
    throw { code: 'NOT_OWNER', message: 'You do not own this booking' };
  }

  // 2. Find and validate new hold
  const keys = await redisClient.keys('bh:*');
  let newHoldPayload: any = null;
  let newHoldKey: string | null = null;

  for (const key of keys) {
    const data = await redisClient.get(key);
    if (!data) continue;
    const parsed = JSON.parse(data);
    if (parsed.holdToken === newHoldToken) {
      newHoldKey = key;
      newHoldPayload = parsed;
      break;
    }
  }

  if (!newHoldPayload) {
    throw { code: 'NEW_HOLD_EXPIRED', message: 'New slot hold has expired' };
  }

  if (newHoldPayload.patientUserId !== patientUserId) {
    throw { code: 'NEW_HOLD_BELONGS_TO_OTHER_PATIENT', message: 'New hold belongs to another patient' };
  }

  // 3. Check new slot is not on leave
  const newDate = new Date(newHoldPayload.dateIso);
  const leaveDay = await prisma.leaveDay.findUnique({
    where: {
      doctorId_leaveDate: {
        doctorId: newHoldPayload.doctorId,
        leaveDate: newDate,
      },
    },
  });

  if (leaveDay) {
    throw { code: 'NEW_SLOT_ON_LEAVE', message: 'Doctor is on leave for the new date' };
  }

  // 4. Transaction: mark old as RESCHEDULED, create new booking
  const result = await prisma.$transaction(async tx => {
    // Update old booking
    await tx.booking.update({
      where: { id: bookingId },
      data: { status: 'RESCHEDULED' },
    });

    // Create new booking (with symptom form from old if it exists)
    const oldSymptomForm = await tx.symptomForm.findFirst({
      where: { bookingId },
    });

    const newBooking = await tx.booking.create({
      data: {
        patientId: oldBooking.patientId,
        doctorId: newHoldPayload.doctorId,
        bookingDate: newDate,
        startTime: parseStartTime(newHoldPayload.startTimeIso, newHoldPayload.dateIso),
        status: 'CONFIRMED' as const,
        ...(oldSymptomForm ? {
          symptomForm: {
            create: {
              patientId: oldBooking.patientId,
              primaryComplaint: oldSymptomForm.primaryComplaint,
              durationDays: oldSymptomForm.durationDays,
              severity: oldSymptomForm.severity,
              description: oldSymptomForm.description,
              currentMedications: oldSymptomForm.currentMedications || [],
              allergies: oldSymptomForm.allergies || [],
            },
          },
        } : {}),
      },
      include: {
        symptomForm: true,
        patient: { select: { fullName: true, user: { select: { id: true, email: true } } } },
        doctor: { select: { fullName: true, specialisation: true, user: { select: { id: true, email: true } } } },
      },
    });

    return newBooking;
  });

  // 5. Release new hold
  try {
    if (newHoldKey) await redisClient.del(newHoldKey);
  } catch (err) {
    console.warn('Failed to release new hold:', newHoldKey);
  }

  // 6. Fire async triggers
  fireRescheduleAsyncTriggers(oldBooking, result);

  return {
    oldBooking: mapBookingToResponse(oldBooking),
    newBooking: mapBookingToResponse(result),
    message: 'Booking rescheduled successfully',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Map booking to response shape
// ─────────────────────────────────────────────────────────────────────────────

function mapBookingToResponse(booking: any): BookingResponse {
  return {
    id: booking.id,
    patientId: booking.patientId,
    doctorId: booking.doctorId,
    bookingDate: booking.bookingDate.toISOString().split('T')[0],
    startTime: booking.startTime.toISOString(),
    status: booking.status,
    bookedAt: booking.bookedAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
    symptomForm: booking.symptomForm ? {
      id: booking.symptomForm.id,
      primaryComplaint: booking.symptomForm.primaryComplaint,
      durationDays: booking.symptomForm.durationDays,
      severity: booking.symptomForm.severity,
      description: booking.symptomForm.description,
      currentMedications: booking.symptomForm.currentMedications || [],
      allergies: booking.symptomForm.allergies || [],
      submittedAt: booking.symptomForm.submittedAt.toISOString(),
    } : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Async triggers — fire AFTER tx commit (Rule 4 compliance)
// ─────────────────────────────────────────────────────────────────────────────

function fireAsyncTriggers(booking: {
  id: string;
  patientId: string;
  doctorId: string;
  symptomForm: {
    id: string;
    primaryComplaint: string;
    durationDays: number | null;
    severity: string | null;
    description: string | null;
    currentMedications: string[];
    allergies: string[];
  } | null;
  patient: { fullName: string; user: { id: string; email: string } };
  doctor: { fullName: string; specialisation: string; user: { id: string; email: string } };
  bookingDate: Date;
  startTime: Date;
}): void {
  const cutoffHours = parseInt(process.env.BOOKING_CANCEL_CUTOFF_HOURS || '6', 10);

  // 1. LLM pre-visit summary job (Rule 4: after commit, never blocks booking)
  if (booking.symptomForm) {
    try {
      preVisitQueue.add('generate', {
        bookingId: booking.id,
        symptomFormId: booking.symptomForm.id,
      }).catch(err => console.error('[Async] Failed to queue pre-visit summary:', err));
    } catch (err) {
      console.error('[Async] Failed to queue pre-visit summary:', err);
    }
  }

  // 2. Email confirmation notifications (Rule 6: async, to both patient + doctor)
  try {
    const ctx = {
      bookingId: booking.id,
      patientName: booking.patient.fullName,
      patientEmail: booking.patient.user.email,
      patientUserId: booking.patient.user.id,
      doctorName: booking.doctor.fullName,
      doctorEmail: booking.doctor.user.email,
      doctorUserId: booking.doctor.user.id,
      doctorSpecialisation: booking.doctor.specialisation,
      date: booking.bookingDate.toISOString().split('T')[0],
      time: booking.startTime.toISOString(),
      cutoffHours,
      chiefComplaint: booking.symptomForm?.primaryComplaint ?? '',
      durationDays: booking.symptomForm?.durationDays ?? null,
      severity: booking.symptomForm?.severity ?? null,
      description: booking.symptomForm?.description ?? null,
      currentMedications: booking.symptomForm?.currentMedications ?? [],
      allergies: booking.symptomForm?.allergies ?? [],
    };
    enqueueBookingConfirmationNotifications(ctx).catch(err =>
      console.error('[Async] Failed to queue confirmation emails:', err)
    );
  } catch (err) {
    console.error('[Async] Failed to build email context:', err);
  }

  // 3. Calendar event creation (M6: async, non-blocking, per-party skip if unconnected)
  try {
    calendarSyncQueue.add('create', { bookingId: booking.id }).catch(err =>
      console.error('[Async] Failed to queue calendar create:', err)
    );
  } catch (err) {
    console.error('[Async] Failed to queue calendar create:', err);
  }
}

function fireCancelAsyncTriggers(booking: {
  id: string;
  patient: { fullName: string; user: { id: string; email: string } };
  doctor: { fullName: string; specialisation: string; user: { id: string; email: string } };
  bookingDate: Date;
  startTime: Date;
}): void {
  const cutoffHours = parseInt(process.env.BOOKING_CANCEL_CUTOFF_HOURS || '6', 10);

  // 1. Email cancel notifications (Rule 6: async, to both patient + doctor)
try {
     const ctx = {
       bookingId: booking.id,
       patientName: booking.patient.fullName,
       patientEmail: booking.patient.user.email,
       patientUserId: booking.patient.user.id,
       doctorName: booking.doctor.fullName,
       doctorEmail: booking.doctor.user.email,
       doctorUserId: booking.doctor.user.id,
       doctorSpecialisation: booking.doctor.specialisation,
       date: booking.bookingDate.toISOString().split('T')[0],
       time: booking.startTime.toISOString(),
cutoffHours,
        cancelledBy: 'PATIENT' as const, // placeholder - caller should pass actual initiator
        // reason omitted for optional property
      };
    enqueueBookingCancellationNotifications(ctx).catch(err =>
      console.error('[Async] Failed to queue cancellation emails:', err)
    );
  } catch (err) {
    console.error('[Async] Failed to queue email cancels:', err);
  }

  // 2. Calendar event deletion (M6: async, non-blocking, skip silently if no event)
  try {
    calendarSyncQueue.add('delete', { bookingId: booking.id }).catch(err =>
      console.error('[Async] Failed to queue calendar delete:', err)
    );
  } catch (err) {
    console.error('[Async] Failed to queue calendar delete:', err);
  }
}

function fireRescheduleAsyncTriggers(
  oldBooking: {
    id: string;
    patient: { fullName: string; user: { id: string; email: string } };
    doctor: { fullName: string; specialisation: string; user: { id: string; email: string } };
    bookingDate: Date;
    startTime: Date;
  },
  newBooking: {
    id: string;
    patient: { fullName: string; user: { id: string; email: string } };
    doctor: { fullName: string; specialisation: string; user: { id: string; email: string } };
    bookingDate: Date;
    startTime: Date;
    symptomForm?: {
      id?: string;
      bookingId?: string;
      patientId?: string;
      primaryComplaint: string;
      durationDays: number | null;
      severity: string | null;
      description: string | null;
      currentMedications: string[];
      allergies: string[];
      submittedAt?: Date;
    } | null;
  }
): void {
  const cutoffHours = parseInt(process.env.BOOKING_CANCEL_CUTOFF_HOURS || '6', 10);

  // 1. Cancel old (both parties)
  try {
    const cancelCtx = {
      bookingId: oldBooking.id,
      patientName: oldBooking.patient.fullName,
      patientEmail: oldBooking.patient.user.email,
      patientUserId: oldBooking.patient.user.id,
      doctorName: oldBooking.doctor.fullName,
      doctorEmail: oldBooking.doctor.user.email,
      doctorUserId: oldBooking.doctor.user.id,
      doctorSpecialisation: oldBooking.doctor.specialisation,
      date: oldBooking.bookingDate.toISOString().split('T')[0],
      time: oldBooking.startTime.toISOString(),
      cutoffHours,
      cancelledBy: 'PATIENT' as const,
      reason: 'Rescheduled to new time',
    };
    enqueueBookingCancellationNotifications(cancelCtx).catch(err =>
      console.error('[Async] Failed to queue old booking cancellation:', err)
    );
  } catch (err) {
    console.error('[Async] Failed to queue old booking cancellation:', err);
  }

  // 2. Confirm new (both parties)
  try {
    const confirmCtx = {
      bookingId: newBooking.id,
      patientName: newBooking.patient.fullName,
      patientEmail: newBooking.patient.user.email,
      patientUserId: newBooking.patient.user.id,
      doctorName: newBooking.doctor.fullName,
      doctorEmail: newBooking.doctor.user.email,
      doctorUserId: newBooking.doctor.user.id,
      doctorSpecialisation: newBooking.doctor.specialisation,
      date: newBooking.bookingDate.toISOString().split('T')[0],
      time: newBooking.startTime.toISOString(),
      cutoffHours,
      chiefComplaint: newBooking.symptomForm?.primaryComplaint ?? '',
      durationDays: newBooking.symptomForm?.durationDays ?? null,
      severity: newBooking.symptomForm?.severity ?? null,
      description: newBooking.symptomForm?.description ?? null,
      currentMedications: newBooking.symptomForm?.currentMedications ?? [],
      allergies: newBooking.symptomForm?.allergies ?? [],
    };
    enqueueBookingConfirmationNotifications(confirmCtx).catch(err =>
      console.error('[Async] Failed to queue new booking confirmation:', err)
    );
  } catch (err) {
    console.error('[Async] Failed to queue new booking confirmation:', err);
  }

  // 3. Calendar updates (M6: async, non-blocking — delete old, create new)
  try {
    calendarSyncQueue.add('delete', { bookingId: oldBooking.id }).catch(err =>
      console.error('[Async] Failed to queue calendar delete (old booking):', err)
    );
  } catch (err) {
    console.error('[Async] Failed to queue calendar delete (old booking):', err);
  }

  try {
    calendarSyncQueue.add('create', { bookingId: newBooking.id }).catch(err =>
      console.error('[Async] Failed to queue calendar create (new booking):', err)
    );
  } catch (err) {
    console.error('[Async] Failed to queue calendar create (new booking):', err);
  }
}