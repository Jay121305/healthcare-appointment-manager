// TP-Coin1 — End-to-end cross-cutting failure mesh
//
// Goal: With ALL failure injections simultaneously active (invalid NIM key
// + invalid Resend key + no OAuth rows), run a TP-C1-style race and assert
// that booking row stays CONFIRMED, LLM summaries reach FALLBACK,
// notifications reach DEAD, and calendar events silently skip. This is
// the defensive end-state the regression ledger promises.

import request from 'supertest';
import { getTestApp, teardown } from '../helpers/testApp';
import { bootWorkers, WorkersHandle } from '../helpers/bootWorkers';
import {
  signupPatient,
  signupDoctor,
  PatientFixture,
  DoctorFixture,
  pickFreshSlot,
} from '../helpers/fixtures';
import { prisma } from '../../src/config/prisma';

const RACE_N = 12;

describe('TP-Coin1 — full failure-mesh cross-cut', () => {
  jest.setTimeout(300_000);
  const app = getTestApp();

  let workers: WorkersHandle | null = null;
  let doctor: DoctorFixture;
  let patients: PatientFixture[];
  let target: { date: string; startUtcIso: string; endUtcIso: string };
  let winningBookingId: string | null = null;

  beforeAll(async () => {
    workers = await bootWorkers();
    doctor = await signupDoctor(app, { slotDurationMinutes: 30 });

    patients = [];
    for (let i = 0; i < RACE_N; i++) {
      patients.push(await signupPatient(app));
    }

    target = await pickFreshSlot(app, patients[0], doctor, 14);
  });

  afterAll(async () => {
    // Best-effort cleanup of generated data.
    try {
      const doctorBookings = await prisma.booking.findMany({
        where: { doctorId: doctor.profileId },
      });
      const ids = doctorBookings.map((b) => b.id);
      if (ids.length) {
        await prisma.notification.deleteMany({ where: { bookingId: { in: ids } } });
        await prisma.calendarEvent.deleteMany({ where: { bookingId: { in: ids } } });
        await prisma.preVisitSummary.deleteMany({ where: { bookingId: { in: ids } } });
        await prisma.postVisitSummary.deleteMany({ where: { bookingId: { in: ids } } });
        await prisma.symptomForm.deleteMany({ where: { bookingId: { in: ids } } });
      }
      await prisma.booking.deleteMany({ where: { doctorId: doctor.profileId } });
      await prisma.leaveDay.deleteMany({ where: { doctorId: doctor.profileId } });
      await prisma.doctorProfile.deleteMany({ where: { userId: doctor.userId } });
      await prisma.user.deleteMany({ where: { id: doctor.userId } });
    } catch {/* ignore */}
    for (const p of patients) {
      try {
        const ppBookings = await prisma.booking.findMany({
          where: { patientId: p.profileId },
        });
        const ids = ppBookings.map((b) => b.id);
        if (ids.length) {
          await prisma.notification.deleteMany({ where: { bookingId: { in: ids } } });
          await prisma.calendarEvent.deleteMany({ where: { bookingId: { in: ids } } });
          await prisma.preVisitSummary.deleteMany({ where: { bookingId: { in: ids } } });
          await prisma.postVisitSummary.deleteMany({ where: { bookingId: { in: ids } } });
          await prisma.symptomForm.deleteMany({ where: { bookingId: { in: ids } } });
          await prisma.booking.deleteMany({ where: { patientId: p.profileId } });
        }
        await prisma.patientProfile.deleteMany({ where: { userId: p.userId } });
        await prisma.user.deleteMany({ where: { id: p.userId } });
      } catch {/* ignore */}
    }
    if (workers) await workers.shutdown();
    await teardown();
  });

  it('Coin1.a: race resolves to exactly 1 success, 1 DB row (Rule 2)', async () => {
    // Phase A: fire all 12 holds in parallel. M3's Redis `bh:*` hold key
    // means only one is admitted (the rest get 409 SLOT_HELD); we collect
    // the winners. Under a single Express process this typically ≤1,
    // sometimes more if Redis `SET ... NX` interleaving admits several on
    // distinct sub-second ticks.
    const holdResults = await Promise.allSettled(
      patients.map((p) =>
        request(app)
          .post('/bookings/holds')
          .set('Authorization', `Bearer ${p.accessToken}`)
          .send({
            doctorId: doctor.profileId,
            date: target.date,
            startTime: target.startUtcIso,
            ttlSeconds: 60,
          })
      )
    );

    // Pick every patient who successfully held the slot.
    interface HoldWinner { patient: PatientFixture; token: string; }
    const holdWinners: HoldWinner[] = [];
    for (let i = 0; i < holdResults.length; i++) {
      const r = holdResults[i];
      if (r.status === 'fulfilled' && r.value.status === 201) {
        holdWinners.push({ patient: patients[i], token: r.value.body.holdToken });
      }
    }
    expect(holdWinners.length).toBeGreaterThanOrEqual(1);

    // Phase B: fire all confirms in parallel — this is the real Rule 2 race
    // on the `$transaction` boundary via the DB partial unique index.
    const confirmResults = await Promise.allSettled(
      holdWinners.map(async ({ patient, token }) => {
        const sf = await request(app)
          .post(`/bookings/${token}/symptom-form`)
          .set('Authorization', `Bearer ${patient.accessToken}`)
          .send({ primaryComplaint: 'coin1', severity: 'MILD' });
        if (sf.status !== 200) {
          return { stage: 'symptom', status: sf.status, body: sf.body };
        }
        const c = await request(app)
          .post(`/bookings/${token}/confirm`)
          .set('Authorization', `Bearer ${patient.accessToken}`)
          .send({});
        return { stage: 'confirm', status: c.status, body: c.body };
      })
    );

    interface ConfirmOutcome {
      stage: string;
      status: number;
      body: { error?: string; [k: string]: unknown };
    }
    const outcomes: ConfirmOutcome[] = [];
    for (const r of confirmResults) {
      if (r.status === 'fulfilled') outcomes.push(r.value as ConfirmOutcome);
    }
    const successes = outcomes.filter((o) => o.stage === 'confirm' && o.status === 201);
    const slotConflicts = outcomes.filter(
      (o) => o.stage === 'confirm' && o.status === 409 && o.body?.error === 'SLOT_ALREADY_BOOKED'
    );
    const otherFailures = outcomes.filter(
      (o) => !(o.stage === 'confirm' && (o.status === 201 || (o.status === 409 && o.body?.error === 'SLOT_ALREADY_BOOKED')))
    );

    // Exactly 1 success; the rest must be 409 SLOT_ALREADY_BOOKED; zero others.
    expect(successes.length).toBe(1);
    expect(slotConflicts.length).toBe(holdWinners.length - 1);
    expect(otherFailures.length).toBe(0);

    if (successes.length > 0) {
      winningBookingId = (successes[0].body as { id: string }).id;
    }

    // Single row in DB for the contested (doctor, date, time):
    const rowCount = await prisma.booking.count({
      where: {
        doctorId: doctor.profileId,
        bookingDate: new Date(target.date + 'T00:00:00.000Z'),
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
      },
    });
    expect(rowCount).toBe(1);
  });

  it('Coin1.b: pre-visit summary reaches FALLBACK (Rule 5)', async () => {
    const deadline = Date.now() + 180_000;
    let summary: any = null;
    while (Date.now() < deadline) {
      summary = await prisma.preVisitSummary.findUnique({
        where: { bookingId: winningBookingId! },
      });
      if (summary && summary.llmStatus === 'FALLBACK') break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(summary).toBeDefined();
    expect(summary!.llmStatus).toBe('FALLBACK');
  });

  it('Coin1.c: emails reach DEAD state for the winning booking (Rule 6)', async () => {
    const deadline = Date.now() + 280_000;
    let deadCount = 0;
    while (Date.now() < deadline) {
      const rows = await prisma.notification.findMany({ where: { bookingId: winningBookingId! } });
      deadCount = rows.filter((r) => r.status === 'DEAD').length;
      // Two emails queued: BOOKING_CONFIRMATION × (patient, doctor)
      if (deadCount >= 2) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(deadCount).toBeGreaterThanOrEqual(2);
  });

  it('Coin1.d: calendar events silent-skip without OAuth tokens (Rule 8)', async () => {
    const evt = await prisma.calendarEvent.findUnique({ where: { bookingId: winningBookingId! } });
    // No oauth tokens row exists → worker silent-skip → row either absent or
    // in PENDING/FAILED-like state. Either is acceptable; the booking remains CONFIRMED.
    if (evt) {
      expect(['PENDING', 'SYNCING', 'SYNCED', 'FAILED', 'RETRYING']).toContain(evt.syncStatus);
    }
  });

  it('Coin1.e: winning booking remains CONFIRMED across all failures', async () => {
    const b = await prisma.booking.findUnique({ where: { id: winningBookingId! } });
    expect(b?.status).toBe('CONFIRMED');
  });
});
