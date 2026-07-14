// backend/src/workers/preVisitWorker.ts
// BullMQ worker for generating pre-visit summaries

import { Worker, Queue } from 'bullmq';
import { getRedisConnection } from '../config/redis';
import { generatePreVisitSummary } from '../services/llm/llmService';
import { prisma } from '../config/prisma';

export const PRE_VISIT_QUEUE_NAME = 'pre-visit-summary';

export const preVisitQueue = new Queue(PRE_VISIT_QUEUE_NAME, {
  connection: getRedisConnection(),
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 50,
    attempts: 1, // We handle retry inside the LLM call, not via BullMQ
  },
});

const worker = new Worker(
  PRE_VISIT_QUEUE_NAME,
  async (job) => {
    const { bookingId, symptomFormId } = job.data as {
      bookingId: string;
      symptomFormId: string;
    };

    console.log('[PreVisitWorker] Processing job:', bookingId);

    // Load symptom form
    const symptomForm = await prisma.symptomForm.findUnique({
      where: { id: symptomFormId },
    });

    if (!symptomForm) {
      throw new Error(`SymptomForm not found: ${symptomFormId}`);
    }

    // Ensure PreVisitSummary row exists (defensive: should already exist from booking tx).
    // Required for update() at line 262 of llmService.ts; throwing here is graceful.
    const existingSummary = await prisma.preVisitSummary.findUnique({
      where: { bookingId },
    });
    if (!existingSummary) {
      await prisma.preVisitSummary.create({
        data: {
          bookingId,
          symptomFormId,
          summaryText: '',
          llmStatus: 'PENDING',
        },
      });
    }

    // Update status to RETRYING before LLM call (for visibility)
    await prisma.preVisitSummary.update({
      where: { bookingId },
      data: { llmStatus: 'RETRYING' },
    });

    // Generate pre-visit summary (handles retry/fallback internally)
    await generatePreVisitSummary(bookingId, {
      primaryComplaint: symptomForm.primaryComplaint,
      durationDays: symptomForm.durationDays,
      severity: symptomForm.severity,
      description: symptomForm.description,
      currentMedications: symptomForm.currentMedications,
      allergies: symptomForm.allergies,
    });

    console.log('[PreVisitWorker] Completed job:', bookingId);
  },
  { connection: getRedisConnection(), concurrency: 1 }
);

worker.on('completed', (job) => {
  console.log('[PreVisitWorker] Job completed:', job.id);
});

worker.on('failed', (job, err) => {
  console.error('[PreVisitWorker] Job failed:', job?.id, err?.message);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await worker.close();
  await preVisitQueue.close();
  process.exit(0);
});

export { worker as preVisitWorker };