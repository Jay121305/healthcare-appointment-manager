// backend/src/routes/auth.ts
// Authentication routes: signup, login, refresh, logout

import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { hashPassword, verifyPassword } from '../utils/passwordHash';
import { generateAccessToken, generateRefreshToken } from '../utils/jwt';
import { authenticate } from '../middleware/auth';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// POST /auth/signup/patient
// ─────────────────────────────────────────────────────────────────────────────

router.post('/signup/patient', async (req: Request, res: Response): Promise<void> => {
  const { email, password, fullName, dateOfBirth, gender, phone, address, bloodGroup } = req.body;

  // Basic validation
  if (!email || !password || !fullName) {
    res.status(400).json({ error: 'EMAIL_PASSWORD_FULLNAME_REQUIRED' });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Check if user exists
      const existingUser = await tx.user.findUnique({ where: { email: normalizedEmail } });
      if (existingUser) {
        throw new Error('USER_EXISTS');
      }

      // Create user with patient profile
      const user = await tx.user.create({
        data: {
          email: normalizedEmail,
          passwordHash: await hashPassword(password),
          role: 'PATIENT',
          isActive: true,
          patientProfile: {
            create: {
              fullName,
              dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
              gender: gender || null,
              phone: phone || null,
              address: address || null,
              bloodGroup: bloodGroup || null,
            },
          },
        },
        include: {
          patientProfile: true,
        },
      });

      return user;
    });

    // Generate tokens
    const accessToken = generateAccessToken(result.id, 'PATIENT');
    const { token: refreshToken, hash: refreshTokenHash } = generateRefreshToken();

    // Store refresh token hash
    await prisma.refreshToken.create({
      data: {
        userId: result.id,
        tokenHash: refreshTokenHash,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      },
    });

    res.status(201).json({
      message: 'Patient signup successful',
      accessToken,
      refreshToken,
      user: {
        id: result.id,
        email: result.email,
        role: result.role,
        profile: result.patientProfile,
      },
    });
  } catch (err) {
    const error = err as Error;
    if (error.message === 'USER_EXISTS') {
      res.status(409).json({ error: 'USER_EXISTS' });
      return;
    }
    console.error('Signup error:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /auth/signup/doctor
// ─────────────────────────────────────────────────────────────────────────────

router.post('/signup/doctor', async (req: Request, res: Response): Promise<void> => {
  const { email, password, fullName, specialisation, workingHours, slotDurationMinutes, phone } = req.body;

  if (!email || !password || !fullName || !specialisation || !workingHours) {
    res.status(400).json({ error: 'REQUIRED_FIELDS_MISSING' });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existingUser = await tx.user.findUnique({ where: { email: normalizedEmail } });
      if (existingUser) {
        throw new Error('USER_EXISTS');
      }

      const user = await tx.user.create({
        data: {
          email: normalizedEmail,
          passwordHash: await hashPassword(password),
          role: 'DOCTOR',
          isActive: true,
          doctorProfile: {
            create: {
              fullName,
              specialisation,
              workingHours: workingHours as object,
              slotDurationMinutes: slotDurationMinutes || 30,
              phone: phone || null,
            },
          },
        },
        include: {
          doctorProfile: true,
        },
      });

      return user;
    });

    const accessToken = generateAccessToken(result.id, 'DOCTOR');
    const { token: refreshToken, hash: refreshTokenHash } = generateRefreshToken();

    await prisma.refreshToken.create({
      data: {
        userId: result.id,
        tokenHash: refreshTokenHash,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    res.status(201).json({
      message: 'Doctor signup successful',
      accessToken,
      refreshToken,
      user: {
        id: result.id,
        email: result.email,
        role: result.role,
        profile: result.doctorProfile,
      },
    });
  } catch (err) {
    const error = err as Error;
    if (error.message === 'USER_EXISTS') {
      res.status(409).json({ error: 'USER_EXISTS' });
      return;
    }
    console.error('Doctor signup error:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /auth/login
// ─────────────────────────────────────────────────────────────────────────────

router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'EMAIL_PASSWORD_REQUIRED' });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();

  try {
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: {
        doctorProfile: true,
        patientProfile: true,
      },
    });

    if (!user || !user.isActive) {
      res.status(401).json({ error: 'INVALID_CREDENTIALS' });
      return;
    }

    const validPassword = await verifyPassword(password, user.passwordHash);
    if (!validPassword) {
      res.status(401).json({ error: 'INVALID_CREDENTIALS' });
      return;
    }

    const accessToken = generateAccessToken(user.id, user.role as 'PATIENT' | 'DOCTOR' | 'ADMIN');
    const { token: refreshToken, hash: refreshTokenHash } = generateRefreshToken();

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: refreshTokenHash,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    const profile = user.role === 'DOCTOR' ? user.doctorProfile : user.patientProfile;

    res.json({
      message: 'Login successful',
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        profile,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /auth/refresh
// ─────────────────────────────────────────────────────────────────────────────

router.post('/refresh', async (req: Request, res: Response): Promise<void> => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    res.status(400).json({ error: 'REFRESH_TOKEN_REQUIRED' });
    return;
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

    const storedToken = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!storedToken) {
      res.status(401).json({ error: 'INVALID_REFRESH_TOKEN' });
      return;
    }

    if (storedToken.revokedAt || storedToken.expiresAt < new Date()) {
      res.status(401).json({ error: 'REFRESH_TOKEN_EXPIRED_OR_REVOKED' });
      return;
    }

    // Token reuse detection: if this token was already rotated, revoke entire chain
    if (storedToken.replacedById) {
      // Revoke all tokens in this chain
      await prisma.refreshToken.updateMany({
        where: { userId: storedToken.userId },
        data: { revokedAt: new Date() },
      });
      res.status(401).json({ error: 'TOKEN_REUSE_DETECTED' });
      return;
    }

    // Rotate: mark current as replaced
    await prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: {
        replacedById: storedToken.id, // self-reference for chain tracking
      },
    });

    // Create new refresh token
    const { token: newRefreshToken, hash: newRefreshTokenHash } = generateRefreshToken();
    const newRefreshTokenRecord = await prisma.refreshToken.create({
      data: {
        userId: storedToken.userId,
        tokenHash: newRefreshTokenHash,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        replacedById: storedToken.id,
      },
    });

    // Update the previous token to point to the new one
    await prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: { replacedById: newRefreshTokenRecord.id },
    });

    const newAccessToken = generateAccessToken(
      storedToken.userId,
      storedToken.user.role as 'PATIENT' | 'DOCTOR' | 'ADMIN'
    );

    res.json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });
  } catch (err) {
    console.error('Refresh error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /auth/logout
// ─────────────────────────────────────────────────────────────────────────────

router.post('/logout', authenticate, async (req: Request, res: Response): Promise<void> => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    res.status(400).json({ error: 'REFRESH_TOKEN_REQUIRED' });
    return;
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

    await prisma.refreshToken.updateMany({
      where: {
        userId: req.user.id,
        tokenHash,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /auth/me
// ─────────────────────────────────────────────────────────────────────────────

router.get('/me', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        doctorProfile: true,
        patientProfile: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: 'USER_NOT_FOUND' });
      return;
    }

    const profile = user.role === 'DOCTOR' ? user.doctorProfile : user.patientProfile;

    res.json({
      id: user.id,
      email: user.email,
      role: user.role,
      profile,
    });
  } catch (err) {
    console.error('Get me error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

import crypto from 'crypto';

export default router;