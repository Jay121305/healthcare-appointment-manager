// backend/src/routes/visits/index.ts
// Visits routes: doctor notes submission for post-visit summaries

import { Router, Request, Response } from 'express';
import { authenticate, requireRoles } from '../../middleware/auth';
import { prisma } from '../../config/prisma';
import { postVisitQueue } from '../../workers/postVisitWorker';
import { medicationReminderQueue } from '../../workers/medicationReminderWorker';
import { generateReminderTimes } from '../../services/notification/medicationScheduler';

const router = Router();

// All visit routes require authentication
router.use(authenticate);

// ─────────────────────────────────────────────────────────────────────────────
// POST /visits/:bookingId/notes — doctor submits clinical notes
// Triggers post-visit LLM summary generation (Rule 4: async, after commit)
// ─────────────────────────────────────────────────────────────────────────────

router.post('/:bookingId/notes', requireRoles('DOCTOR'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params;
    const { notes } = req.body;

    if (!notes || typeof notes !== 'string' || !notes.trim()) {
      res.status(400).json({ error: 'NOTES_REQUIRED', message: 'Clinical notes are required' });
      return;
    }

    // Verify booking exists and doctor owns it
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        doctor: { include: { user: { select: { id: true } } } },
        postVisitSummary: true,
      },
    });

    if (!booking) {
      res.status(404).json({ error: 'BOOKING_NOT_FOUND' });
      return;
    }

    // Ownership check: only the assigned doctor can submit notes
    if (booking.doctor.user.id !== req.user.id) {
      res.status(403).json({ error: 'NOT_OWNER', message: 'You are not the assigned doctor for this booking' });
      return;
    }

    // Only allow notes on confirmed or completed bookings
    if (booking.status !== 'CONFIRMED' && booking.status !== 'COMPLETED') {
      res.status(400).json({ error: 'INVALID_BOOKING_STATUS', message: 'Notes can only be submitted for confirmed or completed appointments' });
      return;
    }

    // Upsert PostVisitSummary with doctor notes
    const postVisit = await prisma.postVisitSummary.upsert({
      where: { bookingId },
      update: {
        doctorNotes: notes.trim(),
        llmStatus: 'PENDING', // Reset status for new LLM generation
        summaryText: '',
        retryCount: 0,
        generatedAt: null,
      },
      create: {
        bookingId,
        doctorNotes: notes.trim(),
        llmStatus: 'PENDING',
        summaryText: '',
      },
    });

    // Queue LLM job (Rule 4: async, non-blocking, after commit)
    try {
      postVisitQueue.add('generate', { bookingId }).catch(err => {
        console.error('[Visits] Failed to queue post-visit summary:', err);
      });
    } catch (err) {
      console.error('[Visits] Failed to queue post-visit summary:', err);
    }

    // M5 Part E2: Create medication reminders from prescriptions for this booking
    try {
      const prescriptions = await prisma.prescription.findMany({
        where: { bookingId },
      });

      for (const rx of prescriptions) {
        const reminders = generateReminderTimes(
          rx.id,
          rx.patientId,
          rx.frequency,
          rx.frequencyCustom,
          rx.startDate,
          rx.endDate,
          'UTC'
        );

        if (reminders.length > 0) {
          // Bulk create medication_reminders rows
          await prisma.medicationReminder.createMany({
            data: reminders.map((r) => ({
              prescriptionId: rx.id,
              patientId: rx.patientId,
              remindAt: r.remindAt,
              status: 'PENDING',
            })),
            skipDuplicates: true,
          });

          // Enqueue BullMQ delayed jobs for each reminder
          for (const r of reminders) {
            const delay = r.remindAt.getTime() - Date.now();
            if (delay > 0) {
              await medicationReminderQueue.add('send-reminder', {
                prescriptionId: rx.id,
                patientId: rx.patientId,
                medicationName: rx.medicationName,
                dosage: rx.dosage,
                instructions: rx.instructions,
                doseNumber: r.doseNumber,
                totalDoses: r.totalDoses,
              }, {
                delay,
                attempts: 3,
                backoff: { type: 'exponential', delay: 30_000 },
                removeOnComplete: 200,
                removeOnFail: false,
              });
            }
          }
        }
      }
    } catch (err) {
      console.error('[Visits] Failed to create medication reminders:', err);
    }

    res.status(200).json({
      message: 'Notes submitted successfully. Post-visit summary generation queued.',
      postVisitSummary: {
        id: postVisit.id,
        bookingId: postVisit.bookingId,
        llmStatus: postVisit.llmStatus,
      },
    });
  } catch (err) {
    console.error('Submit notes error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /visits/:bookingId/summary — get post-visit summary (patient or doctor)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:bookingId/summary', requireRoles('PATIENT', 'DOCTOR'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params;

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        patient: { include: { user: { select: { id: true } } } },
        doctor: { include: { user: { select: { id: true } } } },
        postVisitSummary: true,
      },
    });

    if (!booking) {
      res.status(404).json({ error: 'BOOKING_NOT_FOUND' });
      return;
    }

    // Ownership check: patient or assigned doctor
    const isPatient = booking.patient.user.id === req.user.id;
    const isDoctor = booking.doctor.user.id === req.user.id;

    if (!isPatient && !isDoctor) {
      res.status(403).json({ error: 'NOT_AUTHORIZED', message: 'You do not have access to this summary' });
      return;
    }

    if (!booking.postVisitSummary) {
      res.status(404).json({ error: 'SUMMARY_NOT_FOUND', message: 'Post-visit summary not yet generated' });
      return;
    }

    res.status(200).json({
      bookingId,
      summaryText: booking.postVisitSummary.summaryText,
      llmStatus: booking.postVisitSummary.llmStatus,
      retryCount: booking.postVisitSummary.retryCount,
      generatedAt: booking.postVisitSummary.generatedAt,
      doctorNotes: isDoctor ? booking.postVisitSummary.doctorNotes : undefined, // Only doctor sees raw notes
    });
  } catch (err) {
    console.error('Get summary error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export default router;