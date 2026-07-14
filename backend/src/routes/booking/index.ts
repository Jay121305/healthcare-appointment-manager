// backend/src/routes/booking/index.ts
// Booking routes: slots, holds, symptom-form, confirm, cancel, reschedule

import { Router, Request, Response } from 'express';
import { authenticate, requireRoles } from '../../middleware/auth';
import {
  placeHold,
  attachFormToHold,
  confirmBooking,
  cancelBooking,
  rescheduleBooking,
  PlaceHoldInput,
  SymptomFormInput,
  ConfirmBookingInput,
} from '../../services/booking/bookingService';
import { getAvailableSlots } from '../../services/slotService';

const router = Router();

// All booking routes require authentication
router.use(authenticate);

// ─────────────────────────────────────────────────────────────────────────────
// GET /bookings/slots — list available slots for a doctor/date
// ─────────────────────────────────────────────────────────────────────────────

router.get('/slots', async (req: Request, res: Response): Promise<void> => {
  try {
    const doctorId = req.query.doctorId as string;
    const date = req.query.date as string;

    if (!doctorId || !date) {
      res.status(400).json({ error: 'DOCTOR_ID_AND_DATE_REQUIRED' });
      return;
    }

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      res.status(400).json({ error: 'INVALID_DATE_FORMAT' });
      return;
    }

    const result = await getAvailableSlots(doctorId, date);

    res.status(200).json(result);
  } catch (err) {
    console.error('Get slots error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /bookings/holds — place a slot hold
// ─────────────────────────────────────────────────────────────────────────────

router.post('/holds', requireRoles('PATIENT'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { doctorId, date, startTime, ttlSeconds } = req.body;

    if (!doctorId || !date || !startTime) {
      res.status(400).json({ error: 'DOCTOR_ID_DATE_AND_START_TIME_REQUIRED' });
      return;
    }

    const input: PlaceHoldInput = {
      doctorId,
      dateIso: date,
      startTimeIso: startTime,
      patientUserId: req.user.id,
      patientProfileId: '', // Will be resolved from user
      ttlSeconds,
    };

    // Resolve patient profile ID
    const patientProfile = await prisma.patientProfile.findUnique({
      where: { userId: req.user.id },
    });

    if (!patientProfile) {
      res.status(404).json({ error: 'PATIENT_PROFILE_NOT_FOUND' });
      return;
    }

    input.patientProfileId = patientProfile.id;

    const result = await placeHold(input);

    res.status(201).json(result);
  } catch (err: any) {
    if (err?.code === 'SLOT_HELD') {
      res.status(409).json({
        error: 'SLOT_HELD',
        message: err.message,
        retryAfterSeconds: err.retryAfterSeconds,
      });
      return;
    }
    if (err?.code === 'SLOT_UNAVAILABLE') {
      res.status(409).json({ error: 'SLOT_UNAVAILABLE', message: err.message });
      return;
    }
    if (err?.code === 'DOCTOR_NOT_FOUND') {
      res.status(404).json({ error: 'DOCTOR_NOT_FOUND' });
      return;
    }
    console.error('Place hold error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /bookings/:holdToken/symptom-form — attach symptom form to hold
// ─────────────────────────────────────────────────────────────────────────────

router.post('/:holdToken/symptom-form', requireRoles('PATIENT'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { holdToken } = req.params;
    const formPayload: SymptomFormInput = req.body;

    if (!formPayload || !formPayload.primaryComplaint) {
      res.status(400).json({ error: 'SYMPTOM_FORM_INVALID', fields: { primaryComplaint: 'Required' } });
      return;
    }

    const result = await attachFormToHold(holdToken, formPayload, req.user.id);

    res.status(200).json(result);
  } catch (err: any) {
    if (err?.code === 'HOLD_EXPIRED') {
      res.status(410).json({ error: 'HOLD_EXPIRED', message: err.message });
      return;
    }
    if (err?.code === 'HOLD_BELONGS_TO_OTHER_PATIENT') {
      res.status(403).json({ error: 'HOLD_BELONGS_TO_OTHER_PATIENT', message: err.message });
      return;
    }
    console.error('Attach form error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /bookings/:holdToken/confirm — commit the booking
// ─────────────────────────────────────────────────────────────────────────────

router.post('/:holdToken/confirm', requireRoles('PATIENT'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { holdToken } = req.params;
    const { symptomForm } = req.body;

    // Resolve patient profile
    const patientProfile = await prisma.patientProfile.findUnique({
      where: { userId: req.user.id },
    });

    if (!patientProfile) {
      res.status(404).json({ error: 'PATIENT_PROFILE_NOT_FOUND' });
      return;
    }

    // We need doctorId, date, startTime from the hold payload
    // First, find the hold to extract these
    const keys = await redisClient.keys('bh:*');
    let matchedPayload: any = null;

    for (const key of keys) {
      const data = await redisClient.get(key);
      if (!data) continue;
      const parsed = JSON.parse(data);
      if (parsed.holdToken === holdToken) {
        matchedPayload = parsed;
        break;
      }
    }

    if (!matchedPayload) {
      res.status(410).json({ error: 'HOLD_EXPIRED', message: 'Hold has expired' });
      return;
    }

    const input: ConfirmBookingInput = {
      holdToken,
      doctorId: matchedPayload.doctorId,
      dateIso: matchedPayload.dateIso,
      startTimeIso: matchedPayload.startTimeIso,
      symptomForm: symptomForm || matchedPayload.formPayload,
      patientUserId: req.user.id,
      patientProfileId: patientProfile.id,
    };

    const result = await confirmBooking(input);

    res.status(201).json(result);
  } catch (err: any) {
    if (err?.code === 'HOLD_EXPIRED') {
      res.status(410).json({ error: 'HOLD_EXPIRED', message: err.message });
      return;
    }
    if (err?.code === 'HOLD_BELONGS_TO_OTHER_PATIENT') {
      res.status(403).json({ error: 'HOLD_BELONGS_TO_OTHER_PATIENT', message: err.message });
      return;
    }
    if (err?.code === 'SYMPTOM_FORM_REQUIRED') {
      res.status(400).json({ error: 'SYMPTOM_FORM_REQUIRED', message: err.message });
      return;
    }
    if (err?.code === 'SLOT_ALREADY_BOOKED') {
      res.status(409).json({ error: 'SLOT_ALREADY_BOOKED', message: err.message, retryable: false });
      return;
    }
    if (err?.code === 'DOCTOR_ON_LEAVE') {
      res.status(409).json({ error: 'DOCTOR_ON_LEAVE', message: err.message });
      return;
    }
    console.error('Confirm booking error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /bookings/:bookingId/cancel — cancel a booking
// ─────────────────────────────────────────────────────────────────────────────

router.post('/:bookingId/cancel', requireRoles('PATIENT', 'DOCTOR', 'ADMIN'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params;
    const { reason } = req.body;

    const result = await cancelBooking(bookingId, req.user.id, reason);

    res.status(200).json(result);
  } catch (err: any) {
    if (err?.code === 'BOOKING_NOT_FOUND') {
      res.status(404).json({ error: 'BOOKING_NOT_FOUND' });
      return;
    }
    if (err?.code === 'NOT_OWNER') {
      res.status(403).json({ error: 'NOT_OWNER' });
      return;
    }
    if (err?.code === 'TOO_LATE_TO_CANCEL') {
      res.status(409).json({ error: 'TOO_LATE_TO_CANCEL', message: err.message });
      return;
    }
    console.error('Cancel booking error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /bookings/:bookingId/reschedule — reschedule a booking
// ─────────────────────────────────────────────────────────────────────────────

router.post('/:bookingId/reschedule', requireRoles('PATIENT', 'DOCTOR', 'ADMIN'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params;
    const { newHoldToken } = req.body;

    if (!newHoldToken) {
      res.status(400).json({ error: 'NEW_HOLD_TOKEN_REQUIRED' });
      return;
    }

    const result = await rescheduleBooking(bookingId, req.user.id, newHoldToken);

    res.status(200).json(result);
  } catch (err: any) {
    if (err?.code === 'BOOKING_NOT_FOUND') {
      res.status(404).json({ error: 'BOOKING_NOT_FOUND' });
      return;
    }
    if (err?.code === 'NOT_OWNER') {
      res.status(403).json({ error: 'NOT_OWNER' });
      return;
    }
    if (err?.code === 'NEW_HOLD_EXPIRED') {
      res.status(410).json({ error: 'NEW_HOLD_EXPIRED', message: err.message });
      return;
    }
    if (err?.code === 'NEW_HOLD_BELONGS_TO_OTHER_PATIENT') {
      res.status(403).json({ error: 'NEW_HOLD_BELONGS_TO_OTHER_PATIENT' });
      return;
    }
    if (err?.code === 'NEW_SLOT_ON_LEAVE') {
      res.status(409).json({ error: 'NEW_SLOT_ON_LEAVE', message: err.message });
      return;
    }
    console.error('Reschedule booking error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Import prisma and redis here to avoid circular dependencies
import { prisma } from '../../config/prisma';
import { redisClient } from '../../config/redis';

export default router;