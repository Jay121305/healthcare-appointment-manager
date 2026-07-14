// backend/src/workers/medicationExpansionWorker.ts
// Hourly cron to expand medication prescriptions into discrete reminders (Rule 7)

import { Worker, Queue } from 'bullmq';
import { getRedisConnection } from '../config/redis';
import { runMedicationExpansionCron } from '../services/notification/medicationScheduler';

export const MEDICATION_EXPANSION_QUEUE_NAME = 'medication-expansion';

export const medicationExpansionQueue = new Queue(MEDICATION_EXPANSION_QUEUE_NAME, {
  connection: getRedisConnection(),
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: false,
    attempts: 1,
  },
});

const worker = new Worker(
  MEDICATION_EXPANSION_QUEUE_NAME,
  async () => {
    await runMedicationExpansionCron();
    return { expanded: true };
  },
  {
    connection: getRedisConnection(),
    concurrency: 1,
    stalledInterval: 300_000,
    maxStalledCount: 1,
    lockDuration: 300_000,
  }
);

// Register as repeatable job (hourly)
medicationExpansionQueue.add('expand', {}, {
  repeat: { every: 60 * 60 * 1000 },
  removeOnComplete: 100,
  removeOnFail: false,
});

worker.on('completed', (job) => {
  console.log(`[MedExpansion] Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`[MedExpansion] Job ${job?.id} failed:`, err?.message);
});

worker.on('error', (err) => {
  console.error('[MedExpansion] Worker error:', err);
});

process.on('SIGINT', async () => {
  await worker.close();
  await medicationExpansionQueue.close();
  process.exit(0);
});

export { worker as medicationExpansionWorker };