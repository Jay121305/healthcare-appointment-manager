// backend/src/config/redis.ts
// Redis client for ioredis (Upstash TCP/TLS) — shared with BullMQ queues

import { Redis } from 'ioredis';

const UPSTASH_REDIS_URL = process.env.UPSTASH_REDIS_TLS_URL!;

if (!UPSTASH_REDIS_URL) {
  throw new Error('UPSTASH_REDIS_TLS_URL environment variable is required');
}

// Single Redis client for holds, BullMQ, and calendar job tracking
export const redisClient = new Redis(UPSTASH_REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy: (times: number) => {
    if (times > 3) return null; // Stop retrying
    return Math.min(times * 50, 2000); // Exponential backoff up to 2s
  },
});

// Test connection on startup
redisClient.on('connect', () => {
  console.log('✅ Redis connected (Upstash TCP/TLS)');
});

redisClient.on('error', (err) => {
  console.error('❌ Redis error:', err.message);
});

// Helper: get hold key format
export function holdKey(doctorId: string, dateIso: string, startTimeIso: string): string {
  return `bh:${doctorId}:${dateIso}:${startTimeIso}`;
}

// Helper: get form payload key (same as hold key for simplicity)
export function formKey(doctorId: string, dateIso: string, startTimeIso: string): string {
  return `form:${doctorId}:${dateIso}:${startTimeIso}`;
}

// Export queue names for consistency
export const QUEUE_NAMES = {
  PRE_VISIT_SUMMARY: 'pre-visit-summary',
  EMAIL_NOTIFICATION: 'email-notification',
  CALENDAR_SYNC: 'calendar-sync',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// BullMQ connection helper
// BullMQ expects a connection object (not ioredis instance directly) when using
// Redis URL with TLS. We parse the URL to extract host/port/password.
// ─────────────────────────────────────────────────────────────────────────────

export function getRedisConnection(): {
  host: string;
  port: number;
  password: string;
  tls: Record<string, unknown> | undefined;
} {
  const url = new URL(UPSTASH_REDIS_URL);
  const password: string = url.password ?? '';
  return {
    host: url.hostname,
    port: parseInt(url.port || '6379', 10),
    password,
    tls: url.protocol === 'rediss:' ? {} : undefined,
  };
}