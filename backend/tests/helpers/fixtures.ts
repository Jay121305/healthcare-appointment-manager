// tests/helpers/fixtures.ts
// Cross-cutting fixtures: signup/login, working-hours scaffold, target-slot helpers.
// Mirrors what TP-0 calls "Test Resources" — every helper stays inside the
// locked M1-M6 API surface; nothing here invents new endpoints.

import request from 'supertest';
import type { Express } from 'express';
import { prisma } from '../../src/config/prisma';

export interface PatientFixture {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
  password: string;
  fullName: string;
  profileId: string;
}

export interface DoctorFixture {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
  password: string;
  fullName: string;
  profileId: string;
  specialisation: string;
  workingHours: Record<string, { start: string; end: string } | null>;
  slotDurationMinutes: number;
}

export interface AdminFixture {
  accessToken: string;
  refreshToken?: string;
  userId: string;
  email: string;
  password: string;
}

const STRONG_PASSWORD = 'StrongP@ssw0rd!';

export async function signupPatient(
  app: Express,
  opts: Partial<{ email: string; password: string; fullName: string }> = {}
): Promise<PatientFixture> {
  const email = (opts.email ?? `test+${Date.now()}-${Math.random().toString(36).slice(2, 6)}@healthcare.local`).toLowerCase();
  const password = opts.password ?? STRONG_PASSWORD;
  const fullName = opts.fullName ?? `Test Patient ${email}`;
  const res = await request(app).post('/auth/signup/patient').send({ email, password, fullName });
  if (res.status !== 201 || !res.body.accessToken) {
    throw new Error(`patient signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  // Resolve profile id from DB — the signup response shape doesn't currently expose `profile.id`,
  // only the embedded profile object. We re-read deterministically by user id.
  const profile = await prisma.patientProfile.findUnique({ where: { userId: res.body.user.id } });
  if (!profile) throw new Error('profile not found after signup (unexpected)');
  return {
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    userId: res.body.user.id,
    email,
    password,
    fullName,
    profileId: profile.id,
  };
}

export async function signupDoctor(
  app: Express,
  opts: Partial<{
    email: string;
    password: string;
    fullName: string;
    specialisation: string;
    slotDurationMinutes: number;
    phone: string;
  }> = {}
): Promise<DoctorFixture> {
  const email = (opts.email ?? `doctor+${Date.now()}-${Math.random().toString(36).slice(2, 6)}@healthcare.local`).toLowerCase();
  const password = opts.password ?? STRONG_PASSWORD;
  const fullName = opts.fullName ?? `Dr. Test ${email}`;
  const specialisation = opts.specialisation ?? 'General Medicine';
  const slotDurationMinutes = opts.slotDurationMinutes ?? 30;
  const phone = opts.phone ?? '+10000000000';

  // Working hours covering 7 days, 09:00–17:00 UTC.
  const workingHours = {
    mon: { start: '09:00', end: '17:00' },
    tue: { start: '09:00', end: '17:00' },
    wed: { start: '09:00', end: '17:00' },
    thu: { start: '09:00', end: '17:00' },
    fri: { start: '09:00', end: '17:00' },
    sat: { start: '09:00', end: '17:00' },
    sun: { start: '09:00', end: '17:00' },
  };

  // Doctor signup is via POST /admin/doctors (admin-only), not a public doctor
  // signup route. We bootstrap an admin via the seed, then create the doctor
  // through the admin endpoint.
  const adminEmail = process.env.TEST_ADMIN_EMAIL ?? 'admin@healthcare.local';
  const adminPwd = process.env.TEST_ADMIN_PASSWORD ?? 'AdminPass123!';
  // Try existing seed admin first, fall back to direct DB insert if not present.
  let adminLogin: { accessToken: string; refreshToken: string; userId: string };
  try {
    adminLogin = await login(app, adminEmail, adminPwd, 'ADMIN');
  } catch {
    const { hashPassword } = await import('../../src/utils/passwordHash');
    const realHash = await hashPassword(adminPwd);
    await prisma.user.upsert({
      where: { email: adminEmail },
      update: { passwordHash: realHash, isActive: true, role: 'ADMIN' },
      create: {
        email: adminEmail,
        passwordHash: realHash,
        role: 'ADMIN',
        isActive: true,
      },
    });
    adminLogin = await login(app, adminEmail, adminPwd, 'ADMIN');
  }
  const admin: AdminFixture = {
    ...adminLogin,
    email: adminEmail,
    password: adminPwd,
  };

  const res = await request(app)
    .post('/admin/doctors')
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .send({ email, password, fullName, specialisation, workingHours, slotDurationMinutes, phone });
  if (res.status !== 201) {
    throw new Error(`admin doctor create failed: ${res.status} ${JSON.stringify(res.body)}`);
  }

  // Re-login as the doctor to get the doctor access token (admin endpoint doesn't return JWTs).
  const loginRes = await login(app, email, password, 'DOCTOR');
  const profile = await prisma.doctorProfile.findUnique({ where: { userId: loginRes.userId } });
  if (!profile) throw new Error('doctor profile not found after signup (unexpected)');

  return {
    accessToken: loginRes.accessToken,
    refreshToken: loginRes.refreshToken,
    userId: loginRes.userId,
    email,
    password,
    fullName,
    profileId: profile.id,
    specialisation,
    workingHours,
    slotDurationMinutes,
  };
}

export async function login(
  app: Express,
  email: string,
  password: string,
  expectedRole: 'PATIENT' | 'DOCTOR' | 'ADMIN'
): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  const res = await request(app).post('/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  if (!res.body.user) throw new Error(`login response missing user: ${JSON.stringify(res.body)}`);
  // Role is stable in seed/db, but we accept either the JWT's role OR the body user.role.
  if (res.body.user.role !== expectedRole) {
    throw new Error(`login expected ${expectedRole} but got ${res.body.user.role}`);
  }
  return {
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    userId: res.body.user.id,
  };
}

/**
 * Return a future weekday YYYY-MM-DD string on which the doctor is working.
 * `daysAhead` defaults to 14 to avoid weekend/operating-hour flakiness.
 *
 * NOTE: For repeatability we walk to a fixed offset workdays; the calendar test
 * for the M2 leave flow uses a separate helper that allows a specific date.
 */
export function futureWorkingDate(daysAhead: number = 14): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  // Push to next Monday if the offset lands on a Sunday (idx 0).
  while (d.getUTCDay() === 0) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function isoFromYmdAndHm(ymdStr: string, hh: number, mm: number = 0): Date {
  const [y, m, d] = ymdStr.split('-').map((s) => Number(s));
  return new Date(Date.UTC(y, m - 1, d, hh, mm, 0, 0));
}

/**
 * Find fresh future slots for the doctor. We re-use `GET /bookings/slots?doctorId=...&date=...`.
 * Returns up to `count` DISTINCT slots on the same day, none of which has a prior booking.
 */
export async function pickFreshSlots(
  app: Express,
  patient: PatientFixture,
  doctor: DoctorFixture,
  count: number,
  daysAhead: number = 14
): Promise<Array<{ date: string; startUtcIso: string; endUtcIso: string }>> {
  const d = futureWorkingDate(daysAhead);
  const dateStr = ymd(d);
  let res = await request(app)
    .get(`/bookings/slots`)
    .query({ doctorId: doctor.profileId, date: dateStr })
    .set('Authorization', `Bearer ${patient.accessToken}`);
  if (res.status !== 200) {
    // Some days have no slots at all — walk forward until we find a day with at least `count`.
    let attempts = 0;
    while (res.status !== 200 && attempts < 14) {
      d.setUTCDate(d.getUTCDate() + 1);
      res = await request(app)
        .get(`/bookings/slots`)
        .query({ doctorId: doctor.profileId, date: ymd(d) })
        .set('Authorization', `Bearer ${patient.accessToken}`);
      attempts++;
    }
  }
  const slots: Array<{ startUTC: string; endUTC: string; available: boolean }> = res.body.slots ?? [];
  const available = slots.filter((s) => s.available).slice(0, count);
  if (available.length < count) {
    throw new Error(`needed ${count} available slots on the same day for doctor ${doctor.email}, found ${available.length}; bump daysAhead or extend working hours`);
  }
  const dateOut = ymd(d);
  return available.map((s) => ({ date: dateOut, startUtcIso: s.startUTC, endUtcIso: s.endUTC }));
}

/**
 * Back-compat single-slot variant.
 */
export async function pickFreshSlot(
  app: Express,
  patient: PatientFixture,
  doctor: DoctorFixture,
  daysAhead: number = 14
): Promise<{ date: string; startUtcIso: string; endUtcIso: string }> {
  const [s] = await pickFreshSlots(app, patient, doctor, 1, daysAhead);
  return s;
}

/**
 * Run the full booking flow up to confirm and return the BookingResponse or
 * the raw errors, for HTTP200/201 paths and HTTP error paths respectively.
 */
export async function placeHoldAndConfirm(
  app: Express,
  patient: PatientFixture,
  doctor: DoctorFixture,
  args: { date: string; startTime: string; primaryComplaint?: string; ttlSeconds?: number }
): Promise<
  | { kind: 'ok'; holdToken: string; booking: any }
  | { kind: 'error'; status: number; body: any; stage: 'hold' | 'symptom' | 'confirm'; holdToken?: string }
> {
  const holdRes = await request(app)
    .post('/bookings/holds')
    .set('Authorization', `Bearer ${patient.accessToken}`)
    .send({
      doctorId: doctor.profileId,
      date: args.date,
      startTime: args.startTime,
      ttlSeconds: args.ttlSeconds ?? 300,
    });
  if (holdRes.status !== 201) {
    return { kind: 'error', status: holdRes.status, body: holdRes.body, stage: 'hold' };
  }
  const holdToken = holdRes.body.holdToken;
  const symptomRes = await request(app)
    .post(`/bookings/${holdToken}/symptom-form`)
    .set('Authorization', `Bearer ${patient.accessToken}`)
    .send({ primaryComplaint: args.primaryComplaint ?? 'test', severity: 'MILD' });
  if (symptomRes.status !== 200) {
    return { kind: 'error', status: symptomRes.status, body: symptomRes.body, stage: 'symptom', holdToken };
  }
  const confirmRes = await request(app)
    .post(`/bookings/${holdToken}/confirm`)
    .set('Authorization', `Bearer ${patient.accessToken}`)
    .send({});
  if (confirmRes.status !== 201) {
    return { kind: 'error', status: confirmRes.status, body: confirmRes.body, stage: 'confirm', holdToken };
  }
  return { kind: 'ok', holdToken, booking: confirmRes.body };
}
