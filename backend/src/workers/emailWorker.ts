// backend/src/workers/emailWorker.ts
// BullMQ worker for sending notification emails via Resend (Rule 6)

import { Worker, Queue } from 'bullmq';
import { Resend } from 'resend';
import { getRedisConnection } from '../config/redis';
import { prisma } from '../config/prisma';
import { NotificationStatus } from '@prisma/client';
import type { EmailJobPayload } from '../services/notification/notificationService';

export const EMAIL_QUEUE_NAME = 'email-notification';

export const emailQueue = new Queue(EMAIL_QUEUE_NAME, {
  connection: getRedisConnection(),
  defaultJobOptions: {
    removeOnComplete: 200,
    removeOnFail: false, // keep dead letters for Rule 6 visible failure
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
  },
});

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.EMAIL_FROM_ADDRESS || 'noreply@healthcare.local';
// Rule 6: daily send cap (Resend free tier = 100/day). Configurable via
// EMAIL_DAILY_CAP env var (defaults to 100); tests set this high to avoid
// exhausting the cap and masking the genuine Resend API failure path.
const DAILY_CAP = parseInt(process.env.EMAIL_DAILY_CAP || '100', 10);

const dailyCapKey = (date: string) => `email:daily_cap:${date}`;

async function checkAndIncrementDailyCap(): Promise<boolean> {
  const today = new Date().toISOString().split('T')[0];
  const key = dailyCapKey(today);
  const redis = await import('ioredis').then(m => new m.default(process.env.UPSTASH_REDIS_TLS_URL!));
  const current = await redis.incr(key);
  if (current === 1) {
    // Expire at midnight UTC
    const msToMidnight = 24 * 60 * 60 * 1000 - (Date.now() % (24 * 60 * 60 * 1000));
    await redis.pexpire(key, msToMidnight);
  }
  await redis.quit();
  return current <= DAILY_CAP;
}

const worker = new Worker(
  EMAIL_QUEUE_NAME,
  async (job) => {
    const payload = job.data as EmailJobPayload;

    // Check daily cap first
    const canSend = await checkAndIncrementDailyCap();
    if (!canSend) {
      const msToMidnight = 24 * 60 * 60 * 1000 - (Date.now() % (24 * 60 * 60 * 1000));
      throw new Error(`DAILY_CAP_EXCEEDED:${msToMidnight}`);
    }

    // PRIMARY: Look up notification by its primary key (notificationId).
    // SECONDARY: Fall back to {recipientUserId + bookingId + type} lookup if primary fails.
    // Include recipientUser to fetch the email via the FK relation.
    let notification = await prisma.notification.findUnique({
      where: { id: payload.notificationId },
      include: { recipientUser: { select: { email: true } } },
    });

    if (!notification) {
      // Fallback: find by recipientUserId (UUID) + bookingId + type
      notification = await prisma.notification.findFirst({
        where: {
          recipientUserId: payload.recipientUserId,
          bookingId: payload.bookingId,
          notificationType: payload.type,
          status: { in: [NotificationStatus.QUEUED, NotificationStatus.RETRYING] },
        },
        include: { recipientUser: { select: { email: true } } },
      });
    }

    if (!notification) {
      return { skipped: true, reason: 'Notification not found by id or (userId+booking+type)' };
    }

    // Optimistic lock: only process if QUEUED (or RETRYING on retries)
    const locked = await prisma.notification.update({
      where: {
        id: notification.id,
        status: { in: [NotificationStatus.QUEUED, NotificationStatus.RETRYING] },
      },
      data: {
        status: NotificationStatus.SENDING,
        bullmqJobId: job.id ?? null,
        attemptCount: { increment: 1 },
      },
    }).catch(() => null);

    if (!locked) {
      return { skipped: true, reason: 'Already processing or not QUEUED/RETRYING' };
    }

    // Fetch the email from the User FK relation
    const toEmail: string = notification.recipientUser?.email ?? payload.recipientEmail;
    if (!toEmail) {
      await prisma.notification.update({
        where: { id: notification.id },
        data: { status: NotificationStatus.FAILED, lastError: 'No recipient email found' },
      });
      return { dead: true, error: 'No recipient email found' };
    }

    try {
      const result = await resend.emails.send({
        from: FROM_EMAIL,
        to: toEmail,
        subject: notification.subject,
        text: notification.body,
      });

      if (result.error) {
        throw new Error(`Resend error: ${result.error.message}`);
      }

      await prisma.notification.update({
        where: { id: notification.id },
        data: {
          status: NotificationStatus.SENT,
          sentAt: new Date(),
        },
      });

      return { sent: true, notificationId: notification.id, resendId: result.data?.id };
    } catch (err: any) {
      // Permanent errors (4xx) -> DEAD immediately, no retry
      const isPermanent = err?.statusCode >= 400 && err?.statusCode < 500;
      const newStatus = isPermanent ? NotificationStatus.DEAD : NotificationStatus.RETRYING;

      await prisma.notification.update({
        where: { id: notification.id },
        data: {
          status: newStatus,
          lastError: err?.message || String(err),
          ...(isPermanent ? { failedAt: new Date() } : {}),
        },
      });

      if (isPermanent) {
        return { dead: true, error: err?.message };
      }
      // Non-permanent: re-throw to trigger BullMQ retry
      throw err;
    }
  },
  {
    connection: getRedisConnection(),
    concurrency: 3,
    stalledInterval: 300_000,
    maxStalledCount: 1,
    lockDuration: 60_000,
  }
);

worker.on('completed', (job) => {
  console.log(`[EmailWorker] Job ${job.id} completed for notification ${(job.data as EmailJobPayload).notificationId}`);
});

// Rule 6: on final retry exhaustion, transition notification to DEAD (visible failure state)
worker.on('failed', async (job, err) => {
  if (!job) return;
  const isExhausted =
    job.attemptsMade >= ((job.opts.attempts ?? 3) as number);
  if (isExhausted) {
    try {
      const payload = job.data as EmailJobPayload;
      await prisma.notification.updateMany({
        where: {
          id: payload.notificationId,
          status: { in: [NotificationStatus.QUEUED, NotificationStatus.RETRYING, NotificationStatus.SENDING] },
        },
        data: {
          status: NotificationStatus.DEAD,
          lastError: err.message ?? 'Unknown error',
          failedAt: new Date(),
        },
      });
      console.error(`[EmailWorker] Job ${job.id} exhausted all retries for notification ${payload.notificationId} — marked DEAD`);
    } catch (dbErr) {
      console.error('[EmailWorker] Failed to mark notification as DEAD after retry exhaustion:', dbErr);
    }
  } else {
    console.warn(`[EmailWorker] Job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts}), will retry: ${err?.message}`);
  }
});

worker.on('error', (err) => {
  console.error('[EmailWorker] Worker error:', err);
});

process.on('SIGINT', async () => {
  await worker.close();
  await emailQueue.close();
  process.exit(0);
});

export { worker as emailWorker };