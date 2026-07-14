// backend/src/routes/admin/doctors.ts
// Admin doctor-management routes — every route gated by authenticate + requireRoles('ADMIN')

import { Router, Request, Response } from 'express';
import { authenticate, requireRoles } from '../../middleware/auth';
import {
  listDoctors,
  getDoctorById,
  createDoctor,
  updateDoctor,
  softDeleteDoctor,
  DoctorListParams,
} from '../../services/doctorService';
import { getAvailableSlots, getLeaveDays } from '../../services/slotService';
import { markLeave, deleteLeaveDay } from '../../services/leaveService';

const router = Router();

// Every route on this router requires authentication + ADMIN role.
// Applied at the router level so no individual route can accidentally bypass it.
router.use(authenticate, requireRoles('ADMIN'));

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/doctors — create doctor profile
// ─────────────────────────────────────────────────────────────────────────────

router.post('/doctors', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, fullName, specialisation, workingHours, slotDurationMinutes, phone } = req.body;

    if (!email || !password || !fullName || !specialisation || !workingHours) {
      res.status(400).json({ error: 'REQUIRED_FIELDS_MISSING' });
      return;
    }

    const doctor = await createDoctor({
      email,
      password,
      fullName,
      specialisation,
      workingHours,
      slotDurationMinutes,
      phone,
    });

    res.status(201).json(doctor);
  } catch (err) {
    const error = err as Error;
    if (error.message === 'USER_EXISTS') {
      res.status(409).json({ error: 'USER_EXISTS' });
      return;
    }
    console.error('Create doctor error:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/doctors — list all doctors (paginated, filtered)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/doctors', async (req: Request, res: Response): Promise<void> => {
  try {
    const page = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const specialisation = req.query.specialisation as string | undefined;
    const q = req.query.q as string | undefined;

    const params: DoctorListParams = {};
    if (page !== undefined) params.page = page;
    if (limit !== undefined) params.limit = limit;
    if (specialisation !== undefined) params.specialisation = specialisation;
    if (q !== undefined) params.q = q;

    const result = await listDoctors(params);

    res.status(200).json(result);
  } catch (err) {
    console.error('List doctors error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/doctors/:id — get one doctor
// ─────────────────────────────────────────────────────────────────────────────

router.get('/doctors/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const doctor = await getDoctorById(req.params.id);

    if (!doctor) {
      res.status(404).json({ error: 'DOCTOR_NOT_FOUND' });
      return;
    }

    res.status(200).json(doctor);
  } catch (err) {
    console.error('Get doctor error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /admin/doctors/:id — update doctor profile
// ─────────────────────────────────────────────────────────────────────────────

router.put('/doctors/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { fullName, specialisation, workingHours, slotDurationMinutes, phone, isActive } = req.body;

    const doctor = await updateDoctor(req.params.id, {
      fullName,
      specialisation,
      workingHours,
      slotDurationMinutes,
      phone,
      isActive,
    });

    res.status(200).json(doctor);
  } catch (err) {
    const error = err as Error;
    if (error.message === 'DOCTOR_NOT_FOUND') {
      res.status(404).json({ error: 'DOCTOR_NOT_FOUND' });
      return;
    }
    console.error('Update doctor error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /admin/doctors/:id — soft delete (A3: reject with 409 if upcoming bookings)
// ─────────────────────────────────────────────────────────────────────────────

router.delete('/doctors/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await softDeleteDoctor(req.params.id);

    if (result.hasUpcomingBookings) {
      res.status(409).json({
        error: 'UPCOMING_BOOKINGS_EXIST',
        bookingIds: result.bookingIds,
      });
      return;
    }

    res.status(204).send();
  } catch (err) {
    const error = err as Error;
    if (error.message === 'DOCTOR_NOT_FOUND') {
      res.status(404).json({ error: 'DOCTOR_NOT_FOUND' });
      return;
    }
    console.error('Soft delete doctor error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/doctors/:id/slots — list available slots for a date
// ─────────────────────────────────────────────────────────────────────────────

router.get('/doctors/:id/slots', async (req: Request, res: Response): Promise<void> => {
  try {
    const date = req.query.date as string | undefined;

    if (!date) {
      res.status(400).json({ error: 'DATE_QUERY_PARAM_REQUIRED' });
      return;
    }

    // Validate YYYY-MM-DD format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      res.status(400).json({ error: 'INVALID_DATE_FORMAT' });
      return;
    }

    const result = await getAvailableSlots(req.params.id, date);

    res.status(200).json(result);
  } catch (err) {
    console.error('Get slots error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/doctors/:id/leave — mark leave
// ─────────────────────────────────────────────────────────────────────────────

router.post('/doctors/:id/leave', async (req: Request, res: Response): Promise<void> => {
  try {
    const { rangeStart, rangeEnd, reason, dryRun, conflictResolution } = req.body;

    if (!rangeStart || !rangeEnd) {
      res.status(400).json({ error: 'RANGE_START_AND_END_REQUIRED' });
      return;
    }

    const result = await markLeave(req.params.id, {
      rangeStart,
      rangeEnd,
      reason,
      dryRun,
      conflictResolution,
    });

    // If conflicts were detected in PREVIEW mode, return 200 with the conflict list
    // (the admin UI uses this to show the conflicts and ask for AUTO_CANCEL choice)
    res.status(200).json(result);
  } catch (err) {
    const error = err as Error;
    if (error.message === 'DOCTOR_NOT_FOUND') {
      res.status(404).json({ error: 'DOCTOR_NOT_FOUND' });
      return;
    }
    // Thrown from inside the tx when conflicts exist but no AUTO_CANCEL resolution was chosen
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'CONFLICT_REQUIRES_RESOLUTION') {
      res.status(409).json({
        error: 'CONFLICT_REQUIRES_RESOLUTION',
        message: 'Existing bookings conflict with the requested leave. Set conflictResolution to AUTO_CANCEL to cancel them automatically.',
      });
      return;
    }
    console.error('Mark leave error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/doctors/:id/leave — list leave days for a doctor
// ─────────────────────────────────────────────────────────────────────────────

router.get('/doctors/:id/leave', async (req: Request, res: Response): Promise<void> => {
  try {
    const rangeStart = req.query.rangeStart as string | undefined;
    const rangeEnd = req.query.rangeEnd as string | undefined;

    const leaveDays = await getLeaveDays(req.params.id, rangeStart, rangeEnd);

    res.status(200).json({ leaveDays });
  } catch (err) {
    console.error('Get leave days error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /admin/doctors/:id/leave/:leaveId — remove a specific leave day
// Note: The route param is named :leaveId per the fix instructions. For backwards
// compatibility with the existing deleteLeaveDay service (which accepts a
// leaveDate ISO string, not a LeaveDay.id), we pass the param through as the
// leaveDateISO argument. The service uses a date-range delete so this works
// whether :leaveId is a UUID or an ISO date string.
// ─────────────────────────────────────────────────────────────────────────────

router.delete('/doctors/:id/leave/:leaveId', async (req: Request, res: Response): Promise<void> => {
  try {
    await deleteLeaveDay(req.params.id, req.params.leaveId);

    res.status(204).send();
  } catch (err) {
    const error = err as Error;
    if (error.message === 'LEAVE_DAY_NOT_FOUND') {
      res.status(404).json({ error: 'LEAVE_DAY_NOT_FOUND' });
      return;
    }
    console.error('Delete leave day error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export default router;
