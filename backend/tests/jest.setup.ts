// tests/jest.setup.ts
// Jest setup — wired before any test file runs. Sets sane env defaults
// for tests so validateEnv() in config/env.ts doesn't crash at boot.
//
// IMPORTANT: this file MUST run BEFORE `import './src/config/env'` or any
// backend module that reads process.env. The backend's config/env.ts does
// `validateEnv()` at module-load time.

// --- Load .env.test into process.env (no dotenv dependency).             ---
// Format: KEY="value" or KEY=value. Lines beginning with # are comments.
// Existing process.env entries are NOT overwritten — shell env wins, which
// allows CI to inject secrets while the file holds the non-secret defaults.
import * as fs from 'fs';
import * as path from 'path';

const envTestPath = path.resolve(__dirname, '..', '.env.test');
try {
  const raw = fs.readFileSync(envTestPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (line.trim().startsWith('#')) continue;
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) {
      process.env[m[1]] = v;
    }
  }
} catch (err) {
  // .env.test optional — fall through to per-var defaults below.
}

process.env.NODE_ENV = 'test';
// Force Node's TZ to UTC. Render's free Node service defaults to UTC, and the
// documented production assumption A10(M2-Correction-TZ) requires the server
// run at UTC. On dev workstations with non-UTC tz (e.g. IST), the local
// `Date.setHours(0,0,0,0)` calls in slotService.ts:72 and leaveService.ts:44
// would otherwise shift date-truncation by up to 1 day, breaking Rule 3.
process.env.TZ = 'UTC';
process.env.PORT = '0'; // random free port
process.env.APP_TZ = 'UTC';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.EMAIL_DAILY_CAP = '10000'; // disable cap for most tests
process.env.BOOKING_HOLD_TTL_SECONDS = '300';
process.env.BOOKING_CANCEL_CUTOFF_HOURS = '6';

// Real DATABASE_URL / UPSTASH_REDIS_TLS_URL must be supplied via .env before tests run.
// If they're missing the boot path is going to throw — that's OK, the test setup
// will surface it loudly.

// Stub JWT secrets — these can be any hex strings >= 32 bytes for integration
// tests; signature/randomness isn't a security concern in CI.
process.env.JWT_ACCESS_SECRET = 'a'.repeat(64);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(64);

// NVIDIA NIM: default to "invalid" so deterministic failure-mode tests pass
// without spending free-tier quota. Tests that need live NIM will set this
// before booting the test server.
process.env.NVIDIA_NIM_API_KEY = process.env.NVIDIA_NIM_API_KEY ?? 'test_invalid_nim_key';
process.env.NVIDIA_NIM_MODEL = process.env.NVIDIA_NIM_MODEL ?? 'meta/llama-3.1-70b-instruct';
process.env.NVIDIA_NIM_BASE_URL = process.env.NVIDIA_NIM_BASE_URL ?? 'https://integrate.api.nvidia.com/v1';
process.env.NVIDIA_NIM_TIMEOUT_MS = '2000';

// Resend: similar pattern — invalid by default; live tests override.
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? 'test_invalid_resend_key';
process.env.EMAIL_FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS ?? 'noreply@test.invalid';

// Google Calendar:
process.env.GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID ?? 'test-client-id';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? 'test-client-secret';
process.env.GOOGLE_OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI ?? 'http://localhost:3001/calendar/callback';
// 32-byte base64-encoded dummy key
process.env.OAUTH_TOKEN_ENC_KEY = process.env.OAUTH_TOKEN_ENC_KEY ?? Buffer.from('a'.repeat(32)).toString('base64');

// Ensure jest workers don't share env between iterations — re-set on each worker.
