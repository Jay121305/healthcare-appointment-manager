// backend/src/middleware/auth.ts
// Authentication middleware: JWT verification, role checks, and ownership validation

import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, JWTPayload } from '../utils/jwt';
import { prisma } from '../config/prisma';

declare global {
  namespace Express {
    interface Request {
      user: {
        id: string;
        role: 'PATIENT' | 'DOCTOR' | 'ADMIN';
      };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. JWT Verification Middleware
// ─────────────────────────────────────────────────────────────────────────────

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'UNAUTHENTICATED' });
    return;
  }

  const token = authHeader.slice(7);

  let payload: JWTPayload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    const error = err as Error;
    if (error.message.includes('expired')) {
      res.status(401).json({ error: 'TOKEN_EXPIRED' });
      return;
    }
    res.status(401).json({ error: 'INVALID_TOKEN' });
    return;
  }

  // Optional: deny-list check via Redis (for hard logout)
  // if (await redis.exists(`jwt-deny:${payload.jti}`)) {
  //   res.status(401).json({ error: 'TOKEN_REVOKED' });
  //   return;
  // }

  // Re-fetch user to ensure role/is_active are current
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, role: true, isActive: true },
  });

  if (!user || !user.isActive) {
    res.status(401).json({ error: 'USER_INACTIVE' });
    return;
  }

  // Compare JWT role with DB role
  if (payload.role !== user.role) {
    res.status(403).json({ error: 'ROLE_STALE' });
    return;
  }

  req.user = { id: user.id, role: user.role as 'PATIENT' | 'DOCTOR' | 'ADMIN' };
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Role Allow-List Factory
// ─────────────────────────────────────────────────────────────────────────────

export function requireRoles(...allowedRoles: ('PATIENT' | 'DOCTOR' | 'ADMIN')[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'UNAUTHENTICATED' });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({ error: 'FORBIDDEN' });
      return;
    }

    next();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Resource Ownership Factory
// ─────────────────────────────────────────────────────────────────────────────

interface ResourceLoaderResult {
  patientId?: string;
  doctorId?: string;
}

type ResourceLoader = (req: Request) => Promise<ResourceLoaderResult | null>;

export function requireOwnershipOrAdmin(loader: ResourceLoader) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!req.user) {
      res.status(401).json({ error: 'UNAUTHENTICATED' });
      return;
    }

    // Admin bypasses ownership for admin-scoped routes
    if (req.user.role === 'ADMIN') {
      next();
      return;
    }

    const resource = await loader(req);

    if (!resource) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }

    if (req.user.role === 'DOCTOR') {
      // Get the doctor_profile's user_id for this resource's doctor_id
      if (resource.doctorId) {
        const doctorProfile = await prisma.doctorProfile.findUnique({
          where: { id: resource.doctorId },
          select: { userId: true },
        });

        if (!doctorProfile || doctorProfile.userId !== req.user.id) {
          res.status(403).json({ error: 'NOT_OWNER' });
          return;
        }
      }
    } else if (req.user.role === 'PATIENT') {
      // Get the patient_profile's user_id for this resource's patient_id
      if (resource.patientId) {
        const patientProfile = await prisma.patientProfile.findUnique({
          where: { id: resource.patientId },
          select: { userId: true },
        });

        if (!patientProfile || patientProfile.userId !== req.user.id) {
          res.status(403).json({ error: 'NOT_OWNER' });
          return;
        }
      }
    }

    next();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Booking Loader (for requireOwnershipOrAdmin)
// ─────────────────────────────────────────────────────────────────────────────

export const bookingLoader: ResourceLoader = async (req: Request) => {
  return prisma.booking.findUnique({
    where: { id: req.params.id },
    select: { patientId: true, doctorId: true },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. Convenience middleware composition
// ─────────────────────────────────────────────────────────────────────────────

export function requireBookingAccess() {
  return [authenticate, requireRoles('PATIENT', 'DOCTOR', 'ADMIN'), requireOwnershipOrAdmin(bookingLoader)];
}