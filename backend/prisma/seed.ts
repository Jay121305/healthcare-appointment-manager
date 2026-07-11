// backend/prisma/seed.ts
// Seed script: creates one admin, one sample doctor, and one sample patient

import { PrismaClient, Role } from '@prisma/client';
import { hashPassword } from '../src/utils/passwordHash';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log('🌱 Starting database seed...');

  // ────────────────────────────────────────────────────────────────────────────
  // ADMIN USER
  // ────────────────────────────────────────────────────────────────────────────
  const adminEmail = 'admin@healthcare.local';
  const adminPassword = 'AdminPass123!';

  const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!existingAdmin) {
    await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: await hashPassword(adminPassword),
        role: Role.ADMIN,
        isActive: true,
      },
    });
    console.log('✅ Admin user created');
  } else {
    console.log('⏭️  Admin user already exists');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // SAMPLE DOCTOR
  // ────────────────────────────────────────────────────────────────────────────
  const doctorEmail = 'doctor@healthcare.local';
  const doctorPassword = 'DoctorPass123!';

  const existingDoctor = await prisma.user.findUnique({ where: { email: doctorEmail } });
  if (!existingDoctor) {
    await prisma.user.create({
      data: {
        email: doctorEmail,
        passwordHash: await hashPassword(doctorPassword),
        role: Role.DOCTOR,
        isActive: true,
        doctorProfile: {
          create: {
            fullName: 'Dr. Sarah Mitchell',
            specialisation: 'Cardiology',
            workingHours: {
              mon: { start: '09:00', end: '17:00' },
              tue: { start: '09:00', end: '17:00' },
              wed: { start: '09:00', end: '17:00' },
              thu: { start: '09:00', end: '17:00' },
              fri: { start: '09:00', end: '15:00' },
              sat: null,
              sun: null,
            },
            slotDurationMinutes: 30,
            phone: '+1-555-0123',
          },
        },
      },
      include: { doctorProfile: true },
    });
    console.log('✅ Sample doctor created: Dr. Sarah Mitchell');
  } else {
    console.log('⏭️  Sample doctor already exists');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // SAMPLE PATIENT
  // ────────────────────────────────────────────────────────────────────────────
  const patientEmail = 'patient@healthcare.local';
  const patientPassword = 'PatientPass123!';

  const existingPatient = await prisma.user.findUnique({ where: { email: patientEmail } });
  if (!existingPatient) {
    await prisma.user.create({
      data: {
        email: patientEmail,
        passwordHash: await hashPassword(patientPassword),
        role: Role.PATIENT,
        isActive: true,
        patientProfile: {
          create: {
            fullName: 'John Doe',
            dateOfBirth: new Date('1985-06-15'),
            gender: 'MALE',
            phone: '+1-555-0456',
            address: '123 Main St, Anytown, USA',
            bloodGroup: 'O+',
          },
        },
      },
      include: { patientProfile: true },
    });
    console.log('✅ Sample patient created: John Doe');
  } else {
    console.log('⏭️  Sample patient already exists');
  }

  console.log('🎉 Seed completed successfully!');
  console.log('\n📋 Test credentials:');
  console.log(`   Admin:    ${adminEmail} / ${adminPassword}`);
  console.log(`   Doctor:   ${doctorEmail} / ${doctorPassword}`);
  console.log(`   Patient:  ${patientEmail} / ${patientPassword}`);
}

main()
  .catch((err) => {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });