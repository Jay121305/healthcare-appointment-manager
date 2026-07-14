// backend/src/workers/calendarSyncWorker.ts
// BullMQ worker for Google Calendar event sync (Rule 8).
// Two ops: 'create' (after booking confirm) and 'delete' (after cancel / reschedule-old).
// Same non-blocking pattern as emailWorker.ts: failures never propagate to the
// booking response - the trigger function in bookingService.ts already returned.

import { Worker, Queue } from 'bullmq';
import { getRedisConnection } from '../config/redis';
import { prisma } from '../config/prisma';
import { SyncStatus } from '@prisma/client';
import { getValidAccessToken } from '../services/calendar/oauthService';
import {
  buildCreateEventPayload,
  createCalendarEvent,
  deleteCalendarEvent,
  GooglePermanentError,
} from '../services/calendar/calendarService';

export const CALENDAR_SYNC_QUEUE_NAME = 'calendar-sync';

// ─────────────────────────────────────────────────────────────────────────────
// Queue — used by bookingService.ts trigger functions
// ─────────────────────────────────────────────────────────────────────────────
export const calendarSyncQueue = new Queue(CALENDAR_SYNC_QUEUE_NAME, {
  connection: getRedisConnection(),
  defaultJobOptions: {
    removeOnComplete: 200,
    removeOnFail: false,           // keep dead letters for visible failure state (Rule 6 analog)
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 }, // matches M5 email queue
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Job payload — carried from the trigger function. Worker re-reads from DB by
// bookingId only, never trusts a snapshot passed at enqueue time (pre-commit).
// ─────────────────────────────────────────────────────────────────────────────
export type CalendarSyncJob =
  | { op: 'create'; bookingId: string }
  | { op: 'delete'; bookingId: string };

// Default concurrency stays comfortably inside Google's 200 req/user/100s quota.
const WORKER_CONCURRENCY = parseInt(process.env.CALENDAR_WORKER_CONCURRENCY || '2', 10);

// ─────────────────────────────────────────────────────────────────────────────
// Worker
// ─────────────────────────────────────────────────────────────────────────────
const worker = new Worker(
  CALENDAR_SYNC_QUEUE_NAME,
  async (job) => {
    const data = job.data as CalendarSyncJob;
    console.log(`[CalendarSyncWorker] op=${data.op} bookingId=${data.bookingId} job=${job.id}`);

    if (data.op === 'create') {
      await handleCreate(data.bookingId);
    } else {
      await handleDelete(data.bookingId);
    }
  },
  {
    connection: getRedisConnection(),
    concurrency: WORKER_CONCURRENCY,
    stalledInterval: 300_000,
    maxStalledCount: 1,
    lockDuration: 60_000,
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// CREATE handler — fires for each party that's connected (silent skip otherwise)
// ─────────────────────────────────────────────────────────────────────────────
async function handleCreate(bookingId: string): Promise<void> {
  // 1. Re-read booking from DB (was committed before enqueue)
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      patient: { include: { user: { select: { id: true, email: true } } } },
      doctor: {
        include: {
          user: { select: { id: true, email: true } },
        },
      },
    },
  });
  if (!booking) {
    // Booking was deleted between enqueue and processing — log and move on, no retry.
    console.warn(`[CalendarSyncWorker] booking ${bookingId} not found; skipping create`);
    return;
  }

  // 2. Ensure CalendarEvent row exists for this booking (PENDING + both flags false)
  const calendarEvent = await prisma.calendarEvent.upsert({
    where: { bookingId },
    create: { bookingId, syncStatus: 'PENDING' },
    update: { syncStatus: 'RETRYING' }, // if re-processing after a previous failure
  });

  // 3. Compute end time as start + slotDurationMinutes (per DoctorProfile)
  //    Doctor slot length is configured per-doctor (M2).
  const doctorProfile = await prisma.doctorProfile.findUnique({
    where: { id: booking.doctorId },
    select: { slotDurationMinutes: true, fullName: true, specialisation: true },
  });
  const slotMin = doctorProfile?.slotDurationMinutes ?? 30;
  const patientProfile = await prisma.patientProfile.findUnique({
    where: { id: booking.patientId },
    select: { fullName: true },
  });

  const startISO = booking.startTime.toISOString();
  const endISO = new Date(booking.startTime.getTime() + slotMin * 60_000).toISOString();
  const bookingRef = booking.id;

  let patientConnected = false;
  let doctorConnected = false;
  let hadFailureRetryable = false;

  // ── 3a. Patient event (skip silently if not connected) ──
  const patientToken = await getValidAccessToken(booking.patient.user.id).catch((err: unknown) => {
    console.warn(
      `[CalendarSyncWorker] patient token refresh threw (booking ${bookingId}):`,
      (err as Error).message
    );
    hadFailureRetryable = true; // token refresh can fail transiently — let BullMQ retry
    return null as string | null;
  });

  if (patientToken !== null) {
    try {
      const payload = buildCreateEventPayload({
        accessToken: patientToken,
        recipientEmail: booking.patient.user.email,
        summaryFor: 'PATIENT',
        patientFullName: patientProfile?.fullName ?? 'Patient',
        doctorFullName: doctorProfile?.fullName ?? 'Doctor',
        doctorSpecialisation: doctorProfile?.specialisation ?? '',
        startISO,
        endISO,
        bookingId: bookingRef,
      });
      const googleEventId = await createCalendarEvent(patientToken, payload);
      await prisma.calendarEvent.update({
        where: { id: calendarEvent.id },
        data: {
          patientEventId: googleEventId,
          patientCalendarConnected: true,
          lastSyncError: null,
        },
      });
      patientConnected = true;
    } catch (err) {
      await recordCreateFailure(calendarEvent.id, 'patient', err);
      if (err instanceof GooglePermanentError) {
        // Stop trying this party — leave patientCalendarConnected at false.
      } else {
        hadFailureRetryable = true;
      }
    }
  }

  // ── 3b. Doctor event (skip silently if not connected) ──
  const doctorToken = await getValidAccessToken(booking.doctor.user.id).catch((err: unknown) => {
    console.warn(
      `[CalendarSyncWorker] doctor token refresh threw (booking ${bookingId}):`,
      (err as Error).message
    );
    hadFailureRetryable = true;
    return null as string | null;
  });

  if (doctorToken !== null) {
    try {
      const payload = buildCreateEventPayload({
        accessToken: doctorToken,
        recipientEmail: booking.doctor.user.email,
        summaryFor: 'DOCTOR',
        patientFullName: patientProfile?.fullName ?? 'Patient',
        doctorFullName: doctorProfile?.fullName ?? 'Doctor',
        doctorSpecialisation: doctorProfile?.specialisation ?? '',
        startISO,
        endISO,
        bookingId: bookingRef,
      });
      const googleEventId = await createCalendarEvent(doctorToken, payload);
      await prisma.calendarEvent.update({
        where: { id: calendarEvent.id },
        data: {
          doctorEventId: googleEventId,
          doctorCalendarConnected: true,
          lastSyncError: null,
        },
      });
      doctorConnected = true;
    } catch (err) {
      await recordCreateFailure(calendarEvent.id, 'doctor', err);
      if (!(err instanceof GooglePermanentError)) {
        hadFailureRetryable = true;
      }
    }
  }

  // 4. Compute syncStatus — only mark SYNCED when no retryable failure remains.
  //    Permanent (4xx) failures leave the relevant flag false and are also success
  //    from the worker's perspective (we don't want BullMQ to retry them forever).
  if (hadFailureRetryable) {
    // Throw to trigger BullMQ retry — status row stays in RETRYING.
    throw new Error(
      `calendar create had retryable failure for booking ${bookingId} (patient=${patientConnected}, doctor=${doctorConnected})`
    );
  }

  await prisma.calendarEvent.update({
    where: { id: calendarEvent.id },
    data: {
      syncStatus: SyncStatus.SYNCED,
      lastSyncError: null,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE handler — fires for each party that had an event id stored.
// Per spec §1.8 & §3.4: even disconnected users keep their *EventId on the row,
// so a future cancel can still attempt deletion; we only fail/skip if the
// refresh-token lookup itself returns null AND there's no token to use.
// ─────────────────────────────────────────────────────────────────────────────
async function handleDelete(bookingId: string): Promise<void> {
  const calendarEvent = await prisma.calendarEvent.findUnique({
    where: { bookingId },
    include: {
      booking: {
        include: {
          patient: { include: { user: { select: { id: true } } } },
          doctor: { include: { user: { select: { id: true } } } },
        },
      },
    },
  });
  if (!calendarEvent) {
    // Booking pre-dated M6, or booking created with no calendar row — nothing to delete.
    console.info(`[CalendarSyncWorker] no CalendarEvent row for booking ${bookingId}; delete no-op`);
    return;
  }

  await prisma.calendarEvent.update({
    where: { id: calendarEvent.id },
    data: { syncStatus: SyncStatus.RETRYING },
  });

  let hadFailureRetryable = false;
  let attemptedAny = false;

  // Patient delete
  if (calendarEvent.patientEventId) {
    attemptedAny = true;
    const patientToken = await getValidAccessToken(calendarEvent.booking.patient.user.id).catch(
      (_err: unknown) => { hadFailureRetryable = true; return null as string | null; }
    );
    if (patientToken !== null) {
      try {
        await deleteCalendarEvent(patientToken, calendarEvent.patientEventId);
        await prisma.calendarEvent.update({
          where: { id: calendarEvent.id },
          data: { patientEventId: null },
        });
      } catch (err) {
        await recordDeleteFailure(calendarEvent.id, 'patient', err);
        if (!(err instanceof GooglePermanentError)) {
          hadFailureRetryable = true;
        } else {
          // Permanent — clear the id so we don't keep retrying a dead end.
          await prisma.calendarEvent.update({
            where: { id: calendarEvent.id },
            data: { patientEventId: null, patientCalendarConnected: false },
          });
        }
      }
    } else if (!hadFailureRetryable) {
      // User permanently disconnected (oauth row gone). Clear the stored id — we
      // can no longer reach this event on Google's side. Logged but not a retryable failure.
      await prisma.calendarEvent.update({
        where: { id: calendarEvent.id },
        data: { patientEventId: null, patientCalendarConnected: false },
      });
      console.warn(
        `[CalendarSyncWorker] patient disconnected; cannot delete Google event for booking ${bookingId}`
      );
    }
  }

  // Doctor delete
  if (calendarEvent.doctorEventId) {
    attemptedAny = true;
    const doctorToken = await getValidAccessToken(calendarEvent.booking.doctor.user.id).catch(
      (_err: unknown) => { hadFailureRetryable = true; return null as string | null; }
    );
    if (doctorToken !== null) {
      try {
        await deleteCalendarEvent(doctorToken, calendarEvent.doctorEventId);
        await prisma.calendarEvent.update({
          where: { id: calendarEvent.id },
          data: { doctorEventId: null },
        });
      } catch (err) {
        await recordDeleteFailure(calendarEvent.id, 'doctor', err);
        if (!(err instanceof GooglePermanentError)) {
          hadFailureRetryable = true;
        } else {
          await prisma.calendarEvent.update({
            where: { id: calendarEvent.id },
            data: { doctorEventId: null, doctorCalendarConnected: false },
          });
        }
      }
    } else if (!hadFailureRetryable) {
      await prisma.calendarEvent.update({
        where: { id: calendarEvent.id },
        data: { doctorEventId: null, doctorCalendarConnected: false },
      });
      console.warn(
        `[CalendarSyncWorker] doctor disconnected; cannot delete Google event for booking ${bookingId}`
      );
    }
  }

  if (hadFailureRetryable) {
    throw new Error(`calendar delete had retryable failure for booking ${bookingId}`);
  }

  // If neither side had an event to delete (no event ids), still mark SYNCED — idempotent.
  if (attemptedAny || calendarEvent.patientEventId === null && calendarEvent.doctorEventId === null) {
    await prisma.calendarEvent.update({
      where: { id: calendarEvent.id },
      data: { syncStatus: SyncStatus.SYNCED, lastSyncError: null },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Failure recording helpers — write lastSyncError without overwriting event ids
// ─────────────────────────────────────────────────────────────────────────────
async function recordCreateFailure(calendarEventId: string, party: 'patient' | 'doctor', err: unknown): Promise<void> {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const isPermanent = err instanceof GooglePermanentError;
  await prisma.calendarEvent.update({
    where: { id: calendarEventId },
    data: {
      syncStatus: isPermanent ? SyncStatus.FAILED : SyncStatus.RETRYING,
      lastSyncError: `[${party} create] ${msg}`,
      ...(isPermanent ? { [party === 'patient' ? 'patientCalendarConnected' : 'doctorCalendarConnected']: false } : {}),
    },
  });
}

async function recordDeleteFailure(calendarEventId: string, party: 'patient' | 'doctor', err: unknown): Promise<void> {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const isPermanent = err instanceof GooglePermanentError;
  await prisma.calendarEvent.update({
    where: { id: calendarEventId },
    data: {
      syncStatus: isPermanent ? SyncStatus.FAILED : SyncStatus.RETRYING,
      lastSyncError: `[${party} delete] ${msg}`,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle hooks
// ─────────────────────────────────────────────────────────────────────────────
worker.on('completed', (job) => {
  const data = job.data as CalendarSyncJob;
  console.log(`[CalendarSyncWorker] completed op=${data.op} bookingId=${data.bookingId} job=${job.id}`);
});

// Rule 8 visible failure state — final retry exhaustion marks CalendarEvent.syncStatus=FAILED
worker.on('failed', async (job, err) => {
  if (!job) return;
  const isExhausted = job.attemptsMade >= ((job.opts.attempts ?? 3) as number);
  if (!isExhausted) {
    console.warn(
      `[CalendarSyncWorker] job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts}), will retry: ${err?.message}`
    );
    return;
  }
  const data = job.data as CalendarSyncJob;
  console.error(
    `[CalendarSyncWorker] job ${job.id} exhausted retries for op=${data.op} booking=${data.bookingId} — marking FAILED`
  );
  try {
    await prisma.calendarEvent.updateMany({
      where: { bookingId: data.bookingId },
      data: {
        syncStatus: SyncStatus.FAILED,
        lastSyncError: `BullMQ retries exhausted: ${err?.message ?? 'Unknown error'}`,
      },
    });
  } catch (dbErr) {
    console.error('[CalendarSyncWorker] Failed to mark CalendarEvent as FAILED after retry exhaustion:', dbErr);
  }
});

worker.on('error', (err) => {
  console.error('[CalendarSyncWorker] Worker error:', err);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await worker.close();
  await calendarSyncQueue.close();
  process.exit(0);
});

export { worker as calendarSyncWorker };
