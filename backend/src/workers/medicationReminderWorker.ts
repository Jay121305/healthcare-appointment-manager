// backend/src/workers/medicationReminderWorker.ts
// BullMQ worker for medication reminders (Rule 7): fires at remindAt, creates Notification + enqueues email

import { Worker, Queue } from 'bullmq';
import { getRedisConnection } from '../config/redis';
import { prisma } from '../config/prisma';
import { ReminderStatus } from '@prisma/client';
import { enqueueMedicationReminderNotification } from '../services/notification/notificationService';

export const MEDICATION_REMINDER_QUEUE_NAME = 'medication-reminder';

export const medicationReminderQueue = new Queue(MEDICATION_REMINDER_QUEUE_NAME, {
  connection: getRedisConnection(),
  defaultJobOptions: {
    removeOnComplete: 500,
    removeOnFail: false,
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
  },
});

const worker = new Worker(
  MEDICATION_REMINDER_QUEUE_NAME,
  async (job) => {
    const { prescriptionId, patientId, medicationName, dosage, instructions, doseNumber, totalDoses } = job.data as {
      prescriptionId: string;
      patientId: string;
      medicationName: string;
      dosage: string;
      instructions?: string | null;
      doseNumber: number;
      totalDoses: number;
    };

    // Find the reminder by prescriptionId + remindAt (approximate match since we don't have exact ID)
    const reminder = await prisma.medicationReminder.findFirst({
      where: {
        prescriptionId,
        patientId,
        remindAt: {
          gte: new Date(job.timestamp),
          lte: new Date(job.timestamp + 60_000), // within 1 minute
        },
        status: ReminderStatus.PENDING,
      },
    });

    if (!reminder) {
      console.warn(`[MedReminder] No pending reminder found for prescription ${prescriptionId} at ${job.timestamp}`);
      return { skipped: true };
    }

    // Optimistic lock
    const updated = await prisma.medicationReminder.update({
      where: { id: reminder.id, status: ReminderStatus.PENDING },
      data: { status: ReminderStatus.SENT, sentAt: new Date() },
    }).catch(() => null);

    if (!updated) {
      return { skipped: true, reason: 'Already processed' };
    }

    // Get patient email + user.id
    const patient = await prisma.patientProfile.findUnique({
      where: { id: patientId },
      select: { fullName: true, user: { select: { id: true, email: true } } },
    });

    if (!patient?.user?.email) {
      await prisma.medicationReminder.update({
        where: { id: reminder.id },
        data: { status: ReminderStatus.FAILED },
      });
      throw new Error('Patient email not found');
    }

    // Enqueue medication reminder email
    await enqueueMedicationReminderNotification({
      patientName: patient.fullName,
      patientEmail: patient.user.email,
      patientUserId: patient.user.id,
      medicationName,
      dosage,
      instructions: instructions ?? null,
      doseNumber,
      totalDoses,
    });

    return { sent: true, reminderId: reminder.id };
  },
  {
    connection: getRedisConnection(),
    concurrency: 5,
    stalledInterval: 300_000,
    maxStalledCount: 1,
    lockDuration: 60_000,
  }
);

worker.on('completed', (job) => {
  console.log(`[MedReminderWorker] Job ${job.id} completed for prescription ${job.data.prescriptionId}`);
});

worker.on('failed', (job, err) => {
  console.error(`[MedReminderWorker] Job ${job?.id} failed:`, err?.message);
});

worker.on('error', (err) => {
  console.error('[MedReminderWorker] Worker error:', err);
});

process.on('SIGINT', async () => {
  await worker.close();
  await medicationReminderQueue.close();
  process.exit(0);
});

export { worker as medicationReminderWorker };