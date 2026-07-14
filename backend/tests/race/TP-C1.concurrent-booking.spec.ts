// TP-C1 — Concurrent booking race (Rule 2)
//
// Goal: N = 20 patients race to confirm the same slot. Exactly 1 must
// succeed; the other N-1 must reject with HTTP 409 + slot_already_booked;
// the DB row count for that (doctor, date, time) triple stays at 1.
//
// Backend invariant under test:
//   bookings_doctor_id_booking_date_start_time status index shall reject
//   duplicate CONFIRMED rows at the `$transaction` boundary.

import request from 'supertest';
import { getTestApp, teardown } from '../helpers/testApp';
import {
  pickFreshSlot,
  signupPatient,
  signupDoctor,
  placeHoldAndConfirm,
  PatientFixture,
  DoctorFixture,
  futureWorkingDate,
  ymd,
} from '../helpers/fixtures';
import { prisma } from '../../src/config/prisma';

describe('TP-C1 — concurrent booking race (Rule 2)', () => {
  jest.setTimeout(120_000);

  const app = getTestApp();
  let doctor: DoctorFixture;
  let patients: PatientFixture[] = [];
  let target: { date: string; startUtcIso: string; endUtcIso: string };

  beforeAll(async () => {
    doctor = await signupDoctor(app, { slotDurationMinutes: 30 });
    // Pre-create patient accounts OUTSIDE the race window so signup latency
    // doesn't leak into the contention window.
    for (let i = 0; i < 20; i++) {
      patients.push(await signupPatient(app));
    }
    // Pick a fresh target slot
    target = await pickFreshSlot(app, patients[0], doctor, 14);
    if (!target) throw new Error('no fresh slot found for TP-C1');
  });

  afterAll(async () => {
    // Cleanup: delete the bookings + patients + doctor records to keep the
    // shared Neon DB tidy. We don't bother with notifications/cascade here.
    if (doctor) {
      try {
        await prisma.booking.deleteMany({ where: { doctorId: doctor.profileId } });
        await prisma.leaveDay.deleteMany({ where: { doctorId: doctor.profileId } });
        await prisma.doctorProfile.deleteMany({ where: { userId: doctor.userId } });
        await prisma.user.deleteMany({ where: { id: doctor.userId } });
      } catch {
        // ignore — best-effort cleanup
      }
    }
    for (const p of patients) {
      try {
        await prisma.booking.deleteMany({ where: { patientId: p.profileId } });
        await prisma.patientProfile.deleteMany({ where: { userId: p.userId } });
        await prisma.user.deleteMany({ where: { id: p.userId } });
      } catch {
        // ignore
      }
    }
    await teardown();
  });

  it('Rule 2: N=20 race produces exactly 1 success + 19 conflicts + 1 DB row', async () => {
    // 1. Pre-condition: zero existing rows for the target tuple
    const beforeCount = await prisma.booking.count({
      where: {
        doctorId: doctor.profileId,
        bookingDate: new Date(target.date + 'T00:00:00.000Z'),
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
      },
    });
    expect(beforeCount).toBe(0);

    // 2. Phase A — fire all 20 hold requests concurrently. We deliberately fire
    // these first, then fire all 20 confirms in a single Promise.allSettled
    // to maximize the race surface area inside the confirm $transaction.
    const holdResults = await Promise.allSettled(
      patients.map((patient) =>
        request(app)
          .post('/bookings/holds')
          .set('Authorization', `Bearer ${patient.accessToken}`)
          .send({
            doctorId: doctor.profileId,
            date: target.date,
            startTime: target.startUtcIso,
            ttlSeconds: 60,
          })
      )
    );

    const holdTokens: string[] = [];
    for (let i = 0; i < holdResults.length; i++) {
      const r = holdResults[i];
      if (r.status === 'fulfilled' && r.value.status === 201) {
        holdTokens.push(r.value.body.holdToken);
      }
    }
    // At least 1 hold should succeed (likely all 20 are admitted under
    // separate `bh:*` Redis keys — M3 limitation I2(M3) is acknowledged).
    expect(holdTokens.length).toBeGreaterThanOrEqual(1);

    // 3. Phase B — every patient who holds a slot now fires their symptom-form
    // + confirm concurrently.
    interface ConfirmEntry {
      token: string;
      patient: PatientFixture;
    }
    const confirms: ConfirmEntry[] = [];
    for (let i = 0; i < holdResults.length; i++) {
      const r = holdResults[i];
      if (r.status === 'fulfilled' && r.value.status === 201) {
        confirms.push({ token: r.value.body.holdToken, patient: patients[i] });
      }
    }

    const confirmResults = await Promise.allSettled(
      confirms.map(async ({ token, patient }) => {
        const a = await request(app)
          .post(`/bookings/${token}/symptom-form`)
          .set('Authorization', `Bearer ${patient.accessToken}`)
          .send({ primaryComplaint: `race-${token.slice(0, 6)}`, severity: 'MILD' });
        if (a.status !== 200) return { stage: 'symptom', status: a.status, body: a.body };
        const c = await request(app)
          .post(`/bookings/${token}/confirm`)
          .set('Authorization', `Bearer ${patient.accessToken}`)
          .send({});
        return { stage: 'confirm', status: c.status, body: c.body };
      })
    );

    const successes = confirmResults.filter(
      (r) => r.status === 'fulfilled' && (r as any).value?.status === 201
    );
    const conflicts = confirmResults.filter(
      (r) => r.status === 'fulfilled' && (r as any).value?.status === 409
    );
    const others = confirmResults.filter(
      (r) =>
        !(r.status === 'fulfilled' && ((r as any).value?.status === 201 || (r as any).value?.status === 409))
    );

    // C1.a: exactly 1 success
    expect(successes.length).toBe(1);
    // C1.b: N-1 conflicts (may be ≤ confirms.length-1 if some holds were
    // rejected up-front; in practice under a single Express process all 20
    // should produce a conflict)
    expect(conflicts.length).toBe(confirms.length - 1);
    // C1.c: zero non-201/non-409
    expect(others.length).toBe(0);
    // Each conflict is `SLOT_ALREADY_BOOKED`:
    for (const c of conflicts) {
      const v = (c as any).value;
      expect(v.body?.error).toBe('SLOT_ALREADY_BOOKED');
    }

    // C1.d: post-state row count = 1
    const afterCount = await prisma.booking.count({
      where: {
        doctorId: doctor.profileId,
        bookingDate: new Date(target.date + 'T00:00:00.000Z'),
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
      },
    });
    expect(afterCount).toBe(1);

    // C1.c (post): zero cancellations introduced by this race
    const cancelledCount = await prisma.booking.count({
      where: {
        doctorId: doctor.profileId,
        bookingDate: new Date(target.date + 'T00:00:00.000Z'),
        status: 'CANCELLED',
      },
    });
    expect(cancelledCount).toBe(0);
  });
});
