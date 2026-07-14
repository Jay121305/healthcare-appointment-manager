// tests/helpers/bootWorkers.ts
// For tests that need the BullMQ workers online (TP-L1, TP-E1, TP-CA1).
// The harness returns an object with `.shutdown()` that closes the queues
// cleanly. Callers MUST `shutdown()` before the test ends, otherwise the
// workers stay open across jest test boundaries and leak Redis sockets.

import { Queue, QueueEvents, Worker } from 'bullmq';

export interface WorkersHandle {
  emailWorker: Worker | undefined;
  preVisitWorker: Worker | undefined;
  postVisitWorker: Worker | undefined;
  reminderScanWorker: Worker | undefined;
  medicationReminderWorker: Worker | undefined;
  medicationExpansionWorker: Worker | undefined;
  calendarSyncWorker: Worker | undefined;
  shutdown: () => Promise<void>;
}

export async function bootWorkers(): Promise<WorkersHandle> {
  // Lazy import so test files that don't need workers don't pay the import cost
  // (and don't open Upstash sockets).
  const [
    emailModule,
    preVisitModule,
    postVisitModule,
    reminderScanModule,
    medReminderModule,
    medExpansionModule,
    calendarSyncModule,
  ] = await Promise.all([
    import('../../src/workers/emailWorker'),
    import('../../src/workers/preVisitWorker'),
    import('../../src/workers/postVisitWorker'),
    import('../../src/workers/reminderScanWorker'),
    import('../../src/workers/medicationReminderWorker'),
    import('../../src/workers/medicationExpansionWorker'),
    import('../../src/workers/calendarSyncWorker'),
  ]);

  const handle: WorkersHandle = {
    emailWorker: emailModule.emailWorker,
    preVisitWorker: preVisitModule.preVisitWorker,
    postVisitWorker: postVisitModule.postVisitWorker,
    reminderScanWorker: reminderScanModule.reminderScanWorker,
    medicationReminderWorker: medReminderModule.medicationReminderWorker,
    medicationExpansionWorker: medExpansionModule.medicationExpansionWorker,
    calendarSyncWorker: calendarSyncModule.calendarSyncWorker,
    shutdown: async () => {
      // `Worker.close()` returns a promise that resolves when in-flight jobs drain.
      await Promise.all(
        [
          emailModule.emailWorker,
          preVisitModule.preVisitWorker,
          postVisitModule.postVisitWorker,
          reminderScanModule.reminderScanWorker,
          medReminderModule.medicationReminderWorker,
          medExpansionModule.medicationExpansionWorker,
          calendarSyncModule.calendarSyncWorker,
        ].map(async (w) => {
          if (w) await w.close();
        })
      );
    },
  };
  return handle;
}
