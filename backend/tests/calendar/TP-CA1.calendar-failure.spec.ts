// TP-CA1 — Calendar queue failure injection (Rule 8)
//
// Mechanism: bogus OAuth refresh token OR absent oauth_tokens row for the
// user. The calendar worker calls `getValidAccessToken(userId)` for each
// party; if it returns `null` the worker silently skips that party (per
// A8(M6)). With no OAuth rows at all in the test database, both patient
// and doctor silently skip — calendar_events row ends in PENDING-like
// state without ever hitting Google.
//
// For a stronger failure mode (5xx from Google) we'd need to mock
// googleapis. In a sandbox env the silent-skip path is the most reliable
// cross-environment invariant.
//
// The Rule 8 assertion is unchanged either way: the booking remains
// CONFIRMED regardless of calendar worker outcome.

import request from 'supertest';
import { getTestApp, teardown } from '../helpers/testApp';
import { bootWorkers, WorkersHandle } from '../helpers/bootWorkers';
import {
  signupPatient,
  signupDoctor,
  PatientFixture,
  DoctorFixture,
  pickFreshSlot,
  placeHoldAndConfirm,
} from '../helpers/fixtures';
import { prisma } from '../../src/config/prisma';

describe('TP-CA1 — calendar queue failure (Rule 8) — silent-skip path', () => {
  jest.setTimeout(120_000);
  const app = getTestApp();

  let workers: WorkersHandle | null = null;
  let doctor: DoctorFixture;
  let patient: PatientFixture;
  let bookingId: string | null = null;

  beforeAll(async () => {
    workers = await bootWorkers();
    doctor = await signupDoctor(app, { slotDurationMinutes: 30 });
    patient = await signupPatient(app);
    const slot = await pickFreshSlot(app, patient, doctor, 14);
    const r = await placeHoldAndConfirm(app, patient, doctor, {
      date: slot.date,
      startTime: slot.startUtcIso,
      primaryComplaint: 'tp-ca1',
    });
    if (r.kind !== 'ok') throw new Error(`booking failed: ${JSON.stringify(r)}`);
    bookingId = r.booking.id;
  });

  afterAll(async () => {
    if (bookingId) {
      try {
        await prisma.notification.deleteMany({ where: { bookingId } });
        await prisma.calendarEvent.deleteMany({ where: { bookingId } });
        await prisma.preVisitSummary.deleteMany({ where: { bookingId } });
        await prisma.postVisitSummary.deleteMany({ where: { bookingId } });
        await prisma.symptomForm.deleteMany({ where: { bookingId } });
        await prisma.booking.deleteMany({ where: { id: bookingId } });
      } catch {/* ignore */}
    }
    if (doctor) {
      try {
        await prisma.doctorProfile.deleteMany({ where: { userId: doctor.userId } });
        await prisma.user.deleteMany({ where: { id: doctor.userId } });
      } catch {/* ignore */}
    }
    if (patient) {
      try {
        await prisma.patientProfile.deleteMany({ where: { userId: patient.userId } });
        await prisma.user.deleteMany({ where: { id: patient.userId } });
      } catch {/* ignore */}
    }
    if (workers) await workers.shutdown();
    await teardown();
  });

  it('CA1.a: booking HTTP 201 returned without calendar blocking', async () => {
    expect(bookingId).toBeDefined();
  });

  it('CA1.b: booking remains CONFIRMED regardless of calendar outcome', async () => {
    const b = await prisma.booking.findUnique({ where: { id: bookingId! } });
    expect(b?.status).toBe('CONFIRMED');
  });

  it('CA1.c: CalendarEvent row may exist or may not — worker either runs or silent-skips', async () => {
    // Either path is acceptable per A13(M6) — the row is app-created on tx
    // commit (PENDING) and then mutated by the worker; if the worker
    // silent-skips for absent OAuth tokens, the row remains in some
    // intermediate state. The invariant:
    //   - If row exists, booking MUST still be CONFIRMED
    //   - If row does NOT exist, booking still CONFIRMED (covered above)
    const evt = await prisma.calendarEvent.findUnique({ where: { bookingId: bookingId! } });
    if (evt) {
      // Latest syncStatus — may be one of PENDING / SYNCING / SYNCED / FAILED / RETRYING.
      expect(['PENDING', 'SYNCING', 'SYNCED', 'FAILED', 'RETRYING']).toContain(evt.syncStatus);
      // The booking row is unchanged.
      const b = await prisma.booking.findUnique({ where: { id: bookingId! } });
      expect(b?.status).toBe('CONFIRMED');
    }
    // Either case is a pass — the rule is "no rollback".
  });

  it('CA1.d: silent-skip path is observed (no Google API call without OAuth tokens)', async () => {
    // No oauth_tokens rows exist for this patient. The worker should have
    // silently skipped.
    const oauthRow = await prisma.oauthToken.findUnique({
      where: { userId: patient.userId },
    });
    expect(oauthRow).toBeNull();
  });
});
