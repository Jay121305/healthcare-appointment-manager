# PROJECT_STATE.md — Healthcare Appointment & Follow-up Manager

Tracks cross-module state. Read before starting any module.

## Stack (locked)
- Frontend: Next.js 14 App Router + TS + Tailwind → Vercel (Hobby)
- Backend: Node + Express + TS → Render (free Web Service, spins down after 15min, cold-start 30-60s — accepted)
- DB: PostgreSQL via Prisma → Neon (free scale-to-zero)
- Queue: Redis + BullMQ → Upstash (free, 256MB, 500K cmd/mo, ioredis TCP/TLS URL — NOT REST)
- Auth: self-implemented JWT with `role` claim
- Email: Resend (3000/mo, 100/day); fallback Brevo via Nodemailer/SMTP (NOT SendGrid)
- Calendar: Google Calendar API v3 + OAuth 2.0 via `googleapis`
- LLM: NVIDIA NIM (OpenAI-compatible @ https://integrate.api.nvidia.com/v1), ~40 req/min, called by deployed app only

## Rules (non-negotiable)
1. Three roles only: patient / doctor / admin. Server-side role + ownership checks.
2. No duplicate booking on (doctor_id, date, time) — DB UNIQUE constraint inside tx.
3. Doctor leave on a date with existing bookings → detect BEFORE commit, notify every patient.
4. Symptom form is the final step before Confirm. Booking write MUST NOT depend on/rollback for LLM/email/calendar — all three best-effort async.
5. LLM failure → 1 retry with backoff, then neutral fallback stored + shown. Never block/break.
6. Email (booking confirm/remind/cancel) to both patient + doctor, via queue w/ retry + visible failure state. Never sync in request handler.
7. Medication reminders computed by background job from prescription frequency, not on-demand.
8. Google Calendar events: create on booking, update on reschedule, delete on cancel. Failures never block/rollback booking.
9. Don't invent endpoints/fields/flows. State assumptions explicitly.
10. TS end-to-end, no `any` without a one-line justification comment.
11. Conflicting instruction → follow the rule above, flag the conflict in output.

## Module Status
- M1: DONE — VERIFIED (18 test cases, all pass, 1 tracked issue, 1 cleanup note)

## Regression Ledger (guarantees verified so far)
- M1: Auth enforces 3-role JWT with role + ownership checks server-side. JWT carries `{sub, role, iat, exp, jti}`, HS256 15-min access, 7-day rotating refresh with reuse detection. Middleware stack: authenticate → requireRoles(...) → requireOwnershipOrAdmin(loader). Signup creates user + profile in Prisma $transaction. argon2id password hashing, OWASP 2024 params. Seed bootstraps admin/doctor/patient. No runtime admin signup route. Booking UNIQUE constraint fields reserved on schema (doctor_id, booking_date, start_time). Partial index WHERE clause MUST be added via manual migration in bookings module.

## Tracked Issues (non-blocking, carry to M3/M4)
- R1: `bookings` UNIQUE constraint in schema.prisma:214 is standard `@@unique` — missing PostgreSQL partial index WHERE clause (`WHERE status IN ('CONFIRMED','RESCHEDULED')`). Must add raw SQL migration in bookings implementation module to match PROJECT_STATE.md design decision. Fields are correct; only the constraint type needs adjustment.
- R2: `jwt.ts:43-45` — `verifyRefreshTokenHash` is dead code (called nowhere, logic is wrong). Can be removed or fixed in a cleanup pass.

## Assumptions Log
- A1: `leave_days` as separate table (not JSON column) — KEPT. Schema confirms `LeaveDay` model with `@@unique([doctorId, leaveDate])`.
- A2: Partial unique index on bookings — FLAGGED. Schema has standard `@@unique`; partial WHERE clause must be added in bookings module **(R1).**
- A3: Times stored as UTC, single app timezone — KEPT. `booking_date` and `start_time` are `DateTime`; no per-doctor timezone.
- A4: Admin bootstrap via seed only — KEPT. No `/auth/signup/admin` route exists. Seed creates admin directly.
- A5: Email verification + forgot-password out of scope — KEPT. Not implemented.
- A6: Admin bypasses ownership only on admin endpoints — KEPT. `requireOwnershipOrAdmin` allows ADMIN to bypass entirely; caller must apply to admin-scoped routes only.
- A7: argon2id — KEPT. `passwordHash.ts` uses `argon2.argon2id` with `memoryCost:65536, timeCost:3, parallelism:4`.
- A8: OAuth tokens encrypted at rest — SCHEMA RESERVED. `oauth_tokens` model exists with `access_token`/`refresh_token` text fields; encryption logic is deferred to calendar module.

## Key decisions made in Module 1 (carry forward)
- Password hashing: argon2id (OWASP 2024). Flag if bcrypt required.
- JWT access = 15 min HS256; refresh = 7d opaque, hashed+stored, rotated w/ reuse detection.
- `leave_days` is its OWN table (not a JSON column on doctor_profiles) to support Rule 3 transactional conflict detection.
- `bookings` unique constraint = PARTIAL unique index on (doctor_id, booking_date, start_time) WHERE status IN ('CONFIRMED','RESCHEDULED'). Cancelled/completed rows do NOT block slot reuse.
- `notifications` table is durable audit copy of BullMQ email jobs; patched on lifecycle events (Rule 6 visible failure).
- `medication_reminders` rows precomputed by hourly cron + BullMQ repeat (Rule 7), `remind_at` stored so they survive Redis eviction.
- `calendar_events` holds up to 2 Google event ids (patient + doctor) per booking; patient needs own OAuth row to get a personal calendar event.
- LLM summaries (`pre_visit_summaries`, `post_visit_summaries`) have `llm_status` enum with explicit `FALLBACK` value (Rule 5).
- Admin bootstrap = seeded script (no self-signup). Admin bypasses ownership only on admin endpoints, NOT patient health-data reads (least privilege).
- OAuth tokens (`oauth_tokens`) encrypted at rest AES-256-GCM via env `OAUTH_TOKEN_ENC_KEY`.
- Times stored/compared in UTC; doctor `working_hours` JSON interpreted in single app tz `APP_TZ` (env).

## Reserved env vars (Module 1 touched these — keep stable)
- JWT_ACCESS_SECRET, JWT_REFRESH_SECRET (≥32 bytes hex)
- OAUTH_TOKEN_ENC_KEY (32 bytes, base64)
- APP_TZ (IANA tz, e.g. Asia/Kolkata)
- GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI
- DATABASE_URL (Neon format with `?sslmode=require`)

## Seed script credentials (one-time bootstrap, change in prod)
- Admin: admin@healthcare.local / AdminPass123!
- Doctor: doctor@healthcare.local / DoctorPass123!
- Patient: patient@healthcare.local / PatientPass123!

## Open assumptions to confirm with reviewer
- A5: email verification + forgot-password — treated as out of scope for Module 1.
- A6: admin no-default read on patient health data — confirm.
- A7: argon2id over bcrypt — confirm.
- A8: encrypt OAuth tokens at rest — confirm.
