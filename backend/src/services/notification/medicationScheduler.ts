// backend/src/services/notification/medicationScheduler.ts
// Medication reminder scheduling (Rule 7): parse frequency, expand to discrete reminders, enqueue BullMQ timed jobs

import { Frequency } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { medicationReminderQueue } from '../../workers/medicationReminderWorker';

export interface ReminderTime {
  remindAt: Date;
  doseNumber: number;
  totalDoses: number;
}

export interface FrequencyParseResult {
  timesPerDay: number;
  defaultTimes: string[];
  endDate: Date | null;
  warnings: string[];
}

/**
 * Parse prescription frequency into actionable reminder schedule.
 */
export function parsePrescriptionFrequency(
  frequency: Frequency,
  frequencyCustom: string | null,
  startDate: Date,
  endDate: Date | null,
  _appTz: string = 'UTC'
): FrequencyParseResult {
  const warnings: string[] = [];
  let timesPerDay = 0;
  let defaultTimes: string[] = [];
  let effectiveEndDate = endDate;

  switch (frequency) {
    case Frequency.ONCE_DAILY:
      timesPerDay = 1;
      defaultTimes = ['09:00'];
      break;
    case Frequency.TWICE_DAILY:
      timesPerDay = 2;
      defaultTimes = ['09:00', '21:00'];
      break;
    case Frequency.THRICE_DAILY:
      timesPerDay = 3;
      defaultTimes = ['09:00', '14:00', '21:00'];
      break;
    case Frequency.QID:
      timesPerDay = 4;
      defaultTimes = ['09:00', '13:00', '17:00', '21:00'];
      break;
    case Frequency.WEEKLY:
      timesPerDay = 1;
      defaultTimes = ['09:00'];
      break;
    case Frequency.PRN:
      timesPerDay = 0;
      defaultTimes = [];
      break;
    case Frequency.CUSTOM:
      if (!frequencyCustom || !frequencyCustom.trim()) {
        warnings.push('CUSTOM frequency but frequencyCustom is empty — no reminders generated');
        timesPerDay = 0;
        defaultTimes = [];
        break;
      }
      const customResult = parseCustomFrequency(frequencyCustom.trim(), startDate);
      timesPerDay = customResult.timesPerDay;
      defaultTimes = customResult.defaultTimes;
      if (customResult.parsedEndDate && !effectiveEndDate) {
        effectiveEndDate = customResult.parsedEndDate;
      }
      warnings.push(...customResult.warnings);
      break;
    default:
      warnings.push(`Unknown frequency enum: ${frequency}`);
      timesPerDay = 0;
      defaultTimes = [];
  }

  if (!effectiveEndDate && frequency !== Frequency.PRN && timesPerDay > 0) {
    effectiveEndDate = new Date(startDate.getTime() + 30 * 24 * 60 * 60 * 1000);
    warnings.push('No end date specified — using 30-day rolling window');
  }

  return { timesPerDay, defaultTimes, endDate: effectiveEndDate, warnings };
}

interface CustomParseResult {
  timesPerDay: number;
  defaultTimes: string[];
  parsedEndDate: Date | null;
  warnings: string[];
}

function parseCustomFrequency(text: string, startDate: Date): CustomParseResult {
  const lower = text.toLowerCase().trim();
  const warnings: string[] = [];
  let timesPerDay = 0;
  let defaultTimes: string[] = [];
  let parsedEndDate: Date | null = null;

  // Pattern 1: "N times daily for D days" / "N times a day for D days"
  const dailyMatch = lower.match(/(\d+)\s*times?\s*(?:a|per)?\s*day\s*(?:for\s*(\d+)\s*days?)?/);
  if (dailyMatch) {
    timesPerDay = parseInt(dailyMatch[1], 10);
    if (dailyMatch[2]) {
      parsedEndDate = new Date(startDate.getTime() + parseInt(dailyMatch[2], 10) * 24 * 60 * 60 * 1000);
    }
    defaultTimes = generateEvenTimes(timesPerDay);
    return { timesPerDay, defaultTimes, parsedEndDate, warnings };
  }

  // Pattern 2: "once/twice/thrice daily for D days"
  const wordMatch = lower.match(/(once|twice|thrice)\s*(?:daily)?\s*(?:for\s*(\d+)\s*days?)?/);
  if (wordMatch) {
    const wordToNum: Record<string, number> = { once: 1, twice: 2, thrice: 3 };
    timesPerDay = wordToNum[wordMatch[1]] || 1;
    if (wordMatch[2]) {
      parsedEndDate = new Date(startDate.getTime() + parseInt(wordMatch[2], 10) * 24 * 60 * 60 * 1000);
    }
    defaultTimes = generateEvenTimes(timesPerDay);
    return { timesPerDay, defaultTimes, parsedEndDate, warnings };
  }

  // Pattern 3: "every N hours" / "every N hours for D days"
  const everyHoursMatch = lower.match(/every\s*(\d+)\s*hours?(?:\s*for\s*(\d+)\s*days?)?/);
  if (everyHoursMatch) {
    const interval = parseInt(everyHoursMatch[1], 10);
    if (interval > 0 && interval <= 24) {
      timesPerDay = Math.floor(24 / interval);
      defaultTimes = [];
      for (let i = 0; i < timesPerDay; i++) {
        const hour = (i * interval) % 24;
        defaultTimes.push(`${hour.toString().padStart(2, '0')}:00`);
      }
      if (everyHoursMatch[2]) {
        parsedEndDate = new Date(startDate.getTime() + parseInt(everyHoursMatch[2], 10) * 24 * 60 * 60 * 1000);
      }
      return { timesPerDay, defaultTimes, parsedEndDate, warnings };
    }
  }

  // Pattern 4: specific times like "9am and 9pm" or "09:00, 21:00"
  const specificTimes = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/gi);
  if (specificTimes && specificTimes.length > 0) {
    defaultTimes = specificTimes.map(t => {
      const m = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
      if (!m) return '09:00';
      let hour = parseInt(m[1], 10);
      const min = m[2] ? parseInt(m[2], 10) : 0;
      const ampm = m[3]?.toLowerCase();
      if (ampm === 'pm' && hour !== 12) hour += 12;
      if (ampm === 'am' && hour === 12) hour = 0;
      return `${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;
    });
    timesPerDay = defaultTimes.length;
    const forDaysMatch = lower.match(/for\s*(\d+)\s*days?/i);
    if (forDaysMatch) {
      parsedEndDate = new Date(startDate.getTime() + parseInt(forDaysMatch[1], 10) * 24 * 60 * 60 * 1000);
    }
    return { timesPerDay, defaultTimes, parsedEndDate, warnings };
  }

  warnings.push(`Could not parse custom frequency: "${text}" — no reminders generated`);
  return { timesPerDay: 0, defaultTimes: [], parsedEndDate: null, warnings };
}

function generateEvenTimes(timesPerDay: number): string[] {
  switch (timesPerDay) {
    case 1: return ['09:00'];
    case 2: return ['09:00', '21:00'];
    case 3: return ['09:00', '14:00', '21:00'];
    case 4: return ['09:00', '13:00', '17:00', '21:00'];
    default: return ['09:00'];
  }
}

/**
 * Generate all reminder timestamps for a prescription within a window.
 * Used by the expansion cron to create MedicationReminder rows + BullMQ delayed jobs.
 */
export function generateReminderTimes(
  _prescriptionId: string,
  _patientId: string,
  frequency: Frequency,
  frequencyCustom: string | null,
  startDate: Date,
  endDate: Date | null,
  _appTz: string = 'UTC',
  windowEnd?: Date
): ReminderTime[] {
  const parseResult = parsePrescriptionFrequency(frequency, frequencyCustom, startDate, endDate, 'UTC');
  const { timesPerDay, defaultTimes, endDate: effectiveEndDate, warnings } = parseResult;

  if (timesPerDay === 0 || defaultTimes.length === 0) {
    if (warnings.length > 0) {
      console.warn('[Medication] Frequency parse warnings:', warnings.join('; '));
    }
    return [];
  }

  // effectiveEndDate can be null - check explicitly
  if (!effectiveEndDate) return [];
  if (effectiveEndDate < startDate) return [];
  const finalEndDate = windowEnd && windowEnd < effectiveEndDate ? windowEnd : effectiveEndDate;
  if (finalEndDate < startDate) return [];

  const reminders: ReminderTime[] = [];
  let doseNumber = 1;
  const totalDays = Math.ceil((finalEndDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  const totalDoses = totalDays * timesPerDay;

  const current = new Date(startDate);
  current.setHours(0, 0, 0, 0);

  while (current <= finalEndDate) {
    for (const timeStr of defaultTimes) {
      const [hh, mm] = timeStr.split(':').map(Number);
      const remindAt = new Date(current);
      remindAt.setHours(hh, mm, 0, 0);

      // Convert from app timezone to UTC (assuming appTz === UTC per M1 A3)
      const remindAtUtc = new Date(remindAt.getTime());

      if (remindAtUtc > new Date()) {
        reminders.push({ remindAt: remindAtUtc, doseNumber, totalDoses });
      }
      doseNumber++;
    }
    current.setDate(current.getDate() + 1);
  }

  return reminders;
}

/**
 * Expansion cron: runs hourly to create MedicationReminder rows + BullMQ delayed jobs
 * for prescriptions that need reminders in the next 30 days.
 */
export async function runMedicationExpansionCron(): Promise<void> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  // Find prescriptions that need expansion:
  // - Start date <= windowEnd
  // - End date >= now (or null)
  // - No existing reminders for the window
  const prescriptions = await prisma.prescription.findMany({
    where: {
      AND: [
        { startDate: { lte: windowEnd } },
        {
          OR: [
            { endDate: { gte: now } },
            { endDate: null },
          ],
        },
        { medicationReminders: { none: { remindAt: { gte: now, lte: windowEnd } } } },
      ],
    },
    include: { patient: { include: { user: { select: { email: true } } } } },
  });

  for (const rx of prescriptions) {
    const reminders = generateReminderTimes(
      rx.id,
      rx.patientId,
      rx.frequency,
      rx.frequencyCustom,
      rx.startDate,
      rx.endDate,
      'UTC',
      windowEnd
    );

    if (reminders.length === 0) continue;

    // Bulk create MedicationReminder rows
    await prisma.medicationReminder.createMany({
      data: reminders.map((r) => ({
        prescriptionId: rx.id,
        patientId: rx.patientId,
        remindAt: r.remindAt,
        status: 'PENDING',
      })),
      skipDuplicates: true,
    });

    // Enqueue BullMQ delayed jobs for each reminder
    for (const r of reminders) {
      const delay = r.remindAt.getTime() - now.getTime();
      if (delay > 0) {
        await medicationReminderQueue.add('send-reminder', {
          prescriptionId: rx.id,
          patientId: rx.patientId,
          medicationName: rx.medicationName,
          dosage: rx.dosage,
          instructions: rx.instructions,
          doseNumber: r.doseNumber,
          totalDoses: r.totalDoses,
        }, {
          delay,
          attempts: 3,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: 200,
          removeOnFail: false,
        });
      }
    }
  }
}