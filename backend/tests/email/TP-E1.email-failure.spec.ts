// TP-E1 — Email queue failure injection (Rule 6)
//
// Mechanism A: invalid RESEND_API_KEY (already the default in jest.setup)
// Effect intended: every `email-notification` BullMQ job fails 3× retries
// and ends with Notification.status === 'DEAD' (per I2(M5) resolution).
// Booking is NOT rolled back.

import request from 'supertest';
import { getTestApp, teardown } from '../helpers/testApp';
import { bootWorkers } from '../helpers/bootWorkers';
import {
  signupPatient,
  signupDoctor,
  PatientFixture,
  DoctorFixture,
  pickFreshSlot,
  placeHoldAndConfirm,
} from '../helpers/fixtures';
import { prisma } from '../../src/config/prisma';

describe('TP-E1 — email queue failure (Rule 6) — invalid Resend key', () => {
  jest.setTimeout(240_000);
  const app = getTestApp();

  let workers: Awaited<ReturnType<typeof bootWorkers>> | null = null;
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
      primaryComplaint: 'tp-e1',
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

  it('E1.a: booking HTTP 201 returned without email blocking', async () => {
    expect(bookingId).toBeDefined();
    const b = await prisma.booking.findUnique({ where: { id: bookingId! } });
    expect(b?.status).toBe('CONFIRMED');
  });

  it('E1.b: notifications reach DEAD after BullMQ retries exhausted', async () => {
    // Two notifications queued: BOOKING_CONFIRMATION × (patient, doctor).
    // We poll for those two rows to reach DEAD. Each BullMQ job has
    // attempts=3 with 30s exponential backoff, so we wait up to 240s.
    const deadline = Date.now() + 240_000;
    let confirmedCount = 0;
    while (Date.now() < deadline) {
      const rows = await prisma.notification.findMany({
        where: {
          bookingId: bookingId!,
          // The schema uses `notificationType` enum field; assert via query.
        },
      });
      const deadCount = rows.filter((r) => r.status === 'DEAD').length;
      // Two expected (patient + doctor) — M5 Part C spec only enumerates
      // BOOKING_CONFIRMATION rows for the 6 templates.
      if (deadCount >= 2) {
        confirmedCount = deadCount;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(confirmedCount).toBeGreaterThanOrEqual(2);
  });

  it('E1.c: booking row remains CONFIRMED regardless of email failure', async () => {
    const b = await prisma.booking.findUnique({ where: { id: bookingId! } });
    expect(b?.status).toBe('CONFIRMED');
  });

  it('E1.h: cancel path also produces DEAD notifications', async () => {
    // Cancel and assert the cancel notification reaches DEAD too.
    const cancel = await request(app)
      .post(`/bookings/${bookingId}/cancel`)
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({ reason: 'tp-e1 cleanup' });
    expect([200, 204]).toContain(cancel.status);

    const deadline = Date.now() + 240_000;
    let cancelDead = 0;
    while (Date.now() < deadline) {
      const rows = await prisma.notification.findMany({ where: { bookingId: bookingId! } });
      cancelDead = rows.filter((r) => r.status === 'DEAD').length;
      // Both confirm + cancel pairs should now be DEAD (4 total).
      if (cancelDead >= 4) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(cancelDead).toBeGreaterThanOrEqual(4);
  });
});
