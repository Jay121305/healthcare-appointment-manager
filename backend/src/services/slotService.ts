// backend/src/services/slotService.ts
// Slot availability computation — computed LIVE on read, never pre-materialized

import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';

export interface SlotInfo {
  startUTC: string;
  endUTC: string;
  startTimeLocal: string;
  available: boolean;
}

export interface SlotAvailabilityResponse {
  slots: SlotInfo[];
  reason: string;
}

export interface WorkingHours {
  mon?: { start: string; end: string } | null;
  tue?: { start: string; end: string } | null;
  wed?: { start: string; end: string } | null;
  thu?: { start: string; end: string } | null;
  fri?: { start: string; end: string } | null;
  sat?: { start: string; end: string } | null;
  sun?: { start: string; end: string } | null;
  [key: string]: { start: string; end: string } | null | undefined;
}

// Helper: parse "HH:mm" to minutes since midnight
function parseTimeToMinutes(timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

// Helper: convert minutes since midnight on a date to UTC Date
function minuteOfDayToLocalDateTime(date: Date, minutes: number): Date {
  const d = new Date(date);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d;
}

// Helper: format Date to "HH:mm"
function formatHHmm(date: Date): string {
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

// Helper: get day of week key from date
function getDayOfWeekKey(date: Date): string {
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  return days[date.getDay()];
}

// ─────────────────────────────────────────────────────────────────────────────
// Get available slots for a doctor on a specific date
// LIVE COMPUTATION — never pre-materialized (M2 design spec)
// ─────────────────────────────────────────────────────────────────────────────

export async function getAvailableSlots(
  doctorId: string,
  dateISO: string
): Promise<SlotAvailabilityResponse> {
// NOTE: APP_TZ tz-aware conversion not yet implemented; all slot arithmetic is UTC.
// Slot times below use server-local-time semantics via Date.setHours/getHours which on the
// Render default instance (system tz = UTC) match APP_TZ = UTC and thus behave correctly.
// If APP_TZ is ever set to a non-UTC value (e.g. Asia/Kolkata), every Date.setHours/getHours
// call below MUST be replaced with tz-aware equivalents (e.g. date-fns-tz zonedTimeToUtc /
// utcToZonedTime), otherwise slot boundaries will be wrongly offset. See I6 in PROJECT_STATE.md.
  const date = new Date(dateISO);
  date.setHours(0, 0, 0, 0);

  const dayOfWeek = getDayOfWeekKey(date);

  // Fetch doctor profile with leave days and active status
  const doctor = await prisma.doctorProfile.findUnique({
    where: { id: doctorId },
    include: {
      leaveDays: {
        where: {
          leaveDate: {
            gte: date,
            lt: new Date(date.getTime() + 86400000), // next day
          },
        },
      },
      user: {
        select: { isActive: true },
      },
    },
  });

  // Guard A: doctor must exist and be active
  if (!doctor || !doctor.user.isActive) {
    return { slots: [], reason: 'DOCTOR_INACTIVE_OR_NOT_FOUND' };
  }

  // Guard B: leave for that date
  if (doctor.leaveDays.length > 0) {
    return {
      slots: [],
      reason: doctor.leaveDays[0].reason ? `ON_LEAVE: ${doctor.leaveDays[0].reason}` : 'ON_LEAVE',
    };
  }

  // Guard C: past dates return empty
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (date < today) {
    return { slots: [], reason: 'PAST_DATE' };
  }

  const workingHours = doctor.workingHours as WorkingHours;
  const dayHours = workingHours[dayOfWeek];

  // Guard D: off-day
  if (!dayHours) {
    return { slots: [], reason: 'OFF_DAY' };
  }

  const slotDuration = doctor.slotDurationMinutes;
  if (slotDuration <= 0 || slotDuration > 180) {
    return { slots: [], reason: 'INVALID_SLOT_DURATION' };
  }

  // Build candidate slots in local time
  const startMinutes = parseTimeToMinutes(dayHours.start);
  const endMinutes = parseTimeToMinutes(dayHours.end);
  const candidateSlots: { startUTC: Date; endUTC: Date; startLocalTime: string }[] = [];

  let cursor = startMinutes;
  while (cursor + slotDuration <= endMinutes) {
    const localStart = minuteOfDayToLocalDateTime(date, cursor);
    const localEnd = minuteOfDayToLocalDateTime(date, cursor + slotDuration);

    // Convert to UTC (Prisma stores DateTime in UTC)
    const startUTC = new Date(localStart.getTime());
    const endUTC = new Date(localEnd.getTime());

    candidateSlots.push({
      startUTC,
      endUTC,
      startLocalTime: formatHHmm(localStart),
    });

    cursor += slotDuration;
  }

  // Fetch all ACTIVE bookings for this (doctor, date)
  // Note: We use the partial unique index logic — only CONFIRMED/RESCHEDULED block slots
  const existingBookings = await prisma.booking.findMany({
    where: {
      doctorId,
      status: { in: ['CONFIRMED', 'RESCHEDULED'] },
      bookingDate: {
        gte: date,
        lt: new Date(date.getTime() + 86400000),
      },
    },
    select: { startTime: true },
  });

  const bookedStartTimesUTC = new Set(
    existingBookings.map((b) => b.startTime.toISOString())
  );

  // Filter out booked slots
  const availableSlots = candidateSlots.filter(
    (s) => !bookedStartTimesUTC.has(s.startUTC.toISOString())
  );

  return {
    slots: availableSlots.map((s) => ({
      startUTC: s.startUTC.toISOString(),
      endUTC: s.endUTC.toISOString(),
      startTimeLocal: s.startLocalTime,
      available: true,
    })),
    reason: availableSlots.length === 0 ? 'NO_AVAILABLE_SLOTS' : 'OK',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Get leave days for a doctor (date range)
// ─────────────────────────────────────────────────────────────────────────────

export async function getLeaveDays(
  doctorId: string,
  rangeStart?: string,
  rangeEnd?: string
): Promise<{ leaveDate: string; reason: string | null }[]> {
  const where: Prisma.LeaveDayWhereInput = { doctorId };

  if (rangeStart || rangeEnd) {
    where.leaveDate = {};
    if (rangeStart) {
      const start = new Date(rangeStart);
      start.setHours(0, 0, 0, 0);
      where.leaveDate.gte = start;
    }
    if (rangeEnd) {
      const end = new Date(rangeEnd);
      end.setHours(23, 59, 59, 999);
      where.leaveDate.lte = end;
    }
  }

  const leaveDays = await prisma.leaveDay.findMany({
    where,
    orderBy: { leaveDate: 'asc' },
  });

  return leaveDays.map((ld) => ({
    leaveDate: ld.leaveDate.toISOString(),
    reason: ld.reason,
  }));
}