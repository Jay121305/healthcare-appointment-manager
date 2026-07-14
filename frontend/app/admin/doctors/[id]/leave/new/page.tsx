// app/(admin)/doctors/[id]/leave/new/page.tsx — mark leave with conflict resolution UI.
// POST /admin/doctors/:id/leave with dryRun=true (PREVIEW) → show conflicts → re-submit with AUTO_CANCEL.

'use client';

import { useParams } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatDate } from '@/lib/utils';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/authContext';
import { useToast } from '@/components/ui/Toast';
import { Card, CardHeader, CardBody, SpinnerScreen } from '@/components/ui/Misc';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { ErrorBanner, WarningBanner } from '@/components/ui/Misc';
import type { MarkLeaveInput, MarkLeaveResult, ConflictByDate, LeaveConflict } from '@/lib/types';

export default function AdminMarkLeavePage() {
  const params = useParams();
  const queryClient = useQueryClient();
  const { user, loading: authLoading } = useAuth();
  const { addToast } = useToast();

  const doctorId = params.id as string;
  const [form, setForm] = useState<MarkLeaveInput>({ rangeStart: '', rangeEnd: '', reason: '', dryRun: true, conflictResolution: 'PREVIEW', autoCancel: false });
  const [phase, setPhase] = useState<'preview' | 'conflicts' | 'done'>('preview');
  const [conflicts, setConflicts] = useState<ConflictByDate[]>([]);
  const [error, setError] = useState('');

  const markLeaveMut = useMutation({
    mutationFn: (input: MarkLeaveInput) => api.adminMarkLeave(doctorId, input),
    onSuccess: (result: MarkLeaveResult) => {
      if (result.status === 'CONFLICT_DETECTED') {
        setConflicts(result.conflictDates);
        setPhase('conflicts');
        addToast({ type: 'warning', title: 'Conflicts detected', message: `${result.affectedPatientCount} patient(s) have bookings on leave dates.` });
      } else {
        setPhase('done');
        addToast({ type: 'success', title: 'Leave marked', message: `${result.leaveRowsCreated} leave day(s) created.` });
        queryClient.invalidateQueries({ queryKey: ['admin-doctor-leave', doctorId] });
      }
    },
    onError: (err: ApiError) => {
      if (err.code === 'CONFLICT_REQUIRES_RESOLUTION') {
        addToast({ type: 'error', title: 'Resolution required', message: err.raw?.message });
      } else {
        addToast({ type: 'error', title: 'Leave failed', message: err.raw?.message });
      }
    },
  });

  if (authLoading) return <SpinnerScreen />;
  if (!user) return null;

  const handleSubmit = () => {
    setError('');
    if (!form.rangeStart || !form.rangeEnd) {
      setError('Start and end dates are required.');
      return;
    }
    markLeaveMut.mutate(form);
  };

  const handleAutoCancel = () => {
    setForm((f) => ({ ...f, dryRun: false, conflictResolution: 'AUTO_CANCEL', autoCancel: true }));
    markLeaveMut.mutate({ ...form, dryRun: false, conflictResolution: 'AUTO_CANCEL', autoCancel: true });
  };

  const handleKeepBookings = () => {
    setForm((f) => ({ ...f, dryRun: false, conflictResolution: 'PREVIEW', autoCancel: false }));
    markLeaveMut.mutate({ ...form, dryRun: false, conflictResolution: 'PREVIEW', autoCancel: false });
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">Mark Doctor Leave</h1>
        <p className="text-sm text-gray-500">Doctor ID: {doctorId}</p>
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-gray-900">Leave Details</h2>
        </CardHeader>
        <CardBody className="space-y-4">
          {error && <ErrorBanner title="Error" message={error} />}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Start date" htmlFor="start">
              <Input id="start" type="date" value={form.rangeStart} onChange={(e) => setForm((f) => ({ ...f, rangeStart: e.target.value }))} required />
            </Field>
            <Field label="End date" htmlFor="end">
              <Input id="end" type="date" value={form.rangeEnd} onChange={(e) => setForm((f) => ({ ...f, rangeEnd: e.target.value }))} required />
            </Field>
          </div>

          <Field label="Reason (optional)" htmlFor="reason">
            <Textarea id="reason" value={form.reason ?? ''} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} rows={2} />
          </Field>

          {phase === 'preview' && (
            <div className="pt-4 border-t flex justify-end">
              <Button onClick={handleSubmit} loading={markLeaveMut.isPending}>Preview Conflicts</Button>
            </div>
          )}

          {phase === 'conflicts' && (
            <div className="space-y-4 border-t pt-4">
              <WarningBanner
                title="Booking conflicts detected"
                message="The doctor has existing appointments on the requested leave dates. Choose how to resolve."
              />
              {conflicts.map((cd) => (
                <div key={cd.leaveDate} className="border border-amber-200 bg-amber-50 rounded-md p-3">
                  <p className="font-medium text-amber-900">{formatDate(cd.leaveDate)} — {cd.bookings.length} booking(s)</p>
                  <ul className="mt-2 text-sm text-gray-700 space-y-1">
                    {cd.bookings.map((b: LeaveConflict) => (
                      <li key={b.bookingId}>
                        {b.patientName} ({formatDate(b.bookingDate)} {b.startTime})
                      </li>
                    ))}
                  </ul>
                </div>
              ))}

              <div className="pt-4 border-t flex gap-2 justify-end">
                <Button variant="ghost" onClick={() => setPhase('preview')}>Back</Button>
                <Button variant="danger" onClick={handleKeepBookings} loading={markLeaveMut.isPending}>
                  Save leave, keep bookings
                </Button>
                <Button onClick={handleAutoCancel} loading={markLeaveMut.isPending}>
                  Auto-cancel conflicting bookings & mark leave
                </Button>
              </div>
            </div>
          )}

          {phase === 'done' && (
            <div className="pt-4 border-t text-center text-sm text-green-700">
              <p>Leave successfully recorded. <a href={`/admin/doctors/${doctorId}`} className="text-primary-700 hover:underline">Back to doctor</a></p>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}