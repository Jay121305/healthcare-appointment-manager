// backend/src/workers/postVisitWorker.ts
// BullMQ worker for generating post-visit summaries

import { Worker, Queue } from 'bullmq';
import { getRedisConnection } from '../config/redis';
import { generatePostVisitSummary } from '../services/llm/llmService';
import { prisma } from '../config/prisma';

export const POST_VISIT_QUEUE_NAME = 'post-visit-summary';

export const postVisitQueue = new Queue(POST_VISIT_QUEUE_NAME, {
  connection: getRedisConnection(),
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 50,
    attempts: 1, // We handle retry inside the LLM call, not via BullMQ
  },
});

const worker = new Worker(
  POST_VISIT_QUEUE_NAME,
  async (job) => {
    const { bookingId } = job.data as { bookingId: string };

    console.log('[PostVisitWorker] Processing job:', bookingId);

    // Load post-visit summary to get doctor notes
    const postVisit = await prisma.postVisitSummary.findUnique({
      where: { bookingId },
    });

    if (!postVisit) {
      throw new Error(`PostVisitSummary not found: ${bookingId}`);
    }

    if (!postVisit.doctorNotes) {
      throw new Error(`No doctor notes for booking: ${bookingId}`);
    }

    // Update status to RETRYING before LLM call
    await prisma.postVisitSummary.update({
      where: { bookingId },
      data: { llmStatus: 'RETRYING' },
    });

    // Generate post-visit summary (handles retry/fallback internally)
    await generatePostVisitSummary(bookingId, postVisit.doctorNotes);

    console.log('[PostVisitWorker] Completed job:', bookingId);
  },
  { connection: getRedisConnection(), concurrency: 1 }
);

worker.on('completed', (job) => {
  console.log('[PostVisitWorker] Job completed:', job.id);
});

worker.on('failed', (job, err) => {
  console.error('[PostVisitWorker] Job failed:', job?.id, err?.message);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await worker.close();
  await postVisitQueue.close();
  process.exit(0);
});

export { worker as postVisitWorker };