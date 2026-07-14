# Healthcare Appointment & Follow-up Manager

A full-stack appointment booking, pre/post-visit LLM summarisation, email
notification, medication reminder, and Google Calendar sync system for a
three-portal (patient / doctor / admin) healthcare app. Built entirely on
permanent free-tier services — no paid plans anywhere.

## Stack (locked)

| Layer | Tech | Hosting (all free) |
|---|---|---|
| Frontend | Next.js 14 App Router + TS strict + Tailwind 3 + `@tanstack/react-query@5` | Vercel Hobby |
| Backend  | Node + Express + TS | Render free Web Service |
| DB      | PostgreSQL via Prisma | Neon (scale-to-zero) |
| Queue   | Redis + BullMQ via ioredis TCP/TLS | Upstash (256 MB / 500 K cmd per mo) |
| Auth    | Self-implemented JWT (HS256, 15-min access + 7-day rotating refresh) | — |
| Email   | Resend SDK (3000/mo, 100/day) | Resend free |
| Calendar | Google Calendar API v3 + OAuth 2.0 via `googleapis@^144` | Google Cloud (free) |
| LLM     | NVIDIA NIM (OpenAI-compatible `openai` SDK at `https://integrate.api.nvidia.com/v1`) | NVIDIA free tier (~40 req/min) |

## Repo layout

```
.
├── backend/                # Express + Prisma + BullMQ workers
│   ├── prisma/
│   │   ├── schema.prisma   # 13 models, 10 enums — see "DB Schema" below
│   │   ├── seed.ts         # bootstrap admin / doctor / patient accounts
│   │   └── migrations/
│   │       └── 001_add_partial_unique_index/migration.sql   # Rule 2 (manual SQL, not tracked by Prisma)
│   ├── src/
│   │   ├── config/         # env, prisma client, redis client, queue names
│   │   ├── middleware/     # authenticate, requireRoles, requireOwnershipOrAdmin
│   │   ├── routes/         # auth, booking, admin/doctors, calendar, visits
│   │   ├── services/
│   │   │   ├── booking/    # bookingService.ts (Rule 2, 3, 4)
│   │   │   ├── llm/        # llmService.ts + nimClient.ts (Rule 5)
│   │   │   ├── calendar/   # calendarService.ts + oauthService.ts + encryption.ts (Rule 8)
│   │   │   ├── notification/ # notificationService.ts (templates)
│   │   │   ├── leaveService.ts     # Rule 3
│   │   │   ├── slotService.ts      # Rule 4 (live slots + advisory hold check)
│   │   │   ├── doctorService.ts
│   │   │   └── medicationScheduler.ts  # Rule 7
│   │   ├── workers/        # 7 BullMQ workers (email, preVisit, postVisit,
│   │   │                  #   reminderScan, medicationReminder, medicationExpansion,
│   │   │                  #   calendarSync)
│   │   ├── utils/          # jwt.ts, passwordHash.ts (argon2id)
│   │   └── index.ts        # createApp() factory + bootstrap() runner
│   └── tests/              # M8 Jest+Supertest suite (7 specs / 36 tests)
│
├── frontend/               # Next.js 14 App Router — 23 pages, 3 portals
│   └── app/
│       ├── (public)/       # /login /signup/patient
│       ├── patient/        # /patient/dashboard /patient/doctors /patient/book/[doctorId]
│       ├── doctor/         # /doctor/dashboard /doctor/appointments/[id]/notes
│       ├── admin/          # /admin/dashboard /admin/doctors/[id]/leave/new
│       └── middleware.ts   # Edge role-cookie redirect (non-authoritative)
│
├── PROJECT_STATE.md        # cross-module ledger — READ BEFORE STARTING ANY MODULE
└── .env.example            # see "Environment variables" below
```

## Setup — local dev

```bash
# 1. Clone & install
git clone <repo-url> healthcare-app && cd healthcare-app
cd backend  && npm install
cd ../frontend && npm install

# 2. Provision the three free-tier services
#    Neon:    create a DB, copy the connection string with ?sslmode=require
#    Upstash: create a DB, copy the "Endpoint" + "Token" → rediss://default:TOKEN@HOST:6379
#    Resend:  verify your sending domain, copy re_... API key
#    NVIDIA:  create a NVIDIA NGC account, generate an NIM API key (nvapi-…)
#    Google:  see "Google Calendar OAuth setup" below — needs CLIENT_ID, SECRET, REDIRECT_URI

# 3. Generate JWT secrets + OAuth encryption key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # JWT_ACCESS_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # JWT_REFRESH_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # OAUTH_TOKEN_ENC_KEY

# 4. Configure env (single canonical .env.example at repo root)
cp .env.example backend/.env
# edit backend/.env with the values from steps 2-3

cd backend
npm run db:generate     # prisma generate
npm run db:push         # prisma db push (creates all 18 tables on Neon)

# 5. Apply the partial-unique-index migration (manual — not tracked by Prisma)
# The schema's @@unique is non-partial; R1 migration in
# prisma/migrations/001_add_partial_unique_index/migration.sql must be run
# once against Neon so cancelled rows stop blocking slot reuse.
# Run from backend/:
psql "$DATABASE_URL" -f prisma/migrations/001_add_partial_unique_index/migration.sql

# 6. Seed demo accounts (admin / doctor / patient)
npm run db:seed

# 7. Run
npm run dev             # backend on :3001 via tsx watch src/index.ts
#    in another terminal:
cd ../frontend && npm run dev   # Next.js on :3000
```

Open http://localhost:3000 → login with `admin@healthcare.local / AdminPass123!`.

## Deploy — Vercel + Render (free)

**Backend (Render)**:
1. New Web Service → connect repo → root `backend/` → build `npm install && npm run build` → start `npm start`
2. Render's dashboard "Environment" tab — paste every var from `backend/.env`.
   Set `FRONTEND_URL=https://your-frontend.vercel.app` and
   `GOOGLE_OAUTH_REDIRECT_URI=https://your-backend.onrender.com/calendar/callback`.
3. Render free tier spins down after 15 min idle (cold start 30-60s). BullMQ
   workers (RemindScan, MedicationExpansion) run on the *same* process as
   the Express server, so they pause during spin-down — accepted.

**Frontend (Vercel)**:
1. New Project → connect repo → root `frontend/`
2. Set `NEXT_PUBLIC_API_URL=https://your-backend.onrender.com`
3. Deploy. 15 static + 7 dynamic routes, 26.7 kB middleware.

**DB (Neon)**: apply the partial-unique-index migration (Step 5 above) against
the Neon branch's `DATABASE_URL` so cancelled/completed bookings stop blocking
slot reuse. Without this, the schema's non-partial `@@unique` keeps cancelled
rows in the index.

## Environment variables

Every variable is documented in `.env.example` at the repo root — see that
file for one-line descriptions, defaults, and where it is consumed in source.

Categories:
- Neon: `DATABASE_URL`
- Upstash: `UPSTASH_REDIS_TLS_URL`
- JWT: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`
- NIM: `NVIDIA_NIM_API_KEY`, `NVIDIA_NIM_MODEL`, optional `NVIDIA_NIM_BASE_URL`, `NVIDIA_NIM_TIMEOUT_MS`
- Resend: `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`, optional `EMAIL_DAILY_CAP`
- Google: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, `OAUTH_TOKEN_ENC_KEY`, optional `CALENDAR_WORKER_CONCURRENCY`, `FRONTEND_OAUTH_RETURN_URL`
- Booking tunables: `BOOKING_HOLD_TTL_SECONDS`, `BOOKING_CANCEL_CUTOFF_HOURS`, `APP_TZ`
- App: `NODE_ENV`, `PORT`, `FRONTEND_URL`
- Frontend: `NEXT_PUBLIC_API_URL` (primary; `NEXT_PUBLIC_API_BASE_URL` legacy fallback)
- Test-only: `TEST_ADMIN_EMAIL`, `TEST_ADMIN_PASSWORD`

Known drift (tracked in PROJECT_STATE.md I-issue):
- `EMAIL_WORKER_CONCURRENCY` is documented in .env.example but NOT honoured by
  `emailWorker.ts` (hardcoded `concurrency: 3` on line 154). Leaving the var
  in .env.example with a comment; a follow-up PR should either wire it or drop it.

## API docs

`authenticate` = JWT Bearer header; `requireRoles(...)` enforces one of the
three roles server-side (Rule 1). Ownership of the `(bookingId)` resource is
re-checked at the service layer against `booking.patient.user.id` /
`booking.doctor.user.id` for cancel/reschedule.

### Auth (`/auth`)

| Method | Path | Auth |
|---|---|---|
| POST   | /auth/signup/patient | PUBLIC (open patient self-signup) |
| POST   | /auth/signup/doctor  | PUBLIC — seed-only convenience; production creates doctors via `POST /admin/doctors` |
| POST   | /auth/login          | PUBLIC — returns `{accessToken, refreshToken, user}` |
| POST   | /auth/refresh        | PUBLIC — body `{refreshToken}`; rotates refresh token, detects reuse |
| POST   | /auth/logout         | JWT — invalidates the refresh token family |
| GET    | /auth/me             | JWT — returns the current user's profile |

### Booking (`/bookings`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET    | /bookings/slots | JWT | Query `doctorId`, `date` (YYYY-MM-DD). Returns the M2 live-computed slot grid with `available` flag per slot. |
| POST   | /bookings/holds | JWT PATIENT | Body `{doctorId, date, startTime, ttlSeconds?}`. Requires available slot, creates Redis hold `bh:{doctorId}:{dateIso}:{startTimeIso}` with NX + EX. Returns `{holdToken}`. |
| POST   | /bookings/:holdToken/symptom-form | JWT PATIENT | Final step before confirm (Rule 4). Body `{primaryComplaint, durationDays?, severity?, description?, currentMedications?, allergies?}`. Stored in Redis under `form:{holdToken}` until confirm. |
| POST   | /bookings/:holdToken/confirm | JWT PATIENT | Inside a `prisma.$transaction`: writes the Booking+SymptomForm+PreVisitSummary(PENDING) atomically; the DB partial unique index rejects duplicates with 409 SLOT_ALREADY_BOOKED (Rule 2). After tx commit, fires async triggers (LLM/email/calendar) `void` and un-awaited (Rule 4). |
| POST   | /bookings/:bookingId/cancel | JWT PATIENT,DOCTOR,ADMIN | Service-level ownership check (admin initiator rejected — documented gap I2(M4)). Body `{reason?}`. Booking row kept (status=CANCELLED); email + calendar delete fire async. |
| POST   | /bookings/:bookingId/reschedule | JWT PATIENT,DOCTOR,ADMIN | Same ownership rule. Body `{newDate, newStartTime}`. Old booking → RESCHEDULED, new booking row created. Email + calendar fire async as delete-old + create-new (Rule 8). |

### Admin (`/admin/doctors`) — every route requires JWT ADMIN

| Method | Path | Notes |
|---|---|---|
| POST   | /admin/doctors              | create doctor profile (email, password, fullName, specialisation, workingHours, slotDurationMinutes, phone) |
| GET    | /admin/doctors?search=&specialisation=  | paginated list |
| GET    | /admin/doctors/:id           | full profile |
| PUT    | /admin/doctors/:id           | edit profile / working-hours / soft-delete flag |
| DELETE | /admin/doctors/:id           | soft delete — rejects with `UPCOMING_BOOKINGS_EXIST` if active bookings remain |
| GET    | /admin/doctors/:id/slots     | slot preview for the admin UI |
| POST   | /admin/doctors/:id/leave     | Rule 3 endpoint. Body `{rangeStart, rangeEnd, reason?, dryRun, conflictResolution}`. `dryRun=true` returns the conflict list with zero side effects (PREVIEW); `dryRun=false` with `conflictResolution='AUTO_CANCEL'` atomically inserts the `LeaveDay` row, sets conflicting bookings to CANCELLED, and enqueues notifications to every affected patient + doctor notice. |
| GET    | /admin/doctors/:id/leave     | list leave days |
| DELETE | /admin/doctors/:id/leave/:leaveId | delete a leave day |

### Visits (`/visits`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST   | /visits/:bookingId/notes   | JWT DOCTOR | Body `{notes}`. Upserts PostVisitSummary in PENDING, queues an LLM job on the `post-visit-summary` queue, and (Rule 7) parses prescription frequency strings from the DB `prescriptions` table → creates `medication_reminders` rows + delayed BullMQ jobs. **Prescriptions are read from the DB, NOT from the request body.** |
| GET    | /visits/:bookingId/summary | JWT PATIENT,DOCTOR | Returns the PostVisitSummary for the booking. Response shape: `{bookingId, summaryText, llmStatus, retryCount, generatedAt, doctorNotes?}` (doctor-only sees raw `doctorNotes`). **Note:** frontend `api.getPostVisitSummary` calls `/visits/:id/post-summary` (plural suffix) — **this 404s**; the real endpoint is `/visits/:bookingId/summary`. |

### Calendar (`/calendar`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET    | /calendar/connect    | JWT PATIENT,DOCTOR | returns `{redirectUrl}` for the browser to follow. Mints a single-use CSRF `state` stored under `oauth_state:{state}` in Redis with TTL 600s. |
| GET    | /calendar/callback   | PUBLIC              | reached by Google's top-level browser GET after consent. State validated against Redis (consumed on use — replay attacker reusing the URL gets a 400), reconstructs the user identity from the matched state payload, and calls `OAuth2Client.getToken(code)` to exchange the code for tokens, AES-256-GCM encrypts, upserts `OauthToken`, returns HTML stub + optional `FRONTEND_OAUTH_RETURN_URL` redirect. |
| POST   | /calendar/disconnect | JWT PATIENT,DOCTOR | best-effort `revokeToken`, deletes the local `OauthToken` row regardless. |
| GET    | /calendar/status     | JWT PATIENT,DOCTOR | returns `{connected, connectedAt, googleEmail}`. |

## DB schema summary

13 models, 10 enums on PostgreSQL (Neon). Times stored/compared in UTC.

| Model | Purpose | Key fields / constraints |
|---|---|---|
| `User`                | account row            | `id`, `email` @unique, `passwordHash` (argon2id), `role` ∈ {PATIENT, DOCTOR, ADMIN} |
| `DoctorProfile`       | doctor clinical profile| `userId` @unique FK→User, `specialisation`, `workingHours` JSON, `slotDurationMinutes` (default 30), `phone` |
| `PatientProfile`      | patient profile        | `userId` @unique FK→User, `fullName`, `gender?`, `dob?` |
| `LeaveDay`            | Rule 3                 | `doctorId` FK, `leaveDate` Date — `@@unique([doctorId, leaveDate])` |
| `Booking`             | Rule 2 row             | `doctorId`, `patientId`, `bookingDate`, `startTime`, `status` ∈ {CONFIRMED, RESCHEDULED, CANCELLED, COMPLETED} — **`@@unique([doctorId, bookingDate, startTime])`** plus the partial-WHERE index R1 in `001_add_partial_unique_index/migration.sql` (admits CANCELLED/COMPLETED rows for slot reuse) |
| `SymptomForm`         | Rule 4 intake          | `bookingId` @unique, `primaryComplaint`, `durationDays`, `severity`, `description`, `currentMedications[]`, `allergies[]` |
| `PreVisitSummary`     | M4 LLM output          | `bookingId` @unique, `summaryText`, `llmStatus` ∈ {PENDING, GENERATED, FALLBACK, FAILED}, `retryCount`, `generatedAt` |
| `PostVisitSummary`    | M4 LLM output          | `bookingId` @unique, `summaryText`, `llmStatus`, `retryCount`, `generatedAt`, `doctorNotes?` |
| `Prescription`        | M5 reminder source    | `bookingId` FK, `medicationName`, `frequency` (enum), `frequencyCustom?` |
| `MedicationReminder`  | Rule 7 row             | `prescriptionId` FK, `remindAt` DateTime, `status` ∈ {PENDING, SENT, SKIPPED} |
| `Notification`        | Rule 6 durable audit   | `recipientUserId` FK→User, `bookingId`, `notificationType`, `status` ∈ {QUEUED, SENDING, SENT, RETRYING, FAILED, DEAD}, `failedAt?` (dead-letter timestamp), `lastError` |
| `CalendarEvent`       | Rule 8 audit           | `bookingId` @unique, `patientEventId?`, `doctorEventId?`, `syncStatus` ∈ {PENDING, SYNCING, SYNCED, RETRYING, FAILED}, `lastSyncError` |
| `OauthToken`          | M6 tokens at rest      | `userId` @unique, `accessToken` (AES-256-GCM `base64(iv ‖ ciphertext ‖ tag)`), `refreshToken` (same format), `expiryDate`, `googleEmail` |
| `RefreshToken`        | M1 JWT rotation        | `userId` FK, `tokenHash` @unique (hashed), `familyId`, `revokedAt?` — reuse-detection on rotation |

## LLM prompts (exact text from `backend/src/services/llm/llmService.ts`)

The NVIDIA NIM client is wired via the `openai` SDK pointing at
`https://integrate.api.nvidia.com/v1`. Both prompts return JSON validated by
`zod`; on parse/schema failure or transport error the worker retries once
with a 2s backoff, then stores a neutral fallback in `summaryText` with
`llmStatus=FALLBACK` (Rule 5). Worker concurrency is locked to **1** to stay
inside NIM's ~40 req/min free-tier limit.

### Pre-visit (system)

```
You are a clinical decision-support assistant. You analyse patient symptom
information and produce a brief pre-visit summary that helps the doctor
prepare. You are NOT a diagnostic device. Do not suggest a definitive
diagnosis. Keep all content neutral and factual. Do not mention the patient's
name, contact information, or identifiers — the intake is already anonymous.

Return ONLY a JSON object with the keys shown below. Do not emit reasoning,
introduction, summary, or commentary. No Markdown fences. The JSON must be
valid and complete on its own.
```

### Pre-visit (user template — `{symptoms}` is replaced with `buildPreVisitSymptomText(symptomForm)`)

```
Analyse these symptoms and return: urgency level (Low / Medium / High),
chief complaint, and three suggested questions for the doctor.

Return the result as a JSON object with exactly this schema:
{ "urgencyLevel": "Low" | "Medium" | "High", "chiefComplaint": string,
  "suggestedQuestions": [string, string, string] }

Rules:
- "urgencyLevel": MUST be one of "Low", "Medium", "High" — no other values.
- "chiefComplaint": one concise sentence, max 200 chars.
- "suggestedQuestions": EXACTLY three items, each a single question, max 200 chars each.
- The JSON object is your entire answer. No preamble, no postamble, no Markdown code fences.

Symptoms:
{symptoms}
```

The `buildPreVisitSymptomText` helper only references SymptomForm fields
(`primaryComplaint`, `durationDays`, `severity`, `description`,
`currentMedications`, `allergies`). No patient/doctor name, email, id, or DOB
is sent to NIM (PII minimisation, M4 verified).

### Post-visit (system)

```
You are a health-literacy assistant. You convert a doctor's visit notes into
a plain-language summary that the patient can understand. Replace jargon with
everyday words where possible but do not invent medical facts or medication
instructions that are not present in the notes. If something is absent, omit
it rather than guessing.

Return ONLY a JSON object with the keys shown below. No Markdown fences, no
commentary outside the JSON.
```

### Post-visit (user template — `{notes}` is the doctor's raw notes)

```
Convert these clinical notes into a patient-friendly summary with medication
schedule and follow-up steps.

Return the result as a JSON object with exactly this schema:
{
  "summaryText": string,
  "medicationSchedule": [{ "medication": string, "schedule": string }] | [],
  "followUpSteps": [string] | []
}

Rules:
- "summaryText": 1-3 plain-language paragraphs, each max 600 chars.
- "medicationSchedule": one entry per medication mentioned in the notes; if
  none mentioned, use an empty array []. Each "schedule" string should be the
  patient-readable instructions (e.g. "Take 1 tablet every morning after food").
- "followUpSteps": one string per distinct follow-up action mentioned; if
  none, use []. Each string max 300 chars.
- The JSON object is your entire answer. No Markdown fences, no preamble.

Notes:
{notes}
```

## Google Calendar OAuth setup — end to end

M6 uses `googleapis@^144` with scope
`https://www.googleapis.com/auth/calendar.events` only (least-privilege — read
and write **events** on the user's primary calendar, nothing else).

### Step 1 — GCP project + enabling Calendar API

1. https://console.cloud.google.com → **New Project** (e.g. `healthcare-app`).
2. APIs & Services → Library → search **Google Calendar API** → **Enable**.

### Step 2 — OAuth consent screen

1. APIs & Services → **OAuth consent screen** → User type **External** → **Create**.
2. Fill in the app name, support email, authorised domains (your Neon-free
   app's domain). Leave scopes for now — M6 only requests `calendar.events`
   at runtime.
3. **Test users** → ADD USERS → add your Google account's email.
   This is critical because the app stays in "Testing" status. Without test
   users, anyone outside your organisation sees
   **"This app isn't verified"** with the only path forward being the
   *Developer wants you to continue / Advanced / Go to <app> (unsafe)* bypass.
   The bypass works but is a hostile UX — adding yourself as a test user
   makes the warning go away and the consent screen proceeds normally for
   your own development account.

### Step 3 — OAuth 2.0 web client credentials

1. APIs & Services → **Credentials** → **Create Credentials** → **OAuth client ID**
2. Application type: **Web application**.
3. Authorised redirect URIs (must match `GOOGLE_OAUTH_REDIRECT_URI` exactly,
   host + port + path + scheme): add `http://localhost:3001/calendar/callback`
   for dev and `https://your-backend.onrender.com/calendar/callback` for prod.
4. Copy the **Client ID** (ends `.apps.googleusercontent.com`) and
   **Client Secret** (`GOCSPX-…`) into your `.env` as
   `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`.

### Step 4 — Encryption key

Generate the AES-256-GCM key for OAuth tokens-at-rest:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Store the output in `OAUTH_TOKEN_ENC_KEY`. `config/env.ts:25-32` validates at
boot that the base64 string decodes to exactly 32 raw bytes.

### Step 5 — End-to-end flow (what actually happens)

1. Authenticated patient or doctor hits `GET /calendar/connect` in the app's
   Settings page. Backend mints a single-use CSRF `state`, stores it in
   Upstash Redis under `oauth_state:{state}` with TTL 600s, and returns the
   Google consent URL.
2. Browser is redirected to Google. User picks their Google account and
   grants `calendar.events` scope. Google redirects to
   `https://<your backend>/calendar/callback?code=...&state=...`. This
   redirect is **public** because Google does it top-level in the browser.
3. `GET /calendar/callback` validates the `state` against Redis (consuming it
   immediately, so a replay attacker reusing the URL gets a 400), reconstructs
   the user identity from the matched state payload, and calls
   `OAuth2Client.getToken(code)` to exchange the code for `{access_token,
   refresh_token, expiry_date, ...}`.
4. Tokens are AES-256-GCM encrypted: ciphertext stored as
   `base64(iv(12) ‖ ciphertext ‖ tag(16))` in `OauthToken.accessToken` and
   `.refreshToken`. The `OauthToken` row is keyed on `userId`.
5. From then on, every booking confirm / cancel / reschedule enqueues a
   `calendar-sync` BullMQ job. The worker re-reads the booking + connected
   parties from the DB at execute time (never trusts pre-commit snapshot),
   calls `getValidAccessToken(userId)` to decrypt/refresh-on-demand (with a
   `oauth_refresh_lock:{userId}` SET-NX serialisation to avoid concurrent
   refresh stampedes), and then `calendar.events.insert` or
   `calendar.events.delete` with `sendUpdates:'none'` (no invite emails to
   either party).
6. If the user revokes our app from their Google account security page,
   `getValidAccessToken` catches `invalid_grant`, deletes the `OauthToken`
   row locally, and returns `null` — the worker silently skips Google
   sync for that user without breaking the booking response (Rule 8).
7. `POST /calendar/disconnect` revokes the token at Google (best-effort) and
   deletes the `OauthToken` row.

### The "unverified app" warning

Even after you add yourself as a test user (Step 2), other people will see
the "Google hasn't verified this app" warning during consent. The app's
status remains *Testing* by default. Three deployment options:

- **Dev / personal / demo**: leave it in Testing, add each new user's Google
  email under "Test users". 100 test-user cap — fine for a placement demo.
- **Production small-scale**: submit the app for Google verification. Google
  will ask for a privacy policy URL + a short video of the consent flow. The
  process takes a few days for sensitive scopes; `calendar.events` is usually
  approved inside a week. Then the warning goes away for all users.
- **Inside Google Workspace**: an organisation admin can mark the app
  "internal" — no verification needed, the warning never shows for employees.

For this placement assignment the "Testing + test users" path is sufficient.

## Running the test suite

The M8 suite runs against real Neon + Upstash (no mocks, no Docker). It
covers Rules 1, 2, 3, 5, 6, 8 — including a 12-way simultaneous-failure mesh.

```bash
cd backend
cp .env.example .env.test          # edit with real DATABASE_URL + UPSTASH_REDIS_TLS_URL
# (see tests/README.md for the failure-injection pattern)
npm test                            # 7 specs / 36 tests, ~7 min wall clock
npm run test:race                   # TP-C1 only
npm run test:rbac                   # TP-RB only
# …etc, see package.json scripts
```

Flush the Redis daily-cap key before a fresh second run:
`redis-cli -u $UPSTASH_REDIS_TLS_URL DEL email:daily_cap:$(date -u +%F)`
(force `TZ=UTC` first — see assumption A10(M2-Correction-TZ) / A1(M8)).

## Free-tier limits reference

| Service | Free quota in this project |
|---|---|
| Vercel Hobby | 100 GB bandwidth / mo, 100 GB-h build |
| Render free Web Service | spins down after 15 min idle, cold-start 30-60s, 750 instance-hours / mo |
| Neon free | scale-to-zero, 0.5 GB storage, 100 compute-hours / mo |
| Upstash free | 256 MB, 500 K commands/day, 1 K-10 K req/s |
| Resend free | 3 000 / mo + 100 / day across all send paths |
| Google Calendar API v3 | 200 req/user/100s per user |
| NVIDIA NIM free | ~40 req/min (worker cap is 1) |

## Project state

See `PROJECT_STATE.md` for the authoritative cross-module ledger: module
status, regression ledger, tracked issues, assumptions log. **Read it before
touching any module.**

## Known drifts / drift-watch (tracked in PROJECT_STATE.md)

1. **R1 (pending)** — partial-unique-index migration is raw SQL, not Prisma-tracked. Must be applied manually via `psql`.
2. **I2(M4)** — admin cancel/reschedule bypass: `requireRoles('PATIENT','DOCTOR','ADMIN')` on routes but service-layer ownership check rejects admin's user id. Fix: add `req.user.role === 'ADMIN'` check in `cancelBooking`/`rescheduleBooking`.
3. **I5(M4)** — NVIDIA NIM model ID (`meta/llama-3.1-70b-instruct`) assumed available on free tier; verify against NVIDIA catalog before production deploy.
4. **I4(M4)** — BullMQ workers single-process (Render free tier). If horizontal scaling added, need idempotency via `bookingId` + `llmStatus` checks (already present in workers).
5. **I6(M4)** — Doctor notes PII redaction not implemented (advisory-only UI banner). If required, add pre-processing step before LLM call.
6. **I7(M4)** — Recovery sweep for stuck `llmStatus=PENDING` rows (jobs lost due to Redis eviction) not yet implemented. Could add hourly cron to re-enqueue PENDING rows older than 5 min.
7. **EMAIL_WORKER_CONCURRENCY env var** documented in .env.example but NOT honoured by `emailWorker.ts` (hardcoded `concurrency: 3` at line 154). Either wire it or drop the var.
8. **Frontend/backend URL mismatch** — frontend calls `/visits/:id/post-summary` and `/visits/:id/pre-summary`; backend exposes only `/visits/:bookingId/summary` (returns PostVisit only). Either the PostVisitSummary; PreVisit is not included). Fix: either add the two dedicated endpoints on backend or change frontend to use the combined endpoint.
9. **`submitNotes` body shape** — frontend sends `{notes, prescriptions?[]}`; backend only reads `notes` from `req.body`. Prescriptions for medication reminders are read from the DB `prescriptions` table, NOT from the request body. Fix: either add a prescription-write endpoint or have frontend pass notes-only.
10. **`prescription` table write path** — no backend API creates `prescription` rows; they are read-only from DB. Either seed them manually or add an endpoint.