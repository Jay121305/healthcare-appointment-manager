// backend/src/services/calendar/oauthService.ts
// Google OAuth 2.0 client, token storage (encrypted at rest), and refresh logic.
// Populate one OauthToken row per User (userId @unique in schema).

import { google, Auth } from 'googleapis';
import { prisma } from '../../config/prisma';
import { redisClient } from '../../config/redis';
import { encrypt, decrypt } from './encryption';

// ─────────────────────────────────────────────────────────────────────────────
// Scope: read/write events only (least privilege)
// ─────────────────────────────────────────────────────────────────────────────
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const STATE_TTL_SECONDS = 600;          // 10 min
const SKEW_BUFFER_MS = 60_000;          // refresh 60s before actual expiry
const REFRESH_LOCK_TTL_SECONDS = 30;    // serialize concurrent refreshes for one user
const REFRESH_POLL_INTERVAL_MS = 50;
const REFRESH_POLL_ATTEMPTS = 6;

// ─────────────────────────────────────────────────────────────────────────────
// OAuth2 client (singleton)
// ─────────────────────────────────────────────────────────────────────────────
let cachedOAuthClient: Auth.OAuth2Client | null = null;

export function getOAuthClient(): Auth.OAuth2Client {
  if (cachedOAuthClient) return cachedOAuthClient;
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REDIRECT_URI env vars are required for M6'
    );
  }
  cachedOAuthClient = new Auth.OAuth2Client({
    clientId,
    clientSecret,
    redirectUri,
  });
  return cachedOAuthClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// State token (CSRF protection) — stored in Upstash Redis under oauth_state:{state}
// ─────────────────────────────────────────────────────────────────────────────
interface OAuthStatePayload {
  userId: string;
  role: 'PATIENT' | 'DOCTOR';
  createdAt: number;
}

const stateKey = (state: string) => `oauth_state:${state}`;
const refreshLockKey = (userId: string) => `oauth_refresh_lock:${userId}`;

export async function generateAndStoreState(
  userId: string,
  role: 'PATIENT' | 'DOCTOR'
): Promise<string> {
  const state = cryptoRandomHex(16);
  const payload: OAuthStatePayload = { userId, role, createdAt: Date.now() };
  await redisClient.set(stateKey(state), JSON.stringify(payload), 'EX', STATE_TTL_SECONDS);
  return state;
}

export async function consumeState(state: string): Promise<OAuthStatePayload | null> {
  const raw = await redisClient.get(stateKey(state));
  if (!raw) return null;
  // Single-use: delete immediately regardless of subsequent success/failure
  await redisClient.del(stateKey(state)).catch(() => {});
  try {
    return JSON.parse(raw) as OAuthStatePayload;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Build the Google consent URL
// ─────────────────────────────────────────────────────────────────────────────
export function buildAuthUrl(state: string): string {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: [CALENDAR_SCOPE],
    state,
    // Force consent so we always receive a refresh_token (re-connect still fine).
    prompt: 'consent',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Exchange authorization code for tokens (called from /calendar/callback)
// Stores the encrypted tokens as a single OauthToken row upsert keyed by userId.
// Returns the connected user's Google email (best-effort; null on failure).
// ─────────────────────────────────────────────────────────────────────────────
export async function exchangeCodeAndStore(
  code: string,
  userId: string
): Promise<{ connectedAt: Date; googleEmail: string | null }> {
  const client = getOAuthClient();
  const tokenResponse = await client.getToken(code);
  const tokens = tokenResponse.tokens;
  if (!tokens.access_token || !tokens.expiry_date) {
    throw new Error('OAUTH_EXCHANGE_FAILED: Google did not return access_token or expiry_date');
  }
  // refresh_token may be absent on subsequent reconnects; keep the existing one if so.
  const existing = await prisma.oauthToken.findUnique({ where: { userId } });
  const refreshTokenToStore =
    tokens.refresh_token ?? (existing ? decrypt(existing.refreshToken) : null);
  if (!refreshTokenToStore) {
    throw new Error('OAUTH_EXCHANGE_FAILED: no refresh_token from Google and none previously stored');
  }

  await prisma.oauthToken.upsert({
    where: { userId },
    create: {
      userId,
      accessToken: encrypt(tokens.access_token),
      refreshToken: encrypt(refreshTokenToStore),
      scope: tokens.scope ?? CALENDAR_SCOPE,
      tokenType: tokens.token_type ?? 'Bearer',
      expiryDate: new Date(tokens.expiry_date),
    },
    update: {
      accessToken: encrypt(tokens.access_token),
      refreshToken: encrypt(refreshTokenToStore),
      scope: tokens.scope ?? CALENDAR_SCOPE,
      tokenType: tokens.token_type ?? 'Bearer',
      expiryDate: new Date(tokens.expiry_date),
    },
  });

  // Best-effort: fetch the user's Google email so the portal can display it.
  let googleEmail: string | null = null;
  try {
    client.setCredentials({ access_token: tokens.access_token });
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const info = await oauth2.tokeninfo({ access_token: tokens.access_token });
    googleEmail = info.data.email ?? null;
  } catch {
    // Non-fatal — status endpoint will still report connected=true
  }

  return { connectedAt: new Date(), googleEmail };
}

// ─────────────────────────────────────────────────────────────────────────────
// Disconnect: revoke at Google best-effort, then delete the OauthToken row.
// Per spec §1.5: we do NOT clear CalendarEvent.eventId values; future cancel
// jobs can still delete the orphaned Google event if the user later reconnects.
// ─────────────────────────────────────────────────────────────────────────────
export async function disconnect(userId: string): Promise<boolean> {
  const existing = await prisma.oauthToken.findUnique({ where: { userId } });
  if (!existing) return false;

  // Best-effort revoke at Google side
  try {
    const client = getOAuthClient();
    const refreshToken = decrypt(existing.refreshToken);
    await client.revokeToken(refreshToken);
  } catch (err) {
    // Already revoked, network error, etc. — log only, do not block.
    console.warn(`[OAuth] Revoke failed for user ${userId}:`, (err as Error).message);
  }

  await prisma.oauthToken.delete({ where: { userId } });
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Get a valid (potentially refreshed) access token for a user.
// Returns null when:
//   - the user has no OauthToken row (never connected)
//   - Google returns invalid_grant (refresh token revoked) — row is deleted
// Caller MUST handle null by skipping that party's calendar event silently (Rule 8).
// ─────────────────────────────────────────────────────────────────────────────
export async function getValidAccessToken(userId: string): Promise<string | null> {
  const row = await prisma.oauthToken.findUnique({ where: { userId } });
  if (!row) return null;

  const accessPlain = decrypt(row.accessToken);
  const refreshToken = decrypt(row.refreshToken);

  // Still valid (with 60s skew buffer)?
  if (row.expiryDate.getTime() - Date.now() > SKEW_BUFFER_MS) {
    return accessPlain;
  }

  // Need to refresh — acquire a short-lived Redis lock to serialize concurrent
  // refreshes for the same user (multiple BullMQ jobs may race).
  const lockKey = refreshLockKey(userId);
  const acquired = await redisClient.set(lockKey, '1', 'EX', REFRESH_LOCK_TTL_SECONDS, 'NX');
  if (acquired !== 'OK') {
    // Another caller is refreshing — short-poll then re-read the DB row.
    for (let i = 0; i < REFRESH_POLL_ATTEMPTS; i++) {
      await sleep(REFRESH_POLL_INTERVAL_MS);
      const refreshed = await prisma.oauthToken.findUnique({ where: { userId } });
      if (refreshed && refreshed.updatedAt > row.updatedAt) {
        return decrypt(refreshed.accessToken);
      }
    }
    // Lock holder may have failed; fall through to attempt our own refresh.
  }

  try {
    const client = getOAuthClient();
    client.setCredentials({
      refresh_token: refreshToken,
      access_token: accessPlain,
      expiry_date: row.expiryDate.getTime(),
    });
    const res = await client.refreshAccessToken();
    const newTokens = res.credentials;
    if (!newTokens.access_token || !newTokens.expiry_date) {
      throw new Error('refresh returned no access_token or expiry_date');
    }
    const newRefresh = newTokens.refresh_token ?? refreshToken; // Google rarely rotates

    await prisma.oauthToken.update({
      where: { userId },
      data: {
        accessToken: encrypt(newTokens.access_token),
        refreshToken: encrypt(newRefresh),
        expiryDate: new Date(newTokens.expiry_date),
        scope: newTokens.scope ?? row.scope,
      },
    });
    return newTokens.access_token;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // If refresh token was revoked by user in Google Account settings → delete row.
    if (msg.includes('invalid_grant') || /invalid_grant/i.test(msg)) {
      console.warn(
        `[OAuth] refresh_token revoked for user ${userId}; deleting OauthToken row. User must re-connect.`
      );
      await prisma.oauthToken.delete({ where: { userId } }).catch(() => {});
      return null;
    }
    // Other errors (5xx, network) — rethrow so BullMQ can retry the whole job.
    throw err;
  } finally {
    await redisClient.del(lockKey).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Status query — used by /calendar/status
// ─────────────────────────────────────────────────────────────────────────────
export async function getConnectionStatus(
  userId: string
): Promise<{ connected: boolean; connectedAt: string | null; googleEmail: string | null }> {
  const row = await prisma.oauthToken.findUnique({ where: { userId } });
  if (!row) {
    return { connected: false, connectedAt: null, googleEmail: null };
  }
  // Best-effort fetch of Google email; do not fail on tokeninfo errors.
  let googleEmail: string | null = null;
  try {
    const accessToken = decrypt(row.accessToken);
    const client = getOAuthClient();
    client.setCredentials({ access_token: accessToken });
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const info = await oauth2.tokeninfo({ access_token: accessToken });
    googleEmail = info.data.email ?? null;
  } catch {
    // fall through — connected=true with unknown email
  }
  return {
    connected: true,
    connectedAt: row.createdAt.toISOString(),
    googleEmail,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────
// Use Node global crypto (matches pattern in bookingService.ts generateHoldToken)
import crypto from 'crypto';
function cryptoRandomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
