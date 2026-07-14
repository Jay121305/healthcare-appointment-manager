// backend/src/services/calendar/calendarService.ts
// Thin Google Calendar API wrappers for create/delete of a single event.
// All PII minimization: only date/time/duration + name go to Google.
// No symptom form, chief complaint, severity, prescription, or notes are sent.

import { google, calendar_v3 } from 'googleapis';
import { getOAuthClient } from './oauthService';

// ─────────────────────────────────────────────────────────────────────────────
// Payload builder input — worker passes these per party
// ─────────────────────────────────────────────────────────────────────────────
export interface CreateEventInput {
  accessToken: string;
  // The connected party's own email (only this attendee appears on the event)
  recipientEmail: string;
  // Display rules: patient's event summarises the doctor; doctor's summarises the patient
  summaryFor: 'PATIENT' | 'DOCTOR';
  patientFullName: string;
  doctorFullName: string;
  doctorSpecialisation: string;
  startISO: string;
  endISO: string;
  bookingId: string; // included only as the last 8 chars of the booking ref (no UUID)
}

// ─────────────────────────────────────────────────────────────────────────────
// Build the Calendar API event body per spec §2.3
// ─────────────────────────────────────────────────────────────────────────────
export function buildCreateEventPayload(input: CreateEventInput): calendar_v3.Schema$Event {
  const summary =
    input.summaryFor === 'PATIENT'
      ? `Appointment with Dr. ${input.doctorFullName}`
      : `Appointment: ${input.patientFullName}`;

  const description =
    `Healthcare Appointment. Booking ref: ${input.bookingId.slice(0, 8)}.\n` +
    `Cancellation/changes via the ${input.summaryFor === 'PATIENT' ? 'patient' : 'doctor'} portal.\n` +
    `This is an automated event.`;

  return {
    summary,
    description,
    start: { dateTime: input.startISO, timeZone: 'UTC' },
    end: { dateTime: input.endISO, timeZone: 'UTC' },
    attendees: [
      { email: input.recipientEmail, responseStatus: 'accepted' },
    ],
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 60 },
        { method: 'email', minutes: 1440 }, // 24h — aligns with M5 booking reminder cadence
      ],
    },
    source: process.env.FRONTEND_OAUTH_RETURN_URL
      ? { url: process.env.FRONTEND_OAUTH_RETURN_URL, title: 'Healthcare Portal' }
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE: insert into the connected party's primary calendar.
// Returns the new Google event ID, or throws on failure.
// ─────────────────────────────────────────────────────────────────────────────
export async function createCalendarEvent(
  accessToken: string,
  payload: calendar_v3.Schema$Event
): Promise<string> {
  const client = getOAuthClient();
  client.setCredentials({ access_token: accessToken });
  const calendar = google.calendar({ version: 'v3', auth: client });
  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: payload,
    sendUpdates: 'none', // don't trigger Google invitations to attendees (we listed only the user anyway)
  });
  if (!res.data.id) {
    throw new Error('Google did not return an event id for insert');
  }
  return res.data.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE: remove a single event by id from the connected party's primary calendar.
// Idempotent: returns success on 410 Gone / 404 Not Found.
// Throws on retryable (5xx/timeout) errors so BullMQ can retry.
// Throws GooglePermanentError on auth 4xx other than 404/410 — worker catches and marks FAILED.
// ─────────────────────────────────────────────────────────────────────────────
export class GooglePermanentError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'GooglePermanentError';
    this.statusCode = statusCode;
  }
}

export async function deleteCalendarEvent(
  accessToken: string,
  eventId: string
): Promise<void> {
  const client = getOAuthClient();
  client.setCredentials({ access_token: accessToken });
  const calendar = google.calendar({ version: 'v3', auth: client });
  try {
    await calendar.events.delete({
      calendarId: 'primary',
      eventId,
      sendUpdates: 'none',
    });
  } catch (err: unknown) {
    // Normalize GaxiosError shape; googleapis can throw a few things here.
    const e = err as { code?: number; response?: { status?: number } };
    const status = e?.code ?? e?.response?.status ?? 0;
    if (status === 404 || status === 410) {
      // Already gone — treat as success (idempotent).
      return;
    }
    if (status >= 400 && status < 500) {
      // 401/403 etc: cannot recover without re-consent; signal permanent failure.
      throw new GooglePermanentError(`Google delete failed (${status})`, status);
    }
    // 5xx / network / timeout: rethrow for BullMQ retry.
    throw err;
  }
}
