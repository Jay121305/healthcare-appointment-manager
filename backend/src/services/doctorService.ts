// backend/src/services/doctorService.ts
// Doctor profile service: CRUD operations for admin

import { Prisma, Role } from '@prisma/client';
import { prisma } from '../config/prisma';
import { hashPassword } from '../utils/passwordHash';

export interface CreateDoctorInput {
  email: string;
  password: string;
  fullName: string;
  specialisation: string;
  workingHours: Prisma.InputJsonValue;
  slotDurationMinutes?: number;
  phone?: string | null;
}

export interface UpdateDoctorInput {
  fullName?: string;
  specialisation?: string;
  workingHours?: Prisma.InputJsonValue;
  slotDurationMinutes?: number;
  phone?: string | null;
  isActive?: boolean;
}

export interface DoctorListParams {
  page?: number;
  limit?: number;
  specialisation?: string;
  q?: string;
}

export interface DoctorWithUser {
  id: string;
  userId: string;
  fullName: string;
  email: string;
  specialisation: string;
  workingHours: object;
  slotDurationMinutes: number;
  phone: string | null;
  isActive: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// List doctors (paginated, with filters)
// ─────────────────────────────────────────────────────────────────────────────

export async function listDoctors(params: DoctorListParams): Promise<{
  items: DoctorWithUser[];
  total: number;
  page: number;
  limit: number;
}> {
  const page = Math.max(1, params.page || 1);
  const limit = Math.min(100, Math.max(1, params.limit || 20));
  const skip = (page - 1) * limit;

  const where: Prisma.UserWhereInput = {};

  if (params.specialisation) {
    where.doctorProfile = {
      specialisation: {
        contains: params.specialisation,
        mode: 'insensitive',
      },
    };
  }

  if (params.q) {
    where.OR = [
      { email: { contains: params.q, mode: 'insensitive' } },
      { doctorProfile: { fullName: { contains: params.q, mode: 'insensitive' } } },
    ];
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where: {
        ...where,
        role: Role.DOCTOR,
      },
      include: {
        doctorProfile: true,
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.user.count({
      where: {
        ...where,
        role: Role.DOCTOR,
      },
    }),
  ]);

  const items = users.map((user) => {
    const profile = user.doctorProfile!;
    return {
      id: profile.id,
      userId: profile.userId,
      fullName: profile.fullName,
      email: user.email,
      specialisation: profile.specialisation,
      workingHours: profile.workingHours as object,
      slotDurationMinutes: profile.slotDurationMinutes,
      phone: profile.phone,
      isActive: user.isActive,
    };
  });

  return { items, total, page, limit };
}

// ─────────────────────────────────────────────────────────────────────────────
// Get single doctor by ID
// ─────────────────────────────────────────────────────────────────────────────

export async function getDoctorById(doctorId: string): Promise<DoctorWithUser & {
  leaveDays: { leaveDate: Date; reason: string | null }[];
} | null> {
  const user = await prisma.user.findFirst({
    where: {
      id: {
        in: [
          await prisma.doctorProfile.findUnique({
            where: { id: doctorId },
            select: { userId: true },
          }).then((p) => p?.userId || ''),
        ],
      },
      role: Role.DOCTOR,
    },
    include: {
      doctorProfile: {
        include: {
          leaveDays: {
            orderBy: { leaveDate: 'asc' },
          },
        },
      },
    },
  });

  if (!user || !user.doctorProfile) return null;

  const profile = user.doctorProfile;
  return {
    id: profile.id,
    userId: profile.userId,
    fullName: profile.fullName,
    email: user.email,
    specialisation: profile.specialisation,
    workingHours: profile.workingHours as object,
    slotDurationMinutes: profile.slotDurationMinutes,
    phone: profile.phone,
    isActive: user.isActive,
    leaveDays: profile.leaveDays.map((ld) => ({
      leaveDate: ld.leaveDate,
      reason: ld.reason,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Create doctor (admin creates user + profile in one transaction)
// ─────────────────────────────────────────────────────────────────────────────

export async function createDoctor(input: CreateDoctorInput): Promise<DoctorWithUser> {
  const normalizedEmail = input.email.toLowerCase().trim();

  const result = await prisma.$transaction(async (tx) => {
    const existingUser = await tx.user.findUnique({ where: { email: normalizedEmail } });
    if (existingUser) {
      throw new Error('USER_EXISTS');
    }

    const user = await tx.user.create({
      data: {
        email: normalizedEmail,
        passwordHash: await hashPassword(input.password),
        role: Role.DOCTOR,
        isActive: true,
        doctorProfile: {
          create: {
            fullName: input.fullName,
            specialisation: input.specialisation,
            workingHours: input.workingHours,
            slotDurationMinutes: input.slotDurationMinutes || 30,
            phone: input.phone || null,
          },
        },
      },
      include: {
        doctorProfile: true,
      },
    });

    return user;
  });

  if (!result.doctorProfile) {
    throw new Error('DOCTOR_PROFILE_NOT_CREATED');
  }

  return {
    id: result.doctorProfile.id,
    userId: result.doctorProfile.userId,
    fullName: result.doctorProfile.fullName,
    email: result.email,
    specialisation: result.doctorProfile.specialisation,
    workingHours: result.doctorProfile.workingHours as object,
    slotDurationMinutes: result.doctorProfile.slotDurationMinutes,
    phone: result.doctorProfile.phone,
    isActive: result.isActive,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Update doctor profile
// ─────────────────────────────────────────────────────────────────────────────

export async function updateDoctor(doctorId: string, input: UpdateDoctorInput): Promise<DoctorWithUser> {
  const result = await prisma.$transaction(async (tx) => {
    const doctorProfile = await tx.doctorProfile.findUnique({
      where: { id: doctorId },
      include: { user: true },
    });

    if (!doctorProfile) {
      throw new Error('DOCTOR_NOT_FOUND');
    }

    const updateData: Prisma.DoctorProfileUpdateInput = {};
    const userUpdateData: Prisma.UserUpdateInput = {};

    if (input.fullName !== undefined) updateData.fullName = input.fullName;
    if (input.specialisation !== undefined) updateData.specialisation = input.specialisation;
    if (input.workingHours !== undefined) updateData.workingHours = input.workingHours;
    if (input.slotDurationMinutes !== undefined) updateData.slotDurationMinutes = input.slotDurationMinutes;
    if (input.phone !== undefined) updateData.phone = input.phone;

    if (input.isActive !== undefined) {
      userUpdateData.isActive = input.isActive;

      // If deactivating, revoke all refresh tokens for this user
      if (input.isActive === false) {
        await tx.refreshToken.updateMany({
          where: { userId: doctorProfile.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    }

    const updatedProfile = await tx.doctorProfile.update({
      where: { id: doctorId },
      data: updateData,
      include: { user: true },
    });

    if (input.isActive !== undefined) {
      await tx.user.update({
        where: { id: doctorProfile.userId },
        data: userUpdateData,
      });
    }

    return updatedProfile;
  });

  return {
    id: result.id,
    userId: result.userId,
    fullName: result.fullName,
    email: result.user.email,
    specialisation: result.specialisation,
    workingHours: result.workingHours as object,
    slotDurationMinutes: result.slotDurationMinutes,
    phone: result.phone,
    isActive: result.user.isActive,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Soft delete doctor (deactivate + revoke tokens)
// ─────────────────────────────────────────────────────────────────────────────

export async function softDeleteDoctor(doctorId: string): Promise<{ hasUpcomingBookings: boolean; bookingIds: string[] }> {
  const result = await prisma.$transaction(async (tx) => {
    const doctorProfile = await tx.doctorProfile.findUnique({
      where: { id: doctorId },
      include: { user: true },
    });

    if (!doctorProfile) {
      throw new Error('DOCTOR_NOT_FOUND');
    }

    // Check for upcoming active bookings
    const upcomingBookings = await tx.booking.findMany({
      where: {
        doctorId,
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
        bookingDate: { gte: new Date() },
      },
      select: { id: true },
    });

    if (upcomingBookings.length > 0) {
      return { hasUpcomingBookings: true, bookingIds: upcomingBookings.map((b) => b.id) };
    }

    // Revoke refresh tokens
    await tx.refreshToken.updateMany({
      where: { userId: doctorProfile.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // Soft delete
    await tx.user.update({
      where: { id: doctorProfile.userId },
      data: { isActive: false },
    });

    return { hasUpcomingBookings: false, bookingIds: [] };
  });

  return result;
}