// TP-3a / TP-3b — Leave conflict: PREVIEW then AUTO_CANCEL (Rule 3)
//
// Goal: leave-conflict detection runs BEFORE commit; admin sees conflicts
// in dryRun=true, then 2nd request with dryRun=false atomically cancels
// the conflicting bookings + records the leave row.

import request from 'supertest';
import { getTestApp, teardown } from '../helpers/testApp';
import {
  signupPatient,
  signupDoctor,
  PatientFixture,
  DoctorFixture,
  pickFreshSlots,
  placeHoldAndConfirm,
  AdminFixture,
  login,
} from '../helpers/fixtures';
import { prisma } from '../../src/config/prisma';

const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? 'admin@healthcare.local';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? 'AdminPass123!';

describe('TP-3a/b — leave conflict PREVIEW + AUTO_CANCEL (Rule 3)', () => {
  jest.setTimeout(90_000);
  const app = getTestApp();

  let doctor: DoctorFixture;
  let patients: PatientFixture[] = [];
  let admin: AdminFixture;
  let bookingId: string;
  let targetDate: string;

  beforeAll(async () => {
    doctor = await signupDoctor(app, { slotDurationMinutes: 30 });
    patients = [
      await signupPatient(app),
      await signupPatient(app),
      await signupPatient(app),
    ];

    // 1. Create 3 confirmed bookings from each patient on DIFFERENT slots
    // on the SAME date (Rule 3 leave-conflict runs by DATE, not time).
    const slotsByPatient = await pickFreshSlots(app, patients[0], doctor, 3, 14);
    targetDate = slotsByPatient[0].date;
    for (let i = 0; i < 3; i++) {
      const r = await placeHoldAndConfirm(app, patients[i], doctor, {
        date: targetDate,
        startTime: slotsByPatient[i].startUtcIso,
        primaryComplaint: `tp3-${i}`,
      });
      if (r.kind !== 'ok') throw new Error(`conflicting booking setup failed at slot ${i}: ${JSON.stringify(r)}`);
    }

    // 2. Log in admin via the seed account OR a directly-created one.
    try {
      const loginRes = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD, 'ADMIN');
      admin = { ...loginRes, email: ADMIN_EMAIL, password: ADMIN_PASSWORD };
    } catch (e) {
      // Soft fallback: create an admin directly in the DB.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { hashPassword } = require('../../src/utils/passwordHash');
      const hash = await hashPassword(ADMIN_PASSWORD);
      await prisma.user.upsert({
        where: { email: ADMIN_EMAIL },
        update: { passwordHash: hash, isActive: true },
        create: {
          email: ADMIN_EMAIL,
          passwordHash: hash,
          role: 'ADMIN',
          isActive: true,
        },
      });
      const lr = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD, 'ADMIN');
      admin = { ...lr, email: ADMIN_EMAIL, password: ADMIN_PASSWORD };
    }

    // Pick the first CONFIRMED booking id for cleanup later
    const recent = await prisma.booking.findFirst({
      where: { doctorId: doctor.profileId, status: 'CONFIRMED' },
      orderBy: { bookedAt: 'desc' },
    });
    bookingId = recent!.id;
  });

  afterAll(async () => {
    // Cleanup
    try {
      await prisma.booking.deleteMany({ where: { doctorId: doctor.profileId } });
      await prisma.leaveDay.deleteMany({ where: { doctorId: doctor.profileId } });
      await prisma.preVisitSummary.deleteMany({ where: { booking: { doctorId: doctor.profileId } } });
      await prisma.postVisitSummary.deleteMany({ where: { booking: { doctorId: doctor.profileId } } });
      await prisma.calendarEvent.deleteMany({ where: { booking: { doctorId: doctor.profileId } } });
      await prisma.notification.deleteMany({ where: { booking: { doctorId: doctor.profileId } } });
      await prisma.symptomForm.deleteMany({ where: { booking: { doctorId: doctor.profileId } } });
      await prisma.doctorProfile.deleteMany({ where: { userId: doctor.userId } });
      await prisma.user.deleteMany({ where: { id: doctor.userId } });
    } catch {/* ignore */}
    for (const p of patients) {
      try {
        await prisma.patientProfile.deleteMany({ where: { userId: p.userId } });
        await prisma.user.deleteMany({ where: { id: p.userId } });
      } catch {/* ignore */}
    }
    await teardown();
  });

  it('3a.a: PREVIEW returns CONFLICT_DETECTED with no side effects', async () => {
    // Snapshot notification count BEFORE the preview call so we can assert the
    // preview itself adds zero (booking-confirm notifications from beforeAll
    // are intentionally present — that's M5's normal fire-async path).
    const bookingIds = (await prisma.booking.findMany({
      where: { doctorId: doctor.profileId },
      select: { id: true },
    })).map((b) => b.id);
    const notesBefore = await prisma.notification.count({
      where: { bookingId: { in: bookingIds } },
    });

    const res = await request(app)
      .post(`/admin/doctors/${doctor.profileId}/leave`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        rangeStart: targetDate,
        rangeEnd: targetDate,
        reason: 'TP-3 conflict test',
        dryRun: true,
        conflictResolution: 'PREVIEW',
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CONFLICT_DETECTED');
    expect(res.body.conflictDates.length).toBeGreaterThanOrEqual(1);
    // 3a.a: zero side effects
    expect(res.body.leaveRowsCreated).toBe(0);
    expect(res.body.autoCancelledBookings.length).toBe(0);

    // 3a.b: zero leave_days rows
    const leaveCount = await prisma.leaveDay.count({
      where: { doctorId: doctor.profileId, leaveDate: new Date(targetDate + 'T00:00:00.000Z') },
    });
    expect(leaveCount).toBe(0);

    // 3a.c: bookings still all CONFIRMED
    const stillConfirmed = await prisma.booking.count({
      where: { doctorId: doctor.profileId, status: 'CONFIRMED' },
    });
    expect(stillConfirmed).toBe(3);

    // 3a.d: PREVIEW added zero notifications (delta only — booking-confirm
    // notifications from the beforeAll booking setup are intentionally present).
    const notesAfter = await prisma.notification.count({
      where: { bookingId: { in: bookingIds } },
    });
    expect(notesAfter - notesBefore).toBe(0);
  });

  it('3b.a: AUTO_CANCEL persists the leave row + cancels bookings + queues notifications', async () => {
    const res = await request(app)
      .post(`/admin/doctors/${doctor.profileId}/leave`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        rangeStart: targetDate,
        rangeEnd: targetDate,
        reason: 'TP-3 conflict test',
        dryRun: false,
        conflictResolution: 'AUTO_CANCEL',
        autoCancel: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CONFLICT_DETECTED');
    expect(res.body.leaveRowsCreated).toBe(1);
    expect(res.body.autoCancelledBookings.length).toBeGreaterThanOrEqual(3);

    // 3b.c: leave_days row inserted
    const leaveCount = await prisma.leaveDay.count({
      where: { doctorId: doctor.profileId, leaveDate: new Date(targetDate + 'T00:00:00.000Z') },
    });
    expect(leaveCount).toBe(1);

    // 3b.b: bookings now CANCELLED
    const cancelled = await prisma.booking.count({
      where: { doctorId: doctor.profileId, status: 'CANCELLED' },
    });
    expect(cancelled).toBeGreaterThanOrEqual(3);

    // 3b.d: M5 producer enqueued notifications (regardless of email worker failure)
    const noteRows = await prisma.notification.findMany({
      where: {
        bookingId: {
          in: (await prisma.booking.findMany({ where: { doctorId: doctor.profileId } })).map((b) => b.id),
        },
      },
    });
    expect(noteRows.length).toBeGreaterThanOrEqual(6); // 3 patients × 2 (patient+doctor)
  });
});
