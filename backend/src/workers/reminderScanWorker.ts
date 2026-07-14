// backend/src/workers/reminderScanWorker.ts
// BullMQ worker/cron for booking reminders (24h before appointment)

import { Worker, Queue } from 'bullmq';
import { getRedisConnection } from '../config/redis';
import { prisma } from '../config/prisma';
import { enqueueBookingReminderNotifications } from '../services/notification/notificationService';

export const REMINDER_SCAN_QUEUE_NAME = 'reminder-scan';

export const reminderScanQueue = new Queue(REMINDER_SCAN_QUEUE_NAME, {
  connection: getRedisConnection(),
  defaultJobOptions: {
    removeOnComplete: 500,
    removeOnFail: false,
  },
});

const worker = new Worker(
  REMINDER_SCAN_QUEUE_NAME,
  async () => {
    const now = new Date();
    const windowStart = new Date(now.getTime() + 23 * 60 * 60 * 1000); // 23h from now
    const windowEnd = new Date(now.getTime() + 25 * 60 * 60 * 1000);   // 25h from now (2h window)

    // Find confirmed bookings starting in the next 23-25h window
    const bookings = await prisma.booking.findMany({
      where: {
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
        startTime: { gte: windowStart, lte: windowEnd },
      },
      include: {
        patient: { select: { fullName: true, user: { select: { id: true, email: true } } } },
        doctor: { select: { fullName: true, specialisation: true, user: { select: { id: true, email: true } } } },
        symptomForm: true,
      },
    });

    let processed = 0;
    for (const booking of bookings) {
      // Idempotency: check if BOOKING_REMINDER already exists for this booking+recipient
      const existing = await prisma.notification.findFirst({
        where: {
          bookingId: booking.id,
          notificationType: 'BOOKING_REMINDER',
          recipientRole: 'PATIENT',
        },
      });
      if (existing) continue; // already queued

      await enqueueBookingReminderNotifications({
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
        cutoffHours: parseInt(process.env.BOOKING_CANCEL_CUTOFF_HOURS || '6', 10),
        chiefComplaint: booking.symptomForm?.primaryComplaint ?? '',
        durationDays: booking.symptomForm?.durationDays ?? null,
        severity: booking.symptomForm?.severity ?? null,
        description: booking.symptomForm?.description ?? null,
        currentMedications: booking.symptomForm?.currentMedications ?? [],
        allergies: booking.symptomForm?.allergies ?? [],
      });

      processed++;
    }

    return { processed };
  },
  {
    connection: getRedisConnection(),
    concurrency: 1,
    stalledInterval: 300_000,
    maxStalledCount: 1,
  }
);

worker.on('completed', (job) => {
  console.log(`[ReminderScan] Job ${job.id} completed: processed ${job.returnvalue?.processed ?? 0} bookings`);
});

worker.on('failed', (job, err) => {
  console.error(`[ReminderScan] Job ${job?.id} failed:`, err?.message);
});

worker.on('error', (err) => {
  console.error('[ReminderScan] Worker error:', err);
});

// Register as repeatable job (hourly) — Rule 7 + M5 cron
// BullMQ requires the repeat registration to be re-asserted at module load.
// On the first boot after a process restart this re-creates the schedule.
reminderScanQueue.add('scan', {}, {
  repeat: { every: 60 * 60 * 1000 },
  removeOnComplete: 500,
  removeOnFail: false,
});

process.on('SIGINT', async () => {
  await worker.close();
  await reminderScanQueue.close();
  process.exit(0);
});

export { worker as reminderScanWorker };