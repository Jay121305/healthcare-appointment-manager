// TP-RB1..RB22 — RBAC boundary tests (Rule 1)
//
// The authoritative boundary per PROJECT_STATE.md is server-side: every
// unauthorised request hits `authenticate` + `requireRoles(...)`, then
// resource-loaders, etc. Client-side tampering gains nothing.

import request from 'supertest';
import { getTestApp, teardown } from '../helpers/testApp';
import {
  signupPatient,
  signupDoctor,
  PatientFixture,
  DoctorFixture,
  pickFreshSlot,
  placeHoldAndConfirm,
  login,
} from '../helpers/fixtures';
import { prisma } from '../../src/config/prisma';

const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? 'admin@healthcare.local';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? 'AdminPass123!';

describe('TP-RB — RBAC boundary tests (Rule 1)', () => {
  jest.setTimeout(120_000);
  const app = getTestApp();

  let patient: PatientFixture;
  let patient2: PatientFixture;
  let doctor: DoctorFixture;
  let doctor2: DoctorFixture;
  let adminToken: string;
  let bookingId: string;

  beforeAll(async () => {
    doctor = await signupDoctor(app, { slotDurationMinutes: 30 });
    doctor2 = await signupDoctor(app, {
      specialisation: 'Cardiology',
      slotDurationMinutes: 30,
    });
    patient = await signupPatient(app);
    patient2 = await signupPatient(app);

    // Ensure we have admin credentials (use seed or create)
    try {
      const lr = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD, 'ADMIN');
      adminToken = lr.accessToken;
    } catch {
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
      adminToken = (await login(app, ADMIN_EMAIL, ADMIN_PASSWORD, 'ADMIN')).accessToken;
    }

    // Create a booking for `patient` with `doctor` to use as the cross-RBAC target
    const slot = await pickFreshSlot(app, patient, doctor, 14);
    const r = await placeHoldAndConfirm(app, patient, doctor, {
      date: slot.date,
      startTime: slot.startUtcIso,
      primaryComplaint: 'tp-rb',
    });
    if (r.kind !== 'ok') throw new Error('booking setup failed');
    bookingId = r.booking.id;
  });

  afterAll(async () => {
    // Cleanup
    try {
      await prisma.notification.deleteMany({ where: { bookingId } });
      await prisma.calendarEvent.deleteMany({ where: { bookingId } });
      await prisma.preVisitSummary.deleteMany({ where: { bookingId } });
      await prisma.postVisitSummary.deleteMany({ where: { bookingId } });
      await prisma.symptomForm.deleteMany({ where: { bookingId } });
      await prisma.booking.deleteMany({ where: { id: bookingId } });
    } catch {/* ignore */}
    if (doctor) {
      try {
        await prisma.booking.deleteMany({ where: { doctorId: doctor.profileId } });
        await prisma.leaveDay.deleteMany({ where: { doctorId: doctor.profileId } });
        await prisma.doctorProfile.deleteMany({ where: { userId: doctor.userId } });
        await prisma.user.deleteMany({ where: { id: doctor.userId } });
      } catch {/* ignore */}
    }
    if (doctor2) {
      try {
        await prisma.doctorProfile.deleteMany({ where: { userId: doctor2.userId } });
        await prisma.user.deleteMany({ where: { id: doctor2.userId } });
      } catch {/* ignore */}
    }
    for (const p of [patient, patient2]) {
      if (p) {
        try {
          await prisma.booking.deleteMany({ where: { patientId: p.profileId } });
          await prisma.patientProfile.deleteMany({ where: { userId: p.userId } });
          await prisma.user.deleteMany({ where: { id: p.userId } });
        } catch {/* ignore */}
      }
    }
    await teardown();
  });

  it('RB-1: patient hitting /admin/doctors returns 403', async () => {
    const res = await request(app)
      .get('/admin/doctors')
      .set('Authorization', `Bearer ${patient.accessToken}`);
    expect(res.status).toBe(403);
  });

  it('RB-2: patient POSTing a doctor returns 403', async () => {
    const res = await request(app)
      .post('/admin/doctors')
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({
        email: 'x@y.local',
        password: 'StrongP@ssw0rd!',
        fullName: 'X',
        specialisation: 'X',
        workingHours: { mon: { start: '09:00', end: '17:00' } },
      });
    expect(res.status).toBe(403);
  });

  it('RB-3: patient PUTing /admin/doctors/:id returns 403', async () => {
    const res = await request(app)
      .put(`/admin/doctors/${doctor.profileId}`)
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({ isActive: false });
    expect(res.status).toBe(403);
  });

  it('RB-4: patient DELETEing /admin/doctors/:id returns 403', async () => {
    const res = await request(app)
      .delete(`/admin/doctors/${doctor.profileId}`)
      .set('Authorization', `Bearer ${patient.accessToken}`);
    expect(res.status).toBe(403);
  });

  it('RB-5: patient POSTing leave returns 403', async () => {
    const res = await request(app)
      .post(`/admin/doctors/${doctor.profileId}/leave`)
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({ rangeStart: '2030-01-01', rangeEnd: '2030-01-01' });
    expect(res.status).toBe(403);
  });

  it('RB-6: patient DELETEing /admin/.../leave/:id returns 403', async () => {
    const res = await request(app)
      .delete(`/admin/doctors/${doctor.profileId}/leave/2030-01-01`)
      .set('Authorization', `Bearer ${patient.accessToken}`);
    expect(res.status).toBe(403);
  });

  it('RB-7: patient POSTing /visits/:id/notes returns 403 (doctor-only)', async () => {
    const res = await request(app)
      .post(`/visits/${bookingId}/notes`)
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({ notes: 'tamper' });
    expect(res.status).toBe(403);
  });

  it('RB-9: doctor-2 cannot cancel patient+doctor1 booking (NOT_OWNER)', async () => {
    const res = await request(app)
      .post(`/bookings/${bookingId}/cancel`)
      .set('Authorization', `Bearer ${doctor2.accessToken}`)
      .send({ reason: 'rbac test' });
    // doctor2 is the doctor of THIS test's booking? No — bookingId is doctor1's.
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('NOT_OWNER');
  });

  it('RB-10: patient-2 cannot cancel patient-1 booking (NOT_OWNER)', async () => {
    const res = await request(app)
      .post(`/bookings/${bookingId}/cancel`)
      .set('Authorization', `Bearer ${patient2.accessToken}`)
      .send({ reason: 'rbac test' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('NOT_OWNER');
  });

  it('RB-11: patient-2 cannot reschedule patient-1 booking (NOT_OWNER)', async () => {
    const res = await request(app)
      .post(`/bookings/${bookingId}/reschedule`)
      .set('Authorization', `Bearer ${patient2.accessToken}`)
      .send({ newHoldToken: 'irrelevant' });
    expect(res.status).toBe(403);
  });

  it('RB-12: unauthenticated /auth/me returns 401', async () => {
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
  });

  it('RB-13: unauthenticated /bookings/slots returns 401', async () => {
    const res = await request(app).get('/bookings/slots').query({ doctorId: 'x', date: '2030-01-01' });
    expect(res.status).toBe(401);
  });

  it('RB-14: unauthenticated /admin/doctors returns 401', async () => {
    const res = await request(app).get('/admin/doctors');
    expect(res.status).toBe(401);
  });

  it('RB-15: patient POSTing /visits/:id/notes returns 403', async () => {
    const res = await request(app)
      .post(`/visits/${bookingId}/notes`)
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({ notes: 'should be rejected' });
    expect(res.status).toBe(403);
  });

  it('RB-22: admin cannot directly cancel a patient+doctor booking (documented gap)', async () => {
    const res = await request(app)
      .post(`/bookings/${bookingId}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'admin bypass' });
    // Per I2(M4) gap: service-layer ownership check rejects admin today.
    // Status expected to be 403 (NOT_OWNER). If M4 gap is later closed the
    // test SHOULD fail loudly so we re-check our assumption list.
    expect(res.status).toBe(403);
  });
});
