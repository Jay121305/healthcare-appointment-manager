// backend/src/routes/chat/index.ts
// Follow-up Q&A + regenerate endpoints for post-visit summaries

import { Router, Request, Response } from 'express';
import { authenticate, requireRoles, requireOwnershipOrAdmin } from '../../middleware/auth';
import { prisma } from '../../config/prisma';
import { generateFollowUpAnswer } from '../../services/llm/llmService';
import { postVisitQueue } from '../../workers/postVisitWorker';

const router = Router();

// All chat routes require authentication
router.use(authenticate);

// ─────────────────────────────────────────────────────────────────────────────
// Helper: load booking with post-visit summary and ownership check
// ─────────────────────────────────────────────────────────────────────────────

const chatBookingLoader = async (req: Request) => {
  return prisma.booking.findUnique({
    where: { id: req.params.bookingId },
    select: {
      patientId: true,
      doctorId: true,
      postVisitSummary: { select: { id: true, summaryText: true } },
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /chat/:bookingId/message — patient asks a follow-up question
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  '/:bookingId/message',
  requireRoles('PATIENT'),
  requireOwnershipOrAdmin(chatBookingLoader),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { bookingId } = req.params;
      const { question } = req.body;

      if (!question || typeof question !== 'string' || !question.trim()) {
        res.status(400).json({ error: 'QUESTION_REQUIRED' });
        return;
      }

      // Check cap + post-visit summary exists
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: {
          followUpMessageCount: true,
          postVisitSummary: { select: { summaryText: true } },
        },
      });

      if (!booking) {
        res.status(404).json({ error: 'BOOKING_NOT_FOUND' });
        return;
      }

      if (booking.followUpMessageCount >= 5) {
        res.status(429).json({
          error: 'FOLLOW_UP_LIMIT_REACHED',
          message: 'You have reached the maximum number of follow-up questions for this visit.',
        });
        return;
      }

      // Verify post-visit summary exists and is GENERATED (not pending/fallback)
      if (!booking.postVisitSummary?.summaryText) {
        res.status(404).json({
          error: 'SUMMARY_NOT_READY',
          message: 'Post-visit summary is not yet available. Please wait for generation to complete.',
        });
        return;
      }

      // Load recent chat history (last 6 messages = 3 turns)
      const history = await prisma.chatMessage.findMany({
        where: { bookingId },
        orderBy: { createdAt: 'desc' },
        take: 6,
      });

      const formattedHistory = history
        .reverse()
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

      const result = await generateFollowUpAnswer({
        bookingId,
        question: question.trim(),
        contextSummary: booking.postVisitSummary.summaryText,
        history: formattedHistory,
      });

      res.status(200).json({
        answer: result.answer,
        status: result.status,
        remainingQuestions: Math.max(0, 5 - booking.followUpMessageCount - 1),
      });
    } catch (err) {
      console.error('Follow-up message error:', err);
      res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /chat/:bookingId/messages — get chat history (patient or doctor)
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  '/:bookingId/messages',
  requireRoles('PATIENT', 'DOCTOR'),
  requireOwnershipOrAdmin(chatBookingLoader),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { bookingId } = req.params;

      const messages = await prisma.chatMessage.findMany({
        where: { bookingId },
        orderBy: { createdAt: 'asc' },
        select: { role: true, content: true, createdAt: true },
      });

      res.status(200).json({ messages });
    } catch (err) {
      console.error('Get chat messages error:', err);
      res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /chat/:bookingId/regenerate — doctor regenerates post-visit summary
// Clears chat history for this booking (stale Q&A would be misleading)
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  '/:bookingId/regenerate',
  requireRoles('DOCTOR'),
  requireOwnershipOrAdmin(chatBookingLoader),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { bookingId } = req.params;

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

      if (booking.doctor.user.id !== req.user.id) {
        res.status(403).json({ error: 'NOT_OWNER' });
        return;
      }

      if (!booking.postVisitSummary?.doctorNotes) {
        res.status(400).json({ error: 'NO_DOCTOR_NOTES', message: 'No clinical notes to regenerate from' });
        return;
      }

      // Clear chat messages for this booking (regenerate makes old Q&A stale)
      await prisma.chatMessage.deleteMany({ where: { bookingId } });

      // Reset counter and summary status
      await prisma.booking.update({
        where: { id: bookingId },
        data: { followUpMessageCount: 0 },
      });

      await prisma.postVisitSummary.update({
        where: { bookingId },
        data: {
          llmStatus: 'PENDING',
          summaryText: '',
          retryCount: 0,
          generatedAt: null,
        },
      });

      // Re-queue the post-visit LLM job
      postVisitQueue.add('generate', { bookingId }).catch((err) => {
        console.error('[Chat] Failed to queue post-visit regenerate:', err);
      });

      res.status(200).json({
        message: 'Post-visit summary regeneration queued. Chat history cleared.',
        llmStatus: 'PENDING',
      });
    } catch (err) {
      console.error('Regenerate error:', err);
      res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  }
);

export default router;