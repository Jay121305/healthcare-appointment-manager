// backend/src/services/leaveService.ts
// Leave conflict-check service per Rule 3 — check BEFORE commit, notify affected patients

import { NotificationType } from '@prisma/client';
import { prisma } from '../config/prisma';
import { emailQueue } from '../workers/emailWorker';

export interface LeaveConflict {
  bookingId: string;
  patientId: string;
  patientName: string;
  patientEmail: string;
  startTime: string;
  bookingDate: string;
}

export interface ConflictByDate {
  leaveDate: string;
  bookings: LeaveConflict[];
}

export interface MarkLeaveInput {
  rangeStart: string;
  rangeEnd: string;
  reason?: string;
  dryRun?: boolean;
  conflictResolution?: 'PREVIEW' | 'AUTO_CANCEL';
}

export interface MarkLeaveResult {
  status: 'CONFLICT_DETECTED' | 'NO_CONFLICT';
  conflictDates: ConflictByDate[];
  affectedPatientCount: number;
  leaveRowsCreated: number;
  autoCancelledBookings: { bookingId: string; patientId: string }[];
  notificationsQueued: number;
}

// Helper: enumerate dates between start and end (inclusive)
function enumerateDates(startISO: string, endISO: string): Date[] {
  const dates: Date[] = [];
  const current = new Date(startISO);
  const end = new Date(endISO);
  current.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);

  while (current <= end) {
    dates.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

// Helper: format date to YYYY-MM-DD
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Mark leave with Rule 3 conflict detection
// Two-phase: PREVIEW (dry-run) → AUTO_CANCEL (commit)
// ─────────────────────────────────────────────────────────────────────────────

export async function markLeave(
  doctorId: string,
  input: MarkLeaveInput
): Promise<MarkLeaveResult> {
  const rangeStart = new Date(input.rangeStart);
  const rangeEnd = new Date(input.rangeEnd);
  const reason = input.reason || null;
  const dryRun = input.dryRun ?? false;
  const conflictResolution = input.conflictResolution || 'PREVIEW';

  // FIX I2: Look up the doctor's User.id from their DoctorProfile BEFORE the tx.
  // This is the userId that owns Notification.recipientUserId (FK → users.id).
  const doctorProfile = await prisma.doctorProfile.findUniqueOrThrow({
    where: { id: doctorId },
    select: { userId: true },
  });
  const doctorUserId: string = doctorProfile.userId;

  // Expand range to array of dates
  const leaveDates = enumerateDates(rangeStart.toISOString(), rangeEnd.toISOString());

  // ── PREVIEW PHASE — read-only, outside transaction ──────────────────────

  // Check which dates are already marked as leave
  const existingLeaveDays = await prisma.leaveDay.findMany({
    where: {
      doctorId,
      leaveDate: {
        in: leaveDates,
      },
    },
    select: { leaveDate: true },
  });

  const leaveDatesAlreadyMarked = new Set(
    existingLeaveDays.map((ld) => formatDate(ld.leaveDate))
  );

  const newLeaveDates = leaveDates.filter(
    (d) => !leaveDatesAlreadyMarked.has(formatDate(d))
  );

  // Fetch ALL confirmed+rescheduled bookings on the NEW leave dates
  const affectedBookings = await prisma.booking.findMany({
    where: {
      doctorId,
      status: { in: ['CONFIRMED', 'RESCHEDULED'] },
      bookingDate: {
        in: newLeaveDates,
      },
    },
    include: {
      patient: {
        include: {
          user: {
            select: { email: true, id: true },
          },
        },
      },
    },
    orderBy: { bookingDate: 'asc' },
  });

  // Group conflicts by date
  const conflictsByDate = new Map<string, typeof affectedBookings>();
  for (const booking of affectedBookings) {
    const dateKey = formatDate(booking.bookingDate);
    if (!conflictsByDate.has(dateKey)) {
      conflictsByDate.set(dateKey, []);
    }
    conflictsByDate.get(dateKey)!.push(booking);
  }

  const conflictDates: ConflictByDate[] = [];
  for (const date of newLeaveDates) {
    const dateKey = formatDate(date);
    if (conflictsByDate.has(dateKey)) {
      conflictDates.push({
        leaveDate: dateKey,
        bookings: conflictsByDate.get(dateKey)!.map((b) => ({
          bookingId: b.id,
          patientId: b.patient.id,
          patientName: b.patient.fullName,
          patientEmail: b.patient.user.email,
          startTime: b.startTime.toISOString(),
          bookingDate: formatDate(b.bookingDate),
        })),
      });
    }
  }

  const affectedPatientCount = new Set(
    conflictDates.flatMap((cd) => cd.bookings.map((b) => b.patientId))
  ).size;

  // ── BRANCH: dryRun=true (FIX I6, OPTION A) — return conflicts without committing ──
  if (dryRun) {
    return {
      status: conflictDates.length > 0 ? 'CONFLICT_DETECTED' : 'NO_CONFLICT',
      conflictDates,
      affectedPatientCount,
      leaveRowsCreated: 0,
      autoCancelledBookings: [],
      notificationsQueued: 0,
    };
  }

  // ── BRANCH: If conflicts exist and PREVIEW mode, return without committing ──
  if (conflictDates.length > 0 && conflictResolution === 'PREVIEW') {
    return {
      status: 'CONFLICT_DETECTED',
      conflictDates,
      affectedPatientCount,
      leaveRowsCreated: 0,
      autoCancelledBookings: [],
      notificationsQueued: 0,
    };
  }

  // ── COMMIT PHASE — inside a Prisma $transaction ─────────────────────────

  let leaveRowsCreated = 0;
  const autoCancelled: { bookingId: string; patientId: string }[] = [];
  // Carries the data needed to enqueue BullMQ jobs after tx commits.
  interface CreatedNotificationRef {
    id: string;
    recipientUserId: string;
    bookingId: string;
    notificationType: NotificationType;
  }
  const notificationsCreatedInTx: CreatedNotificationRef[] = [];

  interface PendingNotification {
    notificationType: NotificationType;
    recipientUserId: string; // must be users.id, never a profile id
    recipientRole: 'PATIENT' | 'DOCTOR';
    bookingId: string;
    subject: string;
    body: string;
  }

  const result = await prisma.$transaction(async (tx) => {
    // (a) Insert leave rows for every NEW date in range
    for (const date of newLeaveDates) {
      await tx.leaveDay.create({
        data: {
          doctorId,
          leaveDate: date,
          reason,
        },
      });
      leaveRowsCreated++;
    }

    // (b) Re-check conflicts INSIDE the transaction (race condition protection, Rule 3)
    const currentConflicts = await tx.booking.findMany({
      where: {
        doctorId,
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
        bookingDate: {
          in: newLeaveDates,
        },
      },
      include: {
        patient: {
          include: {
            user: {
              select: { email: true, id: true },
            },
          },
        },
      },
    });

    if (currentConflicts.length > 0 && conflictResolution !== 'AUTO_CANCEL') {
      // Admin's PREVIEW called without AUTO_CANCEL — abort
      throw {
        code: 'CONFLICT_REQUIRES_RESOLUTION',
        conflicts: currentConflicts,
      };
    }

    if (currentConflicts.length > 0 && conflictResolution === 'AUTO_CANCEL') {
      for (const booking of currentConflicts) {
        // (c) Cancel the booking — flip status, NEVER delete (audit + Rule 4)
        await tx.booking.update({
          where: { id: booking.id },
          data: { status: 'CANCELLED' },
        });

        autoCancelled.push({
          bookingId: booking.id,
          patientId: booking.patient.id,
        });

        // (d) Build patient notification — recipientUserId = booking.patient.user.id (users.id)
        const pendingNotifications: PendingNotification[] = [
          {
            notificationType: 'LEAVE_NOTICE',
            recipientUserId: booking.patient.user.id,
            recipientRole: 'PATIENT',
            bookingId: booking.id,
            subject: `Your appointment on ${formatDate(booking.bookingDate)} has been cancelled due to doctor leave`,
            body: `Dear ${booking.patient.fullName},\n\nYour appointment with the doctor on ${formatDate(booking.bookingDate)} at ${booking.startTime.toTimeString().slice(0, 5)} has been cancelled because the doctor will be on leave.\n\nReason: ${reason || 'No reason provided'}\n\nPlease book a new appointment at your convenience.\n\nBest regards,\nHealthcare Team`,
          },
          // (e) Build doctor notification — FIX I2: recipientUserId = doctorUserId (users.id), NOT doctorId
          {
            notificationType: 'LEAVE_NOTICE',
            recipientUserId: doctorUserId, // FIX I2: was incorrectly doctorId (DoctorProfile.id)
            recipientRole: 'DOCTOR',
            bookingId: booking.id,
            subject: `Leave marked — booking ${booking.id} auto-cancelled`,
            body: `Dear Doctor,\n\nYour leave has been marked for ${formatDate(booking.bookingDate)}.\n\nBooking ${booking.id} for patient ${booking.patient.fullName} has been auto-cancelled.\n\nReason: ${reason || 'No reason provided'}\n\nBest regards,\nAdmin`,
          },
        ];

        // (f) Insert notification rows inside the same tx — atomically with leave + cancel
        for (const n of pendingNotifications) {
          const created = await tx.notification.create({
            data: {
              notificationType: n.notificationType,
              recipientUserId: n.recipientUserId,
              recipientRole: n.recipientRole,
              bookingId: n.bookingId,
              subject: n.subject,
              body: n.body,
              status: 'QUEUED',
              scheduledFor: new Date(),
            },
          });
          notificationsCreatedInTx.push({
            id: created.id,
            recipientUserId: n.recipientUserId,
            bookingId: n.bookingId,
            notificationType: n.notificationType,
          });
        }
      }
    }

    return { leaveRowsCreated, autoCancelled };
  });

  // ── AFTER tx commits — dispatch queued notifications to BullMQ (best-effort, Rule 6)
  // NOTE: BullMQ integration - dispatch must never roll back the leave/cancel even on failure.
  // Visible failure state lives in the Notification table.
  let notificationsQueued = 0;
  if (notificationsCreatedInTx.length > 0) {
    try {
      await emailQueue.addBulk(
        notificationsCreatedInTx.map((n) => ({
          name: 'send-email',
          data: {
            notificationId: n.id,
            recipientUserId: n.recipientUserId,
            recipientEmail: '', // Worker will fetch via User FK relation; empty here since not available
            bookingId: n.bookingId,
            type: n.notificationType,
          },
          opts: { attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
        }))
      );
      notificationsQueued = notificationsCreatedInTx.length;
    } catch (err) {
      // Log error but do NOT roll back the leave or cancellations (they're already committed)
      console.error('Failed to queue notifications:', err);
      // Surface the failure in the durable Notification table (Rule 6 visible-failure-state)
      await prisma.notification.updateMany({
        where: { id: { in: notificationsCreatedInTx.map((n) => n.id) } },
        data: { status: 'FAILED', lastError: 'Queue dispatch failed' },
      });
    }
  }

  // ── Rule 8: Calendar event deletion for auto-cancelled bookings (best-effort, never blocks tx) ──
  for (const { bookingId } of autoCancelled) {
    try {
      // Placeholder: in production this would enqueue a calendar-cancel job to BullMQ.
      // await calendarQueue.add('cancel-event', { bookingId });
    } catch (err) {
      // Log error but do NOT roll back the cancellation
      console.error(`Failed to queue calendar cancel for booking ${bookingId}:`, err);
    }
  }

  return {
    status: conflictDates.length > 0 ? 'CONFLICT_DETECTED' : 'NO_CONFLICT',
    conflictDates,
    affectedPatientCount,
    leaveRowsCreated: result.leaveRowsCreated,
    autoCancelledBookings: result.autoCancelled,
    notificationsQueued,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Delete a single leave day
// ─────────────────────────────────────────────────────────────────────────────

export async function deleteLeaveDay(doctorId: string, leaveDateISO: string): Promise<void> {
  const leaveDate = new Date(leaveDateISO);
  leaveDate.setHours(0, 0, 0, 0);

  const deleted = await prisma.leaveDay.deleteMany({
    where: {
      doctorId,
      leaveDate: {
        gte: leaveDate,
        lt: new Date(leaveDate.getTime() + 86400000),
      },
    },
  });

  if (deleted.count === 0) {
    throw new Error('LEAVE_DAY_NOT_FOUND');
  }
}
