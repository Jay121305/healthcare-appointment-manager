# Healthcare Appointment & Follow-up Manager

> A production-grade, full-stack clinic platform with separate portals for patients, doctors, and admins — featuring AI-generated pre/post-visit summaries, concurrent-safe slot booking, async email notifications, and Google Calendar sync. Runs entirely on permanent free-tier infrastructure.

**Live Demo → `https://healthcare-appointment-manager-two.vercel.app`**  
**Backend API → `https://healthcare-backend-dz7o.onrender.com`**

Seed accounts for evaluators:
| Role    | Email                      | Password        |
|---------|----------------------------|-----------------|
| Admin   | admin@healthcare.local     | AdminPass123!   |
| Doctor  | doctor@healthcare.local    | DoctorPass123!  |
| Patient | patient@healthcare.local   | PatientPass123! |

> ⚠️ Backend is hosted on Render's free tier — first request after idle may take 30–60s to cold-start.

---

## Screenshots

**Landing Page**

![Landing Page](docs/screenshots/landing.png)

**Sign In**

![Sign In](docs/screenshots/signin.png)

**Patient Sign Up**

![Patient Sign Up](docs/screenshots/patient-signup.png)

**Doctor Sign In**

![Doctor Sign In](docs/screenshots/doctor-signin.png)

---

## What This Project Demonstrates

This is not a basic CRUD app. The key engineering decisions are:

| Problem | Solution |
|---|---|
| **Concurrent double-booking** | DB partial unique index `WHERE status IN ('CONFIRMED','RESCHEDULED')` inside `prisma.$transaction` — application-level checks are not the guard |
| **Doctor leave conflicts** | Two-phase `dryRun` preview before commit — admin sees affected patients before any side effects happen |
| **Slot hold / race conditions** | Redis TTL hold (`SET NX EX`) for UX, DB constraint for correctness — hold is never the sole guard |
| **Notification reliability** | BullMQ queue → 3× exponential retry → `DEAD` state with `failedAt` timestamp; booking is never blocked by email |
| **LLM failure isolation** | 1 retry + neutral fallback text stored in DB; booking confirm never awaits LLM |
| **Calendar sync isolation** | Calendar events created/deleted in a separate BullMQ worker post-commit; OAuth token revocation handled gracefully |

---

## Tech Stack

| Layer | Tech | Hosting |
|-------|------|---------|
| Frontend | Next.js 14 App Router + TypeScript + Tailwind 3 | Vercel Hobby (free) |
| Backend | Node.js + Express + TypeScript | Render free Web Service |
| Database | PostgreSQL + Prisma ORM | Neon (permanent free tier) |
| Queue / Cache | Redis + BullMQ | Upstash (free, 500K cmd/mo) |
| Auth | Self-implemented JWT (HS256 access + rotating refresh) | — |
| Email | Resend SDK | Resend free (3K/mo) |
| Calendar | Google Calendar API v3 + OAuth 2.0 | Google Cloud (free) |
| LLM | NVIDIA NIM (OpenAI-compatible endpoint) | NVIDIA free tier (~40 req/min) |

---

## Repository Structure

```
.
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma              # 13 models, 10 enums
│   │   ├── seed.ts                    # Bootstrap admin/doctor/patient accounts
│   │   └── migrations/
│   │       └── 001_add_partial_unique_index/migration.sql  # Rule 2 enforcement
│   └── src/
│       ├── config/                    # Env, Prisma client, Redis client, queue names
│       ├── middleware/                # authenticate, requireRoles, requireOwnershipOrAdmin
│       ├── routes/                    # auth, booking, admin/doctors, calendar, visits
│       ├── services/
│       │   ├── booking/bookingService.ts   # Core booking engine (double-booking, hold, confirm)
│       │   ├── llm/llmService.ts           # NVIDIA NIM client + retry/fallback
│       │   ├── calendar/                   # OAuth, token encryption, Calendar API
│       │   ├── leaveService.ts             # Two-phase leave conflict detection
│       │   ├── slotService.ts              # Live slot computation (never pre-materialized)
│       │   └── medicationScheduler.ts      # Prescription → reminder timestamp parser
│       ├── workers/                   # 7 BullMQ workers
│       │   ├── emailWorker.ts         # email-notification queue, 3× retry, DEAD state
│       │   ├── preVisitSummaryWorker.ts
│       │   ├── postVisitSummaryWorker.ts
│       │   ├── reminderScanWorker.ts  # Hourly scan for upcoming appointments
│       │   ├── medicationReminderWorker.ts
│       │   ├── medicationExpansionWorker.ts
│       │   └── calendarSyncWorker.ts
│       └── tests/                     # M8: 7 specs / 36 tests (Jest + Supertest, real DB)
│
├── frontend/
│   └── app/
│       ├── (public)/                  # /login, /signup/patient
│       ├── patient/                   # Dashboard, doctor search, booking flow, summaries
│       ├── doctor/                    # Dashboard, appointments, post-visit notes
│       └── admin/                     # Doctor CRUD, leave management, conflict resolution UI
│
├── SYSTEM_DESIGN.md                   # 788-word technical write-up (required deliverable)
├── PROJECT_STATE.md                   # Cross-module build ledger with regression guarantees
└── .env.example                       # All 22 environment variables with descriptions
```

---

## Local Setup

### Prerequisites
- Node.js 18+
- Accounts on: [Neon](https://neon.tech), [Upstash](https://upstash.com), [Resend](https://resend.com), [NVIDIA NGC](https://build.nvidia.com)
- Google Cloud project with Calendar API enabled (see [Google Calendar OAuth Setup](#google-calendar-oauth-setup))

### Steps

```bash
# 1. Clone and install
git clone https://github.com/Jay121305/healthcare-appointment-manager
cd healthcare-appointment-manager
cd backend && npm install
cd ../frontend && npm install

# 2. Configure environment
cp .env.example backend/.env
# Edit backend/.env with your service credentials (see Environment Variables section)

# 3. Generate JWT secrets
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # → JWT_ACCESS_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # → JWT_REFRESH_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # → OAUTH_TOKEN_ENC_KEY

# 4. Push schema and seed demo accounts
cd backend
npm run db:generate   # prisma generate
npm run db:push       # Creates all tables on Neon

# 5. Apply the partial-unique-index migration (manual SQL, run once)
psql "$DATABASE_URL" -f prisma/migrations/001_add_partial_unique_index/migration.sql

# 6. Seed demo accounts
npm run db:seed

# 7. Start both servers
npm run dev           # backend on :3001
# In a separate terminal:
cd ../frontend && npm run dev   # frontend on :3000
```

Open http://localhost:3000 and sign in with `admin@healthcare.local / AdminPass123!`

---

## Deploy to Vercel + Render (free)

**Backend (Render)**
1. New Web Service → connect repo → root directory: `backend/` → build: `npm install && npm run build` → start: `npm start`
2. Add all variables from `backend/.env` in Render's Environment tab
3. Set `FRONTEND_URL=https://your-frontend.vercel.app` and `GOOGLE_OAUTH_REDIRECT_URI=https://your-backend.onrender.com/calendar/callback`
4. Apply the partial-unique-index migration against your Neon DB (same `psql` command from step 5 above)

**Frontend (Vercel)**
1. New Project → connect repo → root directory: `frontend/`
2. Set `NEXT_PUBLIC_API_URL=https://your-backend.onrender.com`
3. Deploy

---

## Environment Variables

Full reference is in `.env.example`. Key variables:

| Variable | Description |
|---|---|
| `DATABASE_URL` | Neon PostgreSQL connection string (include `?sslmode=require`) |
| `UPSTASH_REDIS_TLS_URL` | Upstash Redis TLS URL (`rediss://default:TOKEN@HOST:6379`) |
| `JWT_ACCESS_SECRET` | 32-byte hex secret for access tokens |
| `JWT_REFRESH_SECRET` | 32-byte hex secret for refresh tokens |
| `NVIDIA_NIM_API_KEY` | NVIDIA NGC API key (`nvapi-…`) |
| `NVIDIA_NIM_MODEL` | Model to use (e.g. `meta/llama-3.1-70b-instruct`) |
| `RESEND_API_KEY` | Resend API key (`re_…`) |
| `EMAIL_FROM_ADDRESS` | Verified sender email for notifications |
| `GOOGLE_OAUTH_CLIENT_ID` | GCP OAuth 2.0 Client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | GCP OAuth 2.0 Client Secret |
| `GOOGLE_OAUTH_REDIRECT_URI` | Must match exactly: `http://localhost:3001/calendar/callback` for dev |
| `OAUTH_TOKEN_ENC_KEY` | 32-byte base64 key for AES-256-GCM OAuth token encryption |
| `NEXT_PUBLIC_API_URL` | Backend URL (frontend env var) |

---

## API Reference

`authenticate` = JWT Bearer header required. `requireRoles(...)` = server-side role enforcement.

### Auth (`/auth`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/signup/patient` | Public | Patient self-registration |
| POST | `/auth/login` | Public | Returns `{accessToken, refreshToken, user}` |
| POST | `/auth/refresh` | Public | Rotates refresh token (reuse detection) |
| POST | `/auth/logout` | JWT | Invalidates refresh token family |
| GET | `/auth/me` | JWT | Current user profile |

### Bookings (`/bookings`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/bookings/slots` | JWT | Live-computed available slots for a doctor on a date |
| POST | `/bookings/holds` | JWT PATIENT | Place a 5-min Redis TTL hold on a slot |
| POST | `/bookings/:holdToken/symptom-form` | JWT PATIENT | Attach symptom form before confirm (Rule 4) |
| POST | `/bookings/:holdToken/confirm` | JWT PATIENT | Confirm booking — DB unique constraint enforced inside `$transaction` |
| POST | `/bookings/:bookingId/cancel` | JWT PATIENT/DOCTOR/ADMIN | Cancel; email + calendar delete fire async |
| POST | `/bookings/:bookingId/reschedule` | JWT PATIENT/DOCTOR/ADMIN | Reschedule; new Booking row created |

### Admin — Doctor Management (`/admin/doctors`) — ADMIN only
| Method | Path | Description |
|--------|------|-------------|
| POST | `/admin/doctors` | Create doctor profile |
| GET | `/admin/doctors` | List doctors (search by specialisation) |
| PUT | `/admin/doctors/:id` | Update profile, working hours |
| DELETE | `/admin/doctors/:id` | Soft delete (rejected if upcoming bookings exist) |
| POST | `/admin/doctors/:id/leave` | Mark leave — `dryRun=true` returns conflict list with zero side effects; `dryRun=false` + `conflictResolution=AUTO_CANCEL` atomically cancels bookings + enqueues patient notifications |
| GET | `/admin/doctors/:id/leave` | List leave days |
| DELETE | `/admin/doctors/:id/leave/:leaveId` | Remove a leave day |

### Visits (`/visits`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/visits/:bookingId/notes` | JWT DOCTOR | Submit post-visit notes; triggers LLM summary + medication reminders |
| GET | `/visits/:bookingId/summary` | JWT PATIENT/DOCTOR | Post-visit summary (doctor also sees raw notes) |

### Calendar (`/calendar`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/calendar/connect` | JWT PATIENT/DOCTOR | Returns Google OAuth consent URL |
| GET | `/calendar/callback` | Public | OAuth callback — exchanges code, encrypts tokens |
| POST | `/calendar/disconnect` | JWT PATIENT/DOCTOR | Revokes token, deletes local record |
| GET | `/calendar/status` | JWT PATIENT/DOCTOR | `{connected, connectedAt, googleEmail}` |

---

## Database Schema

13 models on PostgreSQL (Neon). All times stored in UTC.

| Model | Purpose | Key Constraints |
|-------|---------|-----------------|
| `User` | Auth account | `email` unique, `role` ∈ {PATIENT, DOCTOR, ADMIN} |
| `DoctorProfile` | Clinical profile | `userId` unique FK, `workingHours` JSON, `slotDurationMinutes` |
| `PatientProfile` | Patient profile | `userId` unique FK, `fullName`, `dob`, `gender` |
| `LeaveDay` | Doctor leave | `@@unique([doctorId, leaveDate])` |
| `Booking` | Core appointment | `@@unique([doctorId, bookingDate, startTime])` + partial index `WHERE status IN ('CONFIRMED','RESCHEDULED')` |
| `SymptomForm` | Pre-visit intake | `bookingId` unique FK |
| `PreVisitSummary` | LLM output | `llmStatus` ∈ {PENDING, GENERATED, FALLBACK, FAILED} |
| `PostVisitSummary` | LLM output | `doctorNotes` field visible to doctor only |
| `Prescription` | Medication record | `bookingId` FK, `frequency` enum |
| `MedicationReminder` | Scheduled reminders | `remindAt` stored in DB (survives Redis eviction) |
| `Notification` | Email audit trail | `status` ∈ {QUEUED, SENDING, SENT, RETRYING, FAILED, DEAD} + `failedAt` |
| `CalendarEvent` | Calendar audit | `syncStatus` ∈ {PENDING, SYNCED, RETRYING, FAILED} |
| `OauthToken` | Google tokens | AES-256-GCM encrypted at rest |

---

## LLM Prompts

Both prompts call NVIDIA NIM via the `openai` SDK at `https://integrate.api.nvidia.com/v1`. Responses are validated with `zod`; on failure: 1 retry (2s backoff) → neutral fallback stored in DB. Booking confirm **never** awaits the LLM.

### Pre-Visit Summary (system prompt)

```
You are a clinical decision-support assistant. You analyse patient symptom
information and produce a brief pre-visit summary that helps the doctor prepare.
You are NOT a diagnostic device. Do not suggest a definitive diagnosis. Keep all
content neutral and factual. Do not mention the patient's name, contact
information, or identifiers — the intake is already anonymous.

Return ONLY a JSON object with the keys shown below. No Markdown fences.
```

### Pre-Visit Summary (user prompt)
```
Analyse these symptoms and return: urgency level (Low / Medium / High),
chief complaint, and three suggested questions for the doctor.

Return the result as a JSON object with exactly this schema:
{ "urgencyLevel": "Low" | "Medium" | "High", "chiefComplaint": string,
  "suggestedQuestions": [string, string, string] }

Rules:
- "urgencyLevel": MUST be one of "Low", "Medium", "High".
- "chiefComplaint": one concise sentence, max 200 chars.
- "suggestedQuestions": EXACTLY three items, each max 200 chars.
- The JSON object is your entire answer. No preamble, no Markdown fences.

Symptoms:
{symptoms}
```

### Post-Visit Summary (user prompt)
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
- "medicationSchedule": one entry per medication; [] if none mentioned.
- "followUpSteps": one string per distinct action; [] if none.
- The JSON object is your entire answer. No Markdown fences.

Notes:
{notes}
```

**PII minimization**: only `SymptomForm` fields (complaint, duration, severity, medications, allergies) are sent to NIM. Patient name, email, DOB, and IDs are never included in the prompt.

---

## Google Calendar OAuth Setup

The app uses `googleapis@^144` with scope `calendar.events` only (least-privilege).

**Step 1 — Create GCP project**
1. Go to [console.cloud.google.com](https://console.cloud.google.com) → New Project
2. APIs & Services → Library → Enable **Google Calendar API**

**Step 2 — OAuth consent screen**
1. APIs & Services → OAuth consent screen → External → Create
2. Add your app name and authorized domains
3. **Add your Google email under Test Users** — without this, every consent screen shows an "unverified app" warning

**Step 3 — Create OAuth 2.0 credentials**
1. APIs & Services → Credentials → Create Credentials → OAuth client ID → Web application
2. Add authorized redirect URIs:
   - `http://localhost:3001/calendar/callback` (dev)
   - `https://your-backend.onrender.com/calendar/callback` (prod)
3. Copy Client ID and Client Secret to your `.env`

**Step 4 — Generate encryption key**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# Paste output as OAUTH_TOKEN_ENC_KEY
```

**How the flow works:**
1. User hits `GET /calendar/connect` → backend mints a single-use CSRF `state` token (Redis, 60s TTL), returns Google consent URL
2. User grants `calendar.events` scope → Google redirects to `/calendar/callback`
3. Backend validates state (consumed on use — replay attacks get 400), exchanges code for tokens, AES-256-GCM encrypts, stores in `OauthToken`
4. On booking confirm/cancel/reschedule: calendar jobs enqueued via BullMQ post-commit, processed by `calendarSyncWorker` (concurrency 2 — within Google's 200 req/user/100s quota)
5. If user revokes access via Google Account settings: `invalid_grant` → local `OauthToken` row deleted → worker silently skips (booking unaffected)

---

## Running the Test Suite

Tests run against real Neon + Upstash (no mocks) and cover all non-negotiable rules.

```bash
cd backend
cp .env.example .env.test
# Set real DATABASE_URL + UPSTASH_REDIS_TLS_URL; use invalid values for NIM/Resend to test failure paths

npm test              # All 7 specs / 36 tests (~7 min)
npm run test:race     # Concurrent booking race (20 simultaneous requests → exactly 1 success)
npm run test:rbac     # 15 RBAC boundary tests
npm run test:leave    # Leave conflict detection + auto-cancel
npm run test:llm      # LLM failure injection → FALLBACK state
npm run test:email    # Email failure injection → DEAD state after 3 retries
npm run test:calendar # Calendar silent-skip when no OAuth tokens
npm run test:mixed    # All failures simultaneously on a 12-way race
```

> Before re-running the suite, flush the email daily-cap Redis key:
> ```bash
> redis-cli -u $UPSTASH_REDIS_TLS_URL DEL email:daily_cap:$(TZ=UTC date +%F)
> ```

---

## System Design

The full 800-word system design write-up is in [`SYSTEM_DESIGN.md`](./SYSTEM_DESIGN.md). It covers the four required topics:

1. **Double-booking prevention** — DB partial unique index inside `prisma.$transaction`; Redis hold is advisory UX only
2. **Doctor leave conflict handling** — Two-phase `dryRun` preview before commit; `AUTO_CANCEL` atomically cancels bookings and enqueues notifications in a single tx
3. **Slot hold mechanism** — Redis `SET NX EX` keyed by `bh:{doctorId}:{date}:{time}`; 5-min TTL; booking insert re-checks DB constraint regardless of hold state
4. **Notification failure handling** — BullMQ `email-notification` queue; 3× exponential retry; `DEAD` state with `failedAt` timestamp; booking confirm never awaits email

---

## Free-Tier Limits Reference

| Service | Quota used in this project |
|---------|---------------------------|
| Vercel Hobby | 100 GB bandwidth/mo, 100 GB-h build |
| Render free | 750 instance-hours/mo, 15-min idle spin-down, 30-60s cold start |
| Neon free | 0.5 GB storage, 100 compute-hours/mo, scale-to-zero |
| Upstash free | 256 MB, 500K commands/day |
| Resend free | 3,000 emails/mo, 100/day |
| Google Calendar API | 200 req/user/100s (worker concurrency = 2) |
| NVIDIA NIM free | ~40 req/min (LLM worker concurrency = 1) |

Everything above is on a **permanent** free tier — no credit card, no expiry.

---

## Project State

See `PROJECT_STATE.md` for the authoritative cross-module ledger: module status, regression ledger, tracked issues, assumptions log. **Read it before touching any module.**

---

## Known Drifts / Drift-Watch (tracked in PROJECT_STATE.md)

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