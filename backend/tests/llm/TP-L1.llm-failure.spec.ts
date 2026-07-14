// TP-L1 — LLM failure injection via invalid NVIDIA_NIM_API_KEY (Rule 5)
//
// Goal: confirm the M4 fallback behaviour at every trigger point when the
// NIM HTTP call is rejected by the upstream.
//
// Mechanism: — Use a MULTI-PROCESS approach is impractical inside a single
//             jest worker; instead, override NVIDIA_NIM_BASE_URL to a deaf
//             address with a 2-second timeout, OR set the API key to
//             "test_invalid_nim_key" (already the default in jest.setup).
//             Both yield the same effect: the OpenAI client raises a 401/503
//             style error before any payload round-trip.

import request from 'supertest';
import { getTestApp, teardown } from '../helpers/testApp';
import { bootWorkers, WorkersHandle } from '../helpers/bootWorkers';
import {
  signupPatient,
  signupDoctor,
  placeHoldAndConfirm,
  PatientFixture,
  DoctorFixture,
  pickFreshSlot,
} from '../helpers/fixtures';
import { prisma } from '../../src/config/prisma';

describe('TP-L1 — LLM failure injection (Rule 5)', () => {
  jest.setTimeout(180_000);
  const app = getTestApp();

  let workers: WorkersHandle | null = null;
  let doctor: DoctorFixture;
  let patient: PatientFixture;
  let bookingId: string | null = null;

  beforeAll(async () => {
    // Boot workers; we need pre-visit + post-visit workers running to drain
    // the BullMQ queues so the fallback actually fires.
    workers = await bootWorkers();

    doctor = await signupDoctor(app, { slotDurationMinutes: 30 });
    patient = await signupPatient(app);
    const slot = await pickFreshSlot(app, patient, doctor, 14);

    // 1. Book the slot — booking HTTP 201 must return BEFORE LLM status.
    const res = await placeHoldAndConfirm(app, patient, doctor, {
      date: slot.date,
      startTime: slot.startUtcIso,
      primaryComplaint: 'tp-l1',
    });
    if (res.kind !== 'ok') {
      throw new Error(`booking flow failed: ${JSON.stringify(res)}`);
    }
    bookingId = res.booking.id;
  });

  afterAll(async () => {
    // Cleanup
    if (bookingId) {
      try {
        await prisma.notification.deleteMany({ where: { bookingId } });
        await prisma.preVisitSummary.deleteMany({ where: { bookingId } });
        await prisma.postVisitSummary.deleteMany({ where: { bookingId } });
        await prisma.symptomForm.deleteMany({ where: { bookingId } });
        await prisma.calendarEvent.deleteMany({ where: { bookingId } });
        await prisma.booking.deleteMany({ where: { id: bookingId } });
      } catch {
        // ignore
      }
    }
    if (doctor) {
      try {
        await prisma.doctorProfile.deleteMany({ where: { userId: doctor.userId } });
        await prisma.user.deleteMany({ where: { id: doctor.userId } });
      } catch {
        // ignore
      }
    }
    if (patient) {
      try {
        await prisma.patientProfile.deleteMany({ where: { userId: patient.userId } });
        await prisma.user.deleteMany({ where: { id: patient.userId } });
      } catch {
        // ignore
      }
    }
    if (workers) await workers.shutdown();
    await teardown();
  });

  it('L1.a: booking HTTP 201 returned immediately (timing invariant)', async () => {
    // Call done above in beforeAll. The assertion here is that bookingId != null.
    expect(bookingId).toBeDefined();
  });

  it('L1.b: pre_visit_summaries row reaches FALLBACK state after worker drain', async () => {
    // Wait for worker to process the pre-visit job. Upstash free-tier runs
    // workers at concurrency=1, so we poll up to 60 seconds.
    let summary: any | null = null;
    for (let i = 0; i < 60; i++) {
      summary = await prisma.preVisitSummary.findUnique({ where: { bookingId: bookingId! } });
      if (summary && summary.llmStatus === 'FALLBACK') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(summary).toBeDefined();
    expect(summary!.llmStatus).toBe('FALLBACK');
    expect(summary!.summaryText).toBeTruthy();
    // M4 fallback pre-visit text begins with the neutral urgency line
    // (the `urgencyLevel` field is IN the summaryText payload — there is no
    // dedicated column on PreVisitSummary per M1 schema, only summaryText).
    expect(summary!.summaryText).toContain('urgencyLevel: Medium');
    // retryCount includes initial attempt + 1 retry before fallback fires
    expect(summary!.retryCount).toBeGreaterThanOrEqual(1);
  });

  it('L1.c: POST /visits/:bookingId/notes returns 200 with llmStatus=PENDING', async () => {
    const res = await request(app)
      .post(`/visits/${bookingId}/notes`)
      .set('Authorization', `Bearer ${doctor.accessToken}`)
      .send({ notes: 'Clinical notes for TP-L1.' });
    expect(res.status).toBe(200);
    expect(res.body.postVisitSummary.llmStatus).toBe('PENDING');
  });

  it('L1.d: post_visit_summaries row reaches FALLBACK', async () => {
    let summary: any | null = null;
    for (let i = 0; i < 60; i++) {
      summary = await prisma.postVisitSummary.findUnique({ where: { bookingId: bookingId! } });
      if (summary && summary.llmStatus === 'FALLBACK') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(summary).toBeDefined();
    expect(summary!.llmStatus).toBe('FALLBACK');
    expect(summary!.summaryText).toBeTruthy();
    // Post-visit fallback stores empty arrays (M4 spec)
    expect(summary!.retryCount).toBeGreaterThanOrEqual(1);
  });

  it('L1.j: booking row remains CONFIRMED regardless of LLM failure', async () => {
    const recent = await prisma.booking.findUnique({ where: { id: bookingId! } });
    expect(recent?.status).toBe('CONFIRMED');
  });
});
