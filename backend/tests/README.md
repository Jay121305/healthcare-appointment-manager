# M8 — Test Suite (Rules 2, 3, 5, 6, 8)

This directory contains the Jest + Supertest suite derived from the M8 test plan produced in this session.

## Files

| File | Test plan ref | Rule(s) verified |
|---|---|---|
| `tests/race/TP-C1.concurrent-booking.spec.ts` | TP-C1 | Rule 2 |
| `tests/llm/TP-L1.llm-failure.spec.ts` | TP-L1 | Rule 5 |
| `tests/email/TP-E1.email-failure.spec.ts` | TP-E1 | Rule 6 |
| `tests/calendar/TP-CA1.calendar-failure.spec.ts` | TP-CA1 | Rule 8 |
| `tests/leave/TP-3.leave-conflict.spec.ts` | TP-3a, TP-3b | Rule 3 + Rule 6 + Rule 8 (side effects) |
| `tests/rbac/TP-RB.rbac.spec.ts` | TP-RB1..RB22 | Rule 1 (boundary tests) |
| `tests/mixed/TP-Coin1.full-failure.spec.ts` | TP-Coin1 | Rules 2, 5, 6, 8 (combined) |

Infrastructure:
- `tests/jest.config.cjs` — Jest config (CommonJS, ts-jest with `isolatedModules`).
- `tests/jest.setup.ts` — env defaults so `validateEnv()` boots.
- `tests/helpers/testApp.ts` — wraps `createApp()` (refactored from `src/index.ts`) for Supertest.
- `tests/helpers/fixtures.ts` — fixture builders (`signupPatient`, `signupDoctor`, `pickFreshSlot`, `placeHoldAndConfirm`).
- `tests/helpers/bootWorkers.ts` — lazily imports the 7 BullMQ workers for failure-mode tests.

## Required env (run before `npm test`)

```bash
export DATABASE_URL="postgresql://user:pwd@ep-xxx.neon.tech/healtcare?sslmode=require"
export UPSTASH_REDIS_TLS_URL="rediss://default:TOKEN@cluster.upstash.io:6379"
export JWT_ACCESS_SECRET="<32-byte-hex>"           # any 32-byte hex ≥ 64 chars in test
export JWT_REFRESH_SECRET="<32-byte-hex>"
export NVIDIA_NIM_API_KEY="test_invalid_nim_key"   # defaults to invalid; LLM TP-L1 needs this
export NVIDIA_NIM_MODEL="meta/llama-3.1-70b-instruct"
export RESEND_API_KEY="test_invalid_resend_key"    # defaults to invalid; TP-E1 needs this
export EMAIL_FROM_ADDRESS="noreply@test.invalid"
export GOOGLE_OAUTH_CLIENT_ID="test"
export GOOGLE_OAUTH_CLIENT_SECRET="test"
export GOOGLE_OAUTH_REDIRECT_URI="http://localhost:3001/calendar/callback"
# 32 bytes base64:
export OAUTH_TOKEN_ENC_KEY="$(node -e 'console.log(require(\"crypto\").randomBytes(32).toString(\"base64\"))')"
```

Recommended: copy `backend/.env.example` to `backend/.env.test` and `source backend/.env.test`.

For tests using a real LLM/email flow, swap API keys to valid ones and re-run.

## How to run

From `backend/`:

```bash
# All tests
npm test

# Individual files:
npm run test:race         # TP-C1
npm run test:llm          # TP-L1
npm run test:email        # TP-E1
npm run test:calendar     # TP-CA1
npm run test:leave        # TP-3a / 3b
npm run test:rbac         # TP-RB1..RB22
npm run test:mixed        # TP-Coin1

# Or single file ad-hoc:
npx jest --config tests/jest.config.cjs tests/race/TP-C1.concurrent-booking.spec.ts
```

## Pre-requisites

1. Postgres/Neon reachable + schema migrated (`prisma migrate deploy`).
2. Upstash Redis reachable for `bh:*` holds + BullMQ queue keys + `oauth_*` keys.
3. Seeded admin account present OR auto-bootstrapable (`admin@healthcare.local / AdminPass123!`).
4. (TP-Coin1 only) Email + Calendar workers expected to be slow — worker retries are 3× with 30s exponential backoff; allow ~5 minutes per test file.

## Disposability

- Most cleanup happens in `afterAll`; deletes the seeded doctor/patients + their bookings + nested rows.
- After test run, eligible DB reuse if not consumed by other pipelines.
- For production DB REUSE WARNING: tests write into the same Postgres/Redis the free-tier app uses. Always target a sandbox environment.

## Refactor

- `src/index.ts` was minimally changed to export `createApp()` (server no longer auto-starts when imported as a module). The `bootstrap()` foreman only runs when invoked via `tsx watch src/index.ts` directly. The 7 BullMQ workers are imported from inside `bootstrap()` only — so tests don't accidentally start them.

## Notes

- Time budget: full suite = ~10–12 minutes wall-clock (TP-E1 + TP-L1 are the slowest); permit `npm test` to run with `--maxWorkers=1` only.
- The tests succeed or fail loudly — DB rows from any test failure are cleaned up via `afterAll` (best-effort).
- Some tests depend on real `seed.ts` having been run; alternatively, they bootstrap an admin directly via `prisma.user.upsert`.
