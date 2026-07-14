# System Design — Double-Booking, Leave-Conflict, Slot Holds, Notification Failures

Four design decisions grounded in the actual implementation. Code paths and
queue/DB artefacts are referenced inline.

## 1. Double-booking prevention (Rule 2 — M3)

The authoritative zero-double-booking guarantee lives in PostgreSQL, not in
Redis nor in application-level locks. `confirmBooking` in
`backend/src/services/booking/bookingService.ts` wraps the booking insert in
`prisma.$transaction(...)`. The `Booking` row carries the schema-level
constraint `@@unique([doctorId, bookingDate, startTime])` (`schema.prisma:213`).
A partial-WHERE index `WHERE status IN ('CONFIRMED', 'RESCHEDULED')`
(`prisma/migrations/001_add_partial_unique_index/migration.sql`) admits but
rejects-collisions-for CANCELLED/COMPLETED rows, allowing slot reuse without
soft-delete surgery. When a second concurrent confirm attempt enters the
transaction for an already-won slot, Prisma throws `P2002` — the service
catches it and returns `409 SLOT_ALREADY_BOOKED` with `retryable:false`. The
N-patient race in the M8 suite proves exactly one row survives, every other
confirm is rejected cleanly, and the cancelled-counter stays at zero. Booking
insert **never** awaits Redis holds — Redis holds are UX-only advisory, not a
correctness boundary. Rule 4 says booking write must not depend on
LLM/email/calendar; in `fireAsyncTriggers`, all three async dispatches are
`void`-returning `.add(...).catch(log)` calls **after** `prisma.$transaction`
commits, so an Express worker that dies mid-queue can never roll the booking
back. M8 verified this against the live Neon DB.

## 2. Doctor leave conflict handling (Rule 3 — M2 / leaveService)

`/admin/doctors/:id/leave` is two-phase. POST body:
`{rangeStart, rangeEnd, reason?, dryRun, conflictResolution}`.
Phase-1 preview (`dryRun=true`): `leaveService.markLeave` enumerates dates in
the range, queries `prisma.booking.findMany({ where: { doctorId, status in
['CONFIRMED','RESCHEDULED'], bookingDate: { in: newLeaveDates } } })` outside
the transaction, groups conflicts by date, and returns the conflict list with
`leaveRowsCreated=0, autoCancelledBookings=[], notificationsQueued=0`. Zero
side effects — the admin UI uses this to surface a "you'll cancel N
bookings" dialog before the human confirms.
Phase-2 commit (`dryRun=false, conflictResolution='AUTO_CANCEL'`): inside a
single `prisma.$transaction`, `leaveService` inserts the `LeaveDay` rows,
updates each conflicting `Booking` row to `status=CANCELLED`, creates a
PENDING `Notification` row per affected party (patient cancellation +
doctor leave notice), and writes a `MedicationReminder` suspension marker.
After tx commit, `emailQueue.addBulk(...)` fires the email notifications
asynchronously — never awaited in the request handler (Rule 4). The two-phase
pattern is what the admin UI executes against the conflict-resolution dialog
in `/admin/doctors/:id/leave/new`.

## 3. Slot hold mechanism (Rule 4 — M3)

`POST /bookings/holds` is the patient-facing slot reservation. It re-uses
the M2 `getAvailableSlots` service for the advisory hold check; if the slot
is free of bookings and `redisClinet.SET(key, JSON.stringify(payload), 'EX',
ttl, 'NX')` succeeds (no existing token), it returns
`{ holdToken: payload }`. The hold key is
`bh:{doctorId}:{dateIso}:{startTimeIso}`; TTL defaults to
`BOOKING_HOLD_TTL_SECONDS=300` (5 min) per the spec. The `holdToken` is the
JSON payload itself — round-tripped through the next two steps:
`POST /bookings/:holdToken/symptom-form` stores the completing form under
`form:{holdToken}` in Redis (it does NOT call `SET NX` — see `I2(M3)` tracked
issue for a known condition-window that overwrites an expired hold), and
`POST /bookings/:holdToken/confirm` reads both keys, verifies the hold is
still live, then co-creates the `Booking` and the `SymptomForm` rows
atomically via a Prisma nested-write in the same `prisma.$transaction`. The
hold and the SymptomForm both live in Redis **before** any booking exists;
the booking write is the only durable action (Rule 9: nothing invented,
nothing preceded in the DB without a `Booking` to anchor it). The patient
never sees the JSON payload itself — only an opaque token the frontend
passes back verbatim. M3 also enforces patient-ownership on every step:
`attachFormToHold` and `confirmBooking` both check that the calling user's
`req.user.id` matches the hold payload's `patientUserId`; `cancelBooking`
and `rescheduleBooking` re-verify ownership at the service layer
(`booking.patient.user.id === patientUserId`). Redis holds are advisory:
lost Redis keys do not violate Rule 2 because the DB partial-unique-index
uniqueness is checked inside `$transaction` regardless.

## 4. Notification failure handling (Rule 6 — M5)

Every booking confirm/cancel/reschedule triggers a Notification row in the
DB (status=QUEUED) and `emailQueue.add(...)` on the `email-notification`
BullMQ queue. Row and job are mirrored intentionally — the DB row is the
durable audit. `emailWorker.ts` Worker (concurrency=3,
`EMAIL_WORKER_CONCURRENCY`) picks the job, optimistically locks the
Notification `QUEUED→SENDING` (BullMQ redelivery is idempotent), calls
`resend.emails.send(...)`. On 2xx → SENT + `sentAt`. On 4xx/5xx → RETRYING
+ throw; BullMQ retries **attempts=3** with exponential 30s backoff.
`checkAndIncrementDailyCap()` uses
`redis.INCR email:daily_cap:{yyyy-MM-dd}` to honour the 100/day cap
(`EMAIL_DAILY_CAP` env-respected since M8). On third failure, the
`worker.on('failed')` handler inspects `job.attemptsMade >= job.opts.attempts`;
if final exhaustion, updates the Notification to `DEAD` with `failedAt`
+ `lastError` — the visible failure state Rule 6 requires. The M5 producer
mirrors M3's invariant: producer + enqueue are `.catch(log)` paths called
after tx commit, never awaited in any request handler — `rg` against
`await enqueueEmail` returns 0 matches outside the worker's SIGINT handler.
M8's TP-E1 proves the path: invalid `RESEND_API_KEY` injects a genuine 401;
BullMQ retries three times; rows end at DEAD with `failedAt` set; the booking
the notification is about stays CONFIRMED.
