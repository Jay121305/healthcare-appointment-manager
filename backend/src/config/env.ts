// backend/src/config/env.ts
// Environment variable validation and exports

export function validateEnv(): void {
  const requiredVars = [
    'DATABASE_URL',
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
    'NVIDIA_NIM_API_KEY',
    'NVIDIA_NIM_MODEL',
    'RESEND_API_KEY',
    'EMAIL_FROM_ADDRESS',
    'UPSTASH_REDIS_TLS_URL',
    // M6 — Google Calendar OAuth + token encryption-at-rest
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_REDIRECT_URI',
    'OAUTH_TOKEN_ENC_KEY',
  ];

  const missing = requiredVars.filter((varName) => !process.env[varName]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  // M6: OAUTH_TOKEN_ENC_KEY must decode from base64 to exactly 32 raw bytes (AES-256-GCM).
  if (process.env.OAUTH_TOKEN_ENC_KEY) {
    const keyBuf = Buffer.from(process.env.OAUTH_TOKEN_ENC_KEY, 'base64');
    if (keyBuf.length !== 32) {
      throw new Error(
        `OAUTH_TOKEN_ENC_KEY must decode to exactly 32 bytes (got ${keyBuf.length}); ` +
        `generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
      );
    }
  }

  // Optional vars with defaults
  if (!process.env.APP_TZ) {
    process.env.APP_TZ = 'UTC';
  }
  if (!process.env.EMAIL_DAILY_CAP) {
    process.env.EMAIL_DAILY_CAP = '100';
  }
  if (!process.env.FOLLOW_UP_MAX_PER_BOOKING) {
    process.env.FOLLOW_UP_MAX_PER_BOOKING = '5';
  }
}

export const env = {
  databaseUrl: process.env.DATABASE_URL!,
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET!,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET!,
  appTz: process.env.APP_TZ || 'UTC',
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3001', 10),
  nvidiaNimApiKey: process.env.NVIDIA_NIM_API_KEY!,
  nvidiaNimModel: process.env.NVIDIA_NIM_MODEL!,
  nvidiaNimBaseUrl: process.env.NVIDIA_NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1',
  resendApiKey: process.env.RESEND_API_KEY!,
  emailFromAddress: process.env.EMAIL_FROM_ADDRESS!,
  emailDailyCap: parseInt(process.env.EMAIL_DAILY_CAP || '100', 10),
  upstashRedisUrl: process.env.UPSTASH_REDIS_TLS_URL!,
  followUpMaxPerBooking: parseInt(process.env.FOLLOW_UP_MAX_PER_BOOKING || '5', 10),
};