// backend/src/services/notification/notificationService.ts
// Notification service: email templates, queue helpers, and frequency parser

import { Role, NotificationType } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { emailQueue } from '../../workers/emailWorker';

// ─────────────────────────────────────────────────────────────────────────────
// Email templates (Rule 6: 6 templates — confirmation/reminder/cancel × patient/doctor)
// ─────────────────────────────────────────────────────────────────────────────

interface BookingContext {
  bookingId: string;
  patientName: string;
  patientEmail: string;
  patientUserId: string;   // Patient's User.id (UUID) — used as Notification.recipientUserId FK
  doctorName: string;
  doctorEmail: string;
  doctorUserId: string;    // Doctor's User.id (UUID) — used as Notification.recipientUserId FK
  doctorSpecialisation: string;
  date: string;        // YYYY-MM-DD
  time: string;        // HH:mm
  cutoffHours: number;
  chiefComplaint?: string;
  durationDays?: number | null;
  severity?: string | null;
  description?: string | null;
  currentMedications?: string[];
  allergies?: string[];
}

interface CancelContext extends BookingContext {
  cancelledBy: 'PATIENT' | 'DOCTOR' | 'ADMIN';
  reason?: string;
}

interface MedicationContext {
  patientName: string;
  patientEmail: string;
  patientUserId: string;   // Patient's User.id (UUID) — used as Notification.recipientUserId FK
  medicationName: string;
  dosage: string;
  instructions?: string | null;
  doseNumber?: number;
  totalDoses?: number;
}

function formatDateDisplay(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function formatTimeDisplay(timeStr: string): string {
  if (timeStr.includes('T')) {
    const d = new Date(timeStr);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  }
  const [h, m] = timeStr.split(':').map(Number);
  const date = new Date();
  date.setHours(h, m);
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// ─── Patient: Booking Confirmation ───
export function buildPatientConfirmationEmail(ctx: BookingContext): { subject: string; body: string } {
  const subject = `Your appointment is confirmed — ${ctx.doctorName} on ${formatDateDisplay(ctx.date)} at ${formatTimeDisplay(ctx.time)}`;
  const body = `
Dear ${ctx.patientName},

Your appointment has been confirmed.

Appointment Details:
- Doctor: ${ctx.doctorName} (${ctx.doctorSpecialisation})
- Date: ${formatDateDisplay(ctx.date)}
- Time: ${formatTimeDisplay(ctx.time)}
- Booking ID: ${ctx.bookingId.slice(0, 8)}

${ctx.chiefComplaint ? `Reason for visit: ${ctx.chiefComplaint}\n` : ''}

Cancellation Policy:
You may cancel up to ${ctx.cutoffHours} hours before the appointment via the patient portal.

If you need to reschedule or have questions, please contact the clinic.

Best regards,
Healthcare Team

---
This is an automated message. Please do not reply.
  `.trim();
  return { subject, body };
}

// ─── Doctor: Booking Confirmation ───
export function buildDoctorConfirmationEmail(ctx: BookingContext): { subject: string; body: string } {
  const subject = `New appointment booked — ${ctx.patientName} on ${formatDateDisplay(ctx.date)} at ${formatTimeDisplay(ctx.time)}`;
  const body = `
Dear Dr. ${ctx.doctorName.split(' ').pop() || ctx.doctorName},

A new appointment has been booked for you.

Patient: ${ctx.patientName}
Date: ${formatDateDisplay(ctx.date)}
Time: ${formatTimeDisplay(ctx.time)}
Booking ID: ${ctx.bookingId.slice(0, 8)}

${ctx.chiefComplaint ? `Chief Complaint: ${ctx.chiefComplaint}\n` : ''}${ctx.durationDays !== null && ctx.durationDays !== undefined ? `Duration: ${ctx.durationDays} day(s)\n` : ''}${ctx.severity ? `Severity: ${ctx.severity}\n` : ''}${ctx.description ? `Description: ${ctx.description}\n` : ''}${ctx.currentMedications && ctx.currentMedications.length > 0 ? `Current Medications: ${ctx.currentMedications.join(', ')}\n` : ''}${ctx.allergies && ctx.allergies.length > 0 ? `Allergies: ${ctx.allergies.join(', ')}\n` : ''}

A pre-visit summary will be available in the doctor portal shortly.

Best regards,
Healthcare Team

---
This is an automated message. Please do not reply.
  `.trim();
  return { subject, body };
}

// ─── Patient: Booking Reminder (24h) ───
export function buildPatientReminderEmail(ctx: BookingContext): { subject: string; body: string } {
  const subject = `Reminder: Appointment with ${ctx.doctorName} tomorrow at ${formatTimeDisplay(ctx.time)}`;
  const body = `
Dear ${ctx.patientName},

This is a reminder that you have an appointment in approximately 24 hours.

Appointment Details:
- Doctor: ${ctx.doctorName} (${ctx.doctorSpecialisation})
- Date: ${formatDateDisplay(ctx.date)}
- Time: ${formatTimeDisplay(ctx.time)}
- Booking ID: ${ctx.bookingId.slice(0, 8)}

If you need to cancel or reschedule, please do so at least ${ctx.cutoffHours} hours before the appointment via the patient portal.

We look forward to seeing you.

Best regards,
Healthcare Team

---
This is an automated message. Please do not reply.
  `.trim();
  return { subject, body };
}

// ─── Doctor: Booking Reminder (24h) ───
export function buildDoctorReminderEmail(ctx: BookingContext): { subject: string; body: string } {
  const subject = `Reminder: Appointment with ${ctx.patientName} tomorrow at ${formatTimeDisplay(ctx.time)}`;
  const body = `
Dear Dr. ${ctx.doctorName.split(' ').pop() || ctx.doctorName},

Reminder: You have an appointment in approximately 24 hours.

Patient: ${ctx.patientName}
Date: ${formatDateDisplay(ctx.date)}
Time: ${formatTimeDisplay(ctx.time)}
Booking ID: ${ctx.bookingId.slice(0, 8)}

${ctx.chiefComplaint ? `Chief Complaint: ${ctx.chiefComplaint}\n` : ''}

View full details and pre-visit summary in the doctor portal.

Best regards,
Healthcare Team

---
This is an automated message. Please do not reply.
  `.trim();
  return { subject, body };
}

// ─── Patient: Booking Cancellation ───
export function buildPatientCancellationEmail(ctx: CancelContext): { subject: string; body: string } {
  const initiator = ctx.cancelledBy === 'PATIENT' ? 'you' : ctx.cancelledBy === 'DOCTOR' ? 'the doctor' : 'the clinic (doctor on leave)';
  const subject = `Your appointment on ${formatDateDisplay(ctx.date)} has been cancelled`;
  const body = `
Dear ${ctx.patientName},

Your appointment has been cancelled.

Appointment Details:
- Doctor: ${ctx.doctorName} (${ctx.doctorSpecialisation})
- Date: ${formatDateDisplay(ctx.date)}
- Time: ${formatTimeDisplay(ctx.time)}
- Booking ID: ${ctx.bookingId.slice(0, 8)}

Cancelled by: ${initiator}${ctx.reason ? `\nReason: ${ctx.reason}` : ''}

The slot is now available for rebooking. You can schedule a new appointment at your convenience via the patient portal.

Best regards,
Healthcare Team

---
This is an automated message. Please do not reply.
  `.trim();
  return { subject, body };
}

// ─── Doctor: Booking Cancellation ───
export function buildDoctorCancellationEmail(ctx: CancelContext): { subject: string; body: string } {
  const initiator = ctx.cancelledBy === 'PATIENT' ? 'the patient' : ctx.cancelledBy === 'DOCTOR' ? 'you' : 'the clinic (leave)';
  const subject = `Appointment cancelled — ${ctx.patientName} on ${formatDateDisplay(ctx.date)}`;
  const body = `
Dear Dr. ${ctx.doctorName.split(' ').pop() || ctx.doctorName},

An appointment has been cancelled.

Patient: ${ctx.patientName}
Date: ${formatDateDisplay(ctx.date)}
Time: ${formatTimeDisplay(ctx.time)}
Booking ID: ${ctx.bookingId.slice(0, 8)}

Cancelled by: ${initiator}${ctx.reason ? `\nReason: ${ctx.reason}` : ''}

The slot is now available for other patients.

Best regards,
Healthcare Team

---
This is an automated message. Please do not reply.
  `.trim();
  return { subject, body };
}

// ─── Patient: Medication Reminder ───
export function buildMedicationReminderEmail(ctx: MedicationContext): { subject: string; body: string } {
  const subject = `Reminder: Take ${ctx.medicationName} (${ctx.dosage}) now`;
  const progress = ctx.doseNumber && ctx.totalDoses ? `\nThis is dose ${ctx.doseNumber} of ${ctx.totalDoses} in your current course.\n` : '';
  const body = `
Dear ${ctx.patientName},

It's time to take your medication.

Medication: ${ctx.medicationName}
Dosage: ${ctx.dosage}${progress}${ctx.instructions ? `\nInstructions: ${ctx.instructions}\n` : ''}

If you experience any side effects, please contact your doctor.

Best regards,
Healthcare Team

---
This is an automated message. Please do not reply.
  `.trim();
  return { subject, body };
}

// ─────────────────────────────────────────────────────────────────────────────
// Queue helpers
// ─────────────────────────────────────────────────────────────────────────────

// Payload carried into the BullMQ email job. Worker uses recipientUserId (UUID),
// bookingId, and type to locate the notifications row, and falls back to
// recipientEmail if the DB lookup somehow returns null.
export interface EmailJobPayload {
  notificationId: string;
  recipientUserId: string;  // User.id (UUID)
  recipientEmail: string;   // For fallback only; primary address fetched via User FK in worker
  bookingId: string | null;
  type: NotificationType;
}

export async function enqueueNotificationEmail(
  notificationId: string,
  recipientUserId: string,
  recipientEmail: string,
  bookingId: string | null,
  type: NotificationType
): Promise<void> {
  const payload: EmailJobPayload = { notificationId, recipientUserId, recipientEmail, bookingId, type };
  try {
    await emailQueue.add('send-email', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 200,
      removeOnFail: false,
    });
  } catch (err) {
    console.error('[Notification] Failed to enqueue email:', err);
    await prisma.notification.update({
      where: { id: notificationId },
      data: { status: 'FAILED', lastError: 'Queue dispatch failed' },
    }).catch(() => {});
  }
}

export async function createAndEnqueueNotification(
  type: NotificationType,
  recipientUserId: string,   // User.id (UUID) — stored as FK on notifications.recipient_user_id
  recipientEmail: string,     // Carried in BullMQ payload as fallback for worker
  recipientRole: Role,
  bookingId: string | null,
  subject: string,
  body: string,
  scheduledFor: Date = new Date()
): Promise<string> {
  const notification = await prisma.notification.create({
    data: {
      notificationType: type,
      recipientUserId,          // UUID — satisfies FK to users.id (was previously email → P2003)
      recipientRole,
      bookingId,
      subject,
      body,
      status: 'QUEUED',
      scheduledFor,
    },
  });

  enqueueNotificationEmail(notification.id, recipientUserId, recipientEmail, bookingId, type).catch(console.error);
  return notification.id;
}

// ─── Booking Confirmation Notifications (patient + doctor) ───
export async function enqueueBookingConfirmationNotifications(ctx: BookingContext): Promise<void> {
  const now = new Date();
  const patientEmailData = buildPatientConfirmationEmail(ctx);
  const doctorEmailData = buildDoctorConfirmationEmail(ctx);

  await createAndEnqueueNotification(
    'BOOKING_CONFIRMATION',
    ctx.patientUserId,        // UUID — Patient's User.id
    ctx.patientEmail,         // Email — BullMQ payload fallback
    'PATIENT',
    ctx.bookingId,
    patientEmailData.subject,
    patientEmailData.body,
    now
  );
  await createAndEnqueueNotification(
    'BOOKING_CONFIRMATION',
    ctx.doctorUserId,         // UUID — Doctor's User.id
    ctx.doctorEmail,          // Email — BullMQ payload fallback
    'DOCTOR',
    ctx.bookingId,
    doctorEmailData.subject,
    doctorEmailData.body,
    now
  );
}

// ─── Booking Cancellation Notifications (patient + doctor) ───
export async function enqueueBookingCancellationNotifications(ctx: CancelContext): Promise<void> {
  const now = new Date();
  const patientEmailData = buildPatientCancellationEmail(ctx);
  const doctorEmailData = buildDoctorCancellationEmail(ctx);

  await createAndEnqueueNotification(
    'BOOKING_CANCELLATION',
    ctx.patientUserId,
    ctx.patientEmail,
    'PATIENT',
    ctx.bookingId,
    patientEmailData.subject,
    patientEmailData.body,
    now
  );
  await createAndEnqueueNotification(
    'BOOKING_CANCELLATION',
    ctx.doctorUserId,
    ctx.doctorEmail,
    'DOCTOR',
    ctx.bookingId,
    doctorEmailData.subject,
    doctorEmailData.body,
    now
  );
}

// ─── Booking Reschedule Notifications ───
export async function enqueueBookingRescheduleNotifications(
  oldCtx: BookingContext,
  newCtx: BookingContext
): Promise<void> {
  await enqueueBookingCancellationNotifications({
    ...oldCtx,
    cancelledBy: 'PATIENT',
    reason: 'Rescheduled to new time',
  });
  await enqueueBookingConfirmationNotifications(newCtx);
}

// ─── Booking Reminder Notifications (24h before) ───
export async function enqueueBookingReminderNotifications(ctx: BookingContext): Promise<void> {
  const now = new Date();
  const patientEmailData = buildPatientReminderEmail(ctx);
  const doctorEmailData = buildDoctorReminderEmail(ctx);

  await createAndEnqueueNotification(
    'BOOKING_REMINDER',
    ctx.patientUserId,
    ctx.patientEmail,
    'PATIENT',
    ctx.bookingId,
    patientEmailData.subject,
    patientEmailData.body,
    now
  );
  await createAndEnqueueNotification(
    'BOOKING_REMINDER',
    ctx.doctorUserId,
    ctx.doctorEmail,
    'DOCTOR',
    ctx.bookingId,
    doctorEmailData.subject,
    doctorEmailData.body,
    now
  );
}

// ─── Medication Reminder Notification ───
export async function enqueueMedicationReminderNotification(ctx: MedicationContext): Promise<void> {
  const now = new Date();
  const emailData = buildMedicationReminderEmail(ctx);

  await createAndEnqueueNotification(
    'MEDICATION_REMINDER',
    ctx.patientUserId,
    ctx.patientEmail,
    'PATIENT',
    null,
    emailData.subject,
    emailData.body,
    now
  );
}