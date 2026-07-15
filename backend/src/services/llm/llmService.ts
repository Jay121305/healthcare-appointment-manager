// backend/src/services/llm/llmService.ts
// LLM integration service: prompts, validation, retry/fallback logic

import { z } from 'zod';
import { getNimClient } from './nimClient';
import { prisma } from '../../config/prisma';
import { LlmStatus } from '@prisma/client';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration (from env)
// ─────────────────────────────────────────────────────────────────────────────

export interface LlmServiceConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  backoffMs: number;
}

function getLlmConfig(): LlmServiceConfig {
  return {
    apiKey: process.env.NVIDIA_NIM_API_KEY!,
    baseURL: process.env.NVIDIA_NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    model: process.env.NVIDIA_NIM_MODEL || 'z-ai/glm-5.2',
    timeoutMs: parseInt(process.env.NVIDIA_NIM_TIMEOUT_MS || '30000', 10),
    maxRetries: 1, // Exactly one retry per Rule 5
    backoffMs: 2000,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Response schemas (zod)
// ─────────────────────────────────────────────────────────────────────────────

export const PreVisitResponseSchema = z.object({
  urgencyLevel: z.enum(['Low', 'Medium', 'High']),
  chiefComplaint: z.string().min(1).max(200),
  suggestedQuestions: z.array(z.string().min(1).max(200)).length(3),
});

export type PreVisitResponse = z.infer<typeof PreVisitResponseSchema>;

export const PostVisitResponseSchema = z.object({
  summaryText: z.string().min(1).max(1800),
  medicationSchedule: z.array(z.object({
    medication: z.string().min(1).max(200),
    schedule: z.string().min(1).max(300),
  })),
  followUpSteps: z.array(z.string().min(1).max(300)),
});

export type PostVisitResponse = z.infer<typeof PostVisitResponseSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Fallback content (Rule 5: graceful degradation)
// ─────────────────────────────────────────────────────────────────────────────

const PRE_VISIT_FALLBACK = `urgencyLevel: Medium
chiefComplaint: (unavailable — manual review required)
suggestedQuestions:
1. What is the main reason for today's visit?
2. How long have the symptoms been present?
3. Are there any new medications or recent changes?`;

const POST_VISIT_FALLBACK = `summary:
A patient-friendly summary could not be generated automatically at this time. Please refer to the doctor's notes below, or contact the clinic if anything is unclear.

medicationSchedule:
[]

followUpSteps:
[]`;

// ─────────────────────────────────────────────────────────────────────────────
// Prompt builders
// ─────────────────────────────────────────────────────────────────────────────

const PRE_VISIT_SYSTEM_PROMPT = `You are a clinical decision-support assistant. You analyse patient symptom information and produce a brief pre-visit summary that helps the doctor prepare. You are NOT a diagnostic device. Do not suggest a definitive diagnosis. Keep all content neutral and factual. Do not mention the patient's name, contact information, or identifiers — the intake is already anonymous.

Return ONLY a JSON object with the keys shown below. Do not emit reasoning, introduction, summary, or commentary. No Markdown fences. The JSON must be valid and complete on its own.`;

const PRE_VISIT_USER_PROMPT_TEMPLATE = `Analyse these symptoms and return: urgency level (Low / Medium / High), chief complaint, and three suggested questions for the doctor.

Return the result as a JSON object with exactly this schema:
{ "urgencyLevel": "Low" | "Medium" | "High", "chiefComplaint": string, "suggestedQuestions": [string, string, string] }

Rules:
- "urgencyLevel": MUST be one of "Low", "Medium", "High" — no other values.
- "chiefComplaint": one concise sentence, max 200 chars.
- "suggestedQuestions": EXACTLY three items, each a single question, max 200 chars each.
- The JSON object is your entire answer. No preamble, no postamble, no Markdown code fences.

Symptoms:
{symptoms}`;

const POST_VISIT_SYSTEM_PROMPT = `You are a health-literacy assistant. You convert a doctor's visit notes into a plain-language summary that the patient can understand. Replace jargon with everyday words where possible but do not invent medical facts or medication instructions that are not present in the notes. If something is absent, omit it rather than guessing.

Return ONLY a JSON object with the keys shown below. No Markdown fences, no commentary outside the JSON.`;

const POST_VISIT_USER_PROMPT_TEMPLATE = `Convert these clinical notes into a patient-friendly summary with medication schedule and follow-up steps.

Return the result as a JSON object with exactly this schema:
{
  "summaryText": string,
  "medicationSchedule": [{ "medication": string, "schedule": string }] | [],
  "followUpSteps": [string] | []
}

Rules:
- "summaryText": 1-3 plain-language paragraphs, each max 600 chars.
- "medicationSchedule": one entry per medication mentioned in the notes; if none mentioned, use an empty array []. Each "schedule" string should be the patient-readable instructions (e.g. "Take 1 tablet every morning after food").
- "followUpSteps": one string per distinct follow-up action mentioned; if none, use []. Each string max 300 chars.
- The JSON object is your entire answer. No Markdown fences, no preamble.

Notes:
{notes}`;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function stripJsonFences(text: string): string {
  // Handle accidental ```json ... ``` fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return text.trim();
}

function buildPreVisitSymptomText(symptomForm: {
  primaryComplaint: string;
  durationDays: number | null;
  severity: string | null;
  description: string | null;
  currentMedications: string[];
  allergies: string[];
}): string {
  const lines: string[] = [];
  lines.push(`Primary complaint: ${symptomForm.primaryComplaint}`);
  if (symptomForm.durationDays !== null) {
    lines.push(`Duration: ${symptomForm.durationDays} day(s)`);
  }
  if (symptomForm.severity) {
    lines.push(`Severity: ${symptomForm.severity}`);
  }
  if (symptomForm.description) {
    lines.push(`Description: ${symptomForm.description}`);
  }
  if (symptomForm.currentMedications.length > 0) {
    lines.push(`Current medications: ${symptomForm.currentMedications.join(', ')}`);
  }
  if (symptomForm.allergies.length > 0) {
    lines.push(`Allergies: ${symptomForm.allergies.join(', ')}`);
  }
  return lines.join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Core LLM call with retry + fallback
// ─────────────────────────────────────────────────────────────────────────────

async function callNimWithRetry<T>(
  messages: { role: 'system' | 'user'; content: string }[],
  schema: z.ZodSchema<T>
): Promise<{ data: T; retryCount: number; status: LlmStatus }> {
  const config = getLlmConfig();
  const client = getNimClient(config);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: config.model,
        messages,
        temperature: 0.3,
        max_tokens: 1200,
      });

      const rawContent = response.choices[0]?.message?.content;
      if (!rawContent) {
        throw new Error('Empty response from NIM');
      }

      const cleaned = stripJsonFences(rawContent);
      const parsed = JSON.parse(cleaned);
      const validated = schema.parse(parsed);

      return {
        data: validated,
        retryCount: attempt,
        status: LlmStatus.GENERATED,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // If this was the last attempt, break and fall through to fallback
      if (attempt === config.maxRetries) {
        break;
      }

      // Wait before retry
      await sleep(config.backoffMs);
    }
  }

  // All attempts failed — return fallback
  console.error('[LLM] All attempts failed, using fallback:', lastError?.message);
  return {
    data: { fallback: true } as T, // Will be replaced with actual fallback text in callers
    retryCount: config.maxRetries,
    status: LlmStatus.FALLBACK,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Follow-up Q&A — single-turn answer anchored on stored post-visit summary
// Plain text reply (no JSON schema), persisted as ChatMessage rows.
// ─────────────────────────────────────────────────────────────────────────────

const FOLLOWUP_SYSTEM_PROMPT = `You are a health-literacy assistant answering a patient's follow-up questions about their recent visit summary. You must:
- Only use information present in the provided visit summary and notes.
- If the answer is not in the provided context, say so honestly — do not invent medical facts, diagnoses, or dosages.
- Keep replies concise, plain-language, and patient-friendly.
- Never reference other patients' data or speculate about the patient's identity.
- If the question is urgent or suggests an emergency, advise the patient to contact their clinic or emergency services.

Visit summary context:
{context}`;

export const FOLLOWUP_MAX_TOKENS = 600;

export async function generateFollowUpAnswer(args: {
  bookingId: string;
  question: string;
  contextSummary: string;
  history: { role: 'user' | 'assistant'; content: string }[];
}): Promise<{ answer: string; status: LlmStatus }> {
  const config = getLlmConfig();
  const client = getNimClient(config);

  const systemContent = FOLLOWUP_SYSTEM_PROMPT.replace('{context}', args.contextSummary);

  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: systemContent },
    ...args.history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: args.question },
  ];

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: config.model,
        messages,
        temperature: 0.3,
        max_tokens: FOLLOWUP_MAX_TOKENS,
      });

      const rawContent = response.choices[0]?.message?.content;
      if (!rawContent) {
        throw new Error('Empty response from NIM');
      }

      const answer = rawContent.trim();

      // Persist the user question + assistant answer
      await prisma.chatMessage.createMany({
        data: [
          { bookingId: args.bookingId, role: 'user', content: args.question },
          { bookingId: args.bookingId, role: 'assistant', content: answer },
        ],
      });

      await prisma.booking.update({
        where: { id: args.bookingId },
        data: { followUpMessageCount: { increment: 1 } },
      });

      return { answer, status: LlmStatus.GENERATED };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === config.maxRetries) break;
      await sleep(config.backoffMs);
    }
  }

  console.error('[LLM] Follow-up failed, using fallback:', lastError?.message);
  return {
    answer: 'Sorry, I could not generate an answer right now. Please try again shortly, or contact the clinic if urgent.',
    status: LlmStatus.FALLBACK,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-visit summary generation
// ─────────────────────────────────────────────────────────────────────────────

export async function generatePreVisitSummary(
  bookingId: string,
  symptomForm: {
    primaryComplaint: string;
    durationDays: number | null;
    severity: string | null;
    description: string | null;
    currentMedications: string[];
    allergies: string[];
  }
): Promise<void> {
  const symptomText = buildPreVisitSymptomText(symptomForm);

  const messages = [
    { role: 'system' as const, content: PRE_VISIT_SYSTEM_PROMPT },
    { role: 'user' as const, content: PRE_VISIT_USER_PROMPT_TEMPLATE.replace('{symptoms}', symptomText) },
  ];

  const result = await callNimWithRetry(messages, PreVisitResponseSchema);

  // Format the validated response into the flat summaryText for storage
  let summaryText: string;
  if (result.status === LlmStatus.GENERATED) {
    const data = result.data as PreVisitResponse;
    summaryText = [
      `urgencyLevel: ${data.urgencyLevel}`,
      `chiefComplaint: ${data.chiefComplaint}`,
      'suggestedQuestions:',
      data.suggestedQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n'),
    ].join('\n');
  } else {
    summaryText = PRE_VISIT_FALLBACK;
  }

  // Update PreVisitSummary row
  await prisma.preVisitSummary.update({
    where: { bookingId },
    data: {
      summaryText,
      llmStatus: result.status,
      retryCount: result.retryCount,
      generatedAt: new Date(),
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-visit summary generation
// ─────────────────────────────────────────────────────────────────────────────

export async function generatePostVisitSummary(
  bookingId: string,
  doctorNotes: string
): Promise<void> {
  const messages = [
    { role: 'system' as const, content: POST_VISIT_SYSTEM_PROMPT },
    { role: 'user' as const, content: POST_VISIT_USER_PROMPT_TEMPLATE.replace('{notes}', doctorNotes) },
  ];

  const result = await callNimWithRetry(messages, PostVisitResponseSchema);

  let summaryText: string;
  if (result.status === LlmStatus.GENERATED) {
    const data = result.data as PostVisitResponse;
    const medLines = data.medicationSchedule.length > 0
      ? data.medicationSchedule.map(m => `- ${m.medication} | ${m.schedule}`).join('\n')
      : '[]';
    const followUpLines = data.followUpSteps.length > 0
      ? data.followUpSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')
      : '[]';

    summaryText = [
      'summary:',
      data.summaryText,
      '',
      'medicationSchedule:',
      medLines,
      '',
      'followUpSteps:',
      followUpLines,
    ].join('\n');
  } else {
    summaryText = POST_VISIT_FALLBACK;
  }

  // Update PostVisitSummary row
  await prisma.postVisitSummary.update({
    where: { bookingId },
    data: {
      summaryText,
      llmStatus: result.status,
      retryCount: result.retryCount,
      generatedAt: new Date(),
    },
  });
}