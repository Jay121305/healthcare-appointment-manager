// backend/src/services/calendar/encryption.ts
// AES-256-GCM encryption-at-rest for Google OAuth access/refresh tokens.
// Reserved env: OAUTH_TOKEN_ENC_KEY (base64-encoded 32-byte raw key).
// Storage format: base64(iv(12) || ciphertext || tag(16))  — single string,
// fits in the existing OauthToken.accessToken / refreshToken text columns.

import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;       // 96-bit IV recommended for GCM
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.OAUTH_TOKEN_ENC_KEY;
  if (!raw) {
    throw new Error('OAUTH_TOKEN_ENC_KEY environment variable is required for M6 calendar sync');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `OAUTH_TOKEN_ENC_KEY must decode to exactly 32 bytes (got ${key.length}); ` +
      `generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }
  cachedKey = key;
  return key;
}

/**
 * Encrypt a plaintext string into base64(iv || ciphertext || tag).
 * Returns null for null/undefined input (no toggle needed for optional fields).
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString('base64');
}

/**
 * Decrypt a base64(iv || ciphertext || tag) string back to plaintext.
 * Throws on tampering / wrong key (GCM auth tag mismatch) — caller must catch
 * and surface as "token decryption failed; re-connect Google Calendar".
 */
export function decrypt(blob: string): string {
  const key = getKey();
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error('Encrypted token blob too short');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}
