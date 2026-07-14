// backend/src/utils/jwt.ts
// JWT utilities for access and refresh tokens

import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET!;

export interface JWTPayload {
  sub: string;
  role: 'PATIENT' | 'DOCTOR' | 'ADMIN';
  iat: number;
  exp: number;
  jti: string;
}

export function generateAccessToken(userId: string, role: 'PATIENT' | 'DOCTOR' | 'ADMIN'): string {
  const jti = crypto.randomBytes(16).toString('hex');
  return jwt.sign(
    {
      sub: userId,
      role,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900, // 15 minutes
      jti,
    },
    ACCESS_SECRET,
    { algorithm: 'HS256' }
  );
}

export function generateRefreshToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(48).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, hash };
}

export function verifyAccessToken(token: string): JWTPayload {
  return jwt.verify(token, ACCESS_SECRET, { algorithms: ['HS256'] }) as JWTPayload;
}

export function verifyRefreshTokenHash(hash: string): string {
  return crypto.createHash('sha256').update(hash).digest('hex');
}