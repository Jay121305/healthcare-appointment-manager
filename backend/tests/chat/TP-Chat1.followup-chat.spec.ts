// TP-Chat1 — Follow-up Q&A on post-visit summary (Rule 4/5)
//
// Goal: verify chat endpoints behave correctly:
// - patient can ask follow-up questions (capped at 5)
// - doctor can regenerate summary (clears chat history)
// - ownership enforced (403 for wrong patient/doctor)
// - cap enforcement returns 429
// - regenerate clears chat messages and resets counter

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

describe('TP-Chat — Follow-up Q&A on post-visit summary', () => {
  jest.setTimeout(180_000);
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

    const res = await placeHoldAndConfirm(app, patient, doctor, {
      date: slot.date,
      startTime: slot.startUtcIso,
      primaryComplaint: 'tp-chat follow-up',
    });
    if (res.kind !== 'ok') {
      throw new Error(`booking flow failed: ${JSON.stringify(res)}`);
    }
    bookingId = res.booking.id;

    // Wait for post-visit summary to be GENERATED (or FALLBACK) by worker
    let summary: any | null = null;
    for (let i = 0; i < 60; i++) {
      summary = await prisma.postVisitSummary.findUnique({ where: { bookingId: bookingId! } });
      if (summary && summary.llmStatus !== 'PENDING') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!summary || summary.llmStatus === 'PENDING') {
      throw new Error('Post-visit summary did not reach GENERATED/FALLBACK in time');
    }
  });

  afterAll(async () => {
    if (bookingId) {
      try {
        await prisma.chatMessage.deleteMany({ where: { bookingId } });
        await prisma.postVisitSummary.deleteMany({ where: { bookingId } });
        await prisma.notification.deleteMany({ where: { bookingId } });
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

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. GET /chat/:bookingId/messages — returns empty initially, 403 for strangers
  // ─────────────────────────────────────────────────────────────────────────────

  it('Chat1.a: GET messages returns empty array for patient', async () => {
    const res = await request(app)
      .get(`/chat/${bookingId}/messages`)
      .set('Authorization', `Bearer ${patient.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.followUpCount).toBe(0);
    expect(res.body.remainingQuestions).toBe(5);
    expect(res.body.maxQuestions).toBe(5);
  });

  it('Chat1.b: GET messages returns 403 for unrelated patient', async () => {
    const otherPatient = await signupPatient(app);
    const res = await request(app)
      .get(`/chat/${bookingId}/messages`)
      .set('Authorization', `Bearer ${otherPatient.accessToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('NOT_AUTHORIZED');
    // cleanup
    await prisma.user.delete({ where: { id: otherPatient.userId } });
  });

  it('Chat1.c: GET messages returns 403 for unrelated doctor', async () => {
    const otherDoctor = await signupDoctor(app);
    const res = await request(app)
      .get(`/chat/${bookingId}/messages`)
      .set('Authorization', `Bearer ${otherDoctor.accessToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('NOT_AUTHORIZED');
    // cleanup
    await prisma.doctorProfile.deleteMany({ where: { userId: otherDoctor.userId } });
    await prisma.user.delete({ where: { id: otherDoctor.userId } });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. POST /chat/:bookingId/message — patient asks follow-up questions
  // ─────────────────────────────────────────────────────────────────────────────

  it('Chat2.a: patient can ask a follow-up question (returns answer, decrements remaining)', async () => {
    const res = await request(app)
      .post(`/chat/${bookingId}/message`)
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({ question: 'What medications was I prescribed?' });
    expect(res.status).toBe(200);
    expect(res.body.answer).toBeDefined();
    expect(typeof res.body.answer).toBe('string');
    expect(res.body.answer.length).toBeGreaterThan(0);
    expect(res.body.llmStatus).toMatch(/^(GENERATED|FALLBACK)$/);
    expect(res.body.remainingQuestions).toBe(4);
    expect(res.body.maxQuestions).toBe(5);
  });

  it('Chat2.b: second question works and remainingQuestions decrements', async () => {
    const res = await request(app)
      .post(`/chat/${bookingId}/message`)
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({ question: 'When should I take my next dose?' });
    expect(res.status).toBe(200);
    expect(res.body.remainingQuestions).toBe(3);
  });

  it('Chat2.c: questions persist in history — GET messages shows both', async () => {
    const res = await request(app)
      .get(`/chat/${bookingId}/messages`)
      .set('Authorization', `Bearer ${patient.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.messages.length).toBeGreaterThanOrEqual(2);
    const userMessages = res.body.messages.filter((m: any) => m.role === 'user');
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
  });

  it('Chat2.d: doctor cannot POST follow-up questions (403)', async () => {
    const res = await request(app)
      .post(`/chat/${bookingId}/message`)
      .set('Authorization', `Bearer ${doctor.accessToken}`)
      .send({ question: 'Doctor asking' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('Chat2.e: empty question returns 400', async () => {
    const res = await request(app)
      .post(`/chat/${bookingId}/message`)
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({ question: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('QUESTION_REQUIRED');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Cap enforcement — after 5 questions, returns 429
  // ─────────────────────────────────────────────────────────────────────────────

  it('Chat3: cap enforcement at 5 questions returns 429', async () => {
    // We've asked 2 questions so far. Ask 3 more to hit the cap.
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post(`/chat/${bookingId}/message`)
        .set('Authorization', `Bearer ${patient.accessToken}`)
        .send({ question: `Follow-up question ${i + 3}` });
      expect(res.status).toBe(200);
    }

    // 6th question should be rejected
    const res = await request(app)
      .post(`/chat/${bookingId}/message`)
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({ question: 'This should fail' });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('CAP_REACHED');
    expect(res.body.message).toContain('maximum');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Regenerate summary — doctor only, clears chat history
  // ─────────────────────────────────────────────────────────────────────────────

  it('Chat4.a: doctor can regenerate summary', async () => {
    const res = await request(app)
      .post(`/chat/${bookingId}/regenerate`)
      .set('Authorization', `Bearer ${doctor.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('cleared');
    expect(res.body.llmStatus).toBe('PENDING');
  });

  it('Chat4.b: regenerate clears chat history and resets counter', async () => {
    const res = await request(app)
      .get(`/chat/${bookingId}/messages`)
      .set('Authorization', `Bearer ${patient.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.followUpCount).toBe(0);
    expect(res.body.remainingQuestions).toBe(5);
  });

  it('Chat4.c: patient cannot regenerate summary (403)', async () => {
    // First, doctor needs to submit notes again so there's something to regenerate
    await request(app)
      .post(`/visits/${bookingId}/notes`)
      .set('Authorization', `Bearer ${doctor.accessToken}`)
      .send({ notes: 'Updated clinical notes for regenerate test.' });

    const res = await request(app)
      .post(`/chat/${bookingId}/regenerate`)
      .set('Authorization', `Bearer ${patient.accessToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('Chat4.d: unrelated doctor cannot regenerate (403)', async () => {
    const otherDoctor = await signupDoctor(app);
    const res = await request(app)
      .post(`/chat/${bookingId}/regenerate`)
      .set('Authorization', `Bearer ${otherDoctor.accessToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('NOT_OWNER');
    // cleanup
    await prisma.doctorProfile.deleteMany({ where: { userId: otherDoctor.userId } });
    await prisma.user.delete({ where: { id: otherDoctor.userId } });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Booking row remains CONFIRMED regardless of chat/regenerate operations
  // ─────────────────────────────────────────────────────────────────────────────

  it('Chat5: booking status remains CONFIRMED after chat operations', async () => {
    const booking = await prisma.booking.findUnique({ where: { id: bookingId! } });
    expect(booking?.status).toBe('CONFIRMED');
  });
});