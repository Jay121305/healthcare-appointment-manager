// app/(patient)/appointments/[id]/page.tsx — single appointment detail.
// Shows status, cancel/reschedule, post-visit summary (GET /visits/:bookingId/summary).

'use client';

import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDate, formatTime, formatDateTime, statusBadgeClass, cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/authContext';
import { useToast } from '@/components/ui/Toast';
import { Card, CardHeader, CardBody, SpinnerScreen } from '@/components/ui/Misc';
import { Badge, ErrorBanner, WarningBanner } from '@/components/ui/Misc';
import Link from 'next/link';
import type { BookingResponse, PostVisitSummaryResponse } from '@/lib/types';

export default function AppointmentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, loading: authLoading } = useAuth();
  const { addToast } = useToast();

  const bookingId = params.id as string;

  const { data: booking, isLoading: bookingLoading, isError: bookingError } = useQuery<BookingResponse, ApiError>({
    queryKey: ['booking', bookingId],
    queryFn: () => api.getBooking(bookingId),
    enabled: !!user && !authLoading,
  });

  const { data: summary } = useQuery<PostVisitSummaryResponse | null, ApiError>({
    queryKey: ['post-visit-summary', bookingId],
    queryFn: () => api.getPostVisitSummary(bookingId),
    enabled: !!user && !authLoading && !!booking && (booking.status === 'COMPLETED' || booking.status === 'NO_SHOW'),
    retry: false,
  });

  const cancelMut = useMutation({
    mutationFn: (reason: string) => api.cancelBooking(bookingId, reason),
    onSuccess: () => {
      addToast({ type: 'success', title: 'Appointment cancelled' });
      queryClient.invalidateQueries({ queryKey: ['patient-bookings'] });
      router.refresh();
    },
    onError: (err: ApiError) => {
      if (err.code === 'TOO_LATE_TO_CANCEL') addToast({ type: 'error', title: 'Too late to cancel', message: err.raw?.message });
      else addToast({ type: 'error', title: 'Cancel failed', message: err.raw?.message });
    },
  });

  if (authLoading) return <SpinnerScreen label="Loading your account…" />;
  if (!user) return null;
  if (bookingLoading) return <SpinnerScreen label="Loading appointment…" />;
  if (bookingError || !booking) return <ErrorBanner title="Not found" message="Appointment not found." />;

  const canCancel = booking.status === 'CONFIRMED' || booking.status === 'RESCHEDULED';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Appointment Details</h1>
          <p className="text-sm text-gray-500">Dr. {booking.doctor?.fullName ?? booking.doctorId}</p>
        </div>
        <Badge className={statusBadgeClass(booking.status)}>{booking.status}</Badge>
      </div>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">Date & Time</h2>
        </CardHeader>
        <CardBody>
          <dl className="grid gap-2 sm:grid-cols-2 text-sm">
            <div><dt className="text-gray-500">Date</dt><dd className="font-medium">{formatDate(booking.bookingDate)}</dd></div>
            <div><dt className="text-gray-500">Time</dt><dd className="font-medium">{formatTime(booking.startTime)}</dd></div>
            <div><dt className="text-gray-500">Booked</dt><dd className="font-medium">{formatDateTime(booking.bookedAt)}</dd></div>
            <div><dt className="text-gray-500">Status</dt><dd className="font-medium"><Badge className={statusBadgeClass(booking.status)}>{booking.status}</Badge></dd></div>
          </dl>
        </CardBody>
      </Card>

      {booking.symptomForm && (
        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold text-gray-900">Symptom Form</h2>
          </CardHeader>
          <CardBody className="space-y-2 text-sm">
            <p><span className="font-medium text-gray-700">Complaint:</span> {booking.symptomForm.primaryComplaint}</p>
            {booking.symptomForm.severity && <p><span className="font-medium text-gray-700">Severity:</span> {booking.symptomForm.severity}</p>}
            {booking.symptomForm.durationDays && <p><span className="font-medium text-gray-700">Duration:</span> {booking.symptomForm.durationDays} days</p>}
            {booking.symptomForm.description && <p><span className="font-medium text-gray-700">Description:</span> {booking.symptomForm.description}</p>}
            {booking.symptomForm.currentMedications?.length && <p><span className="font-medium text-gray-700">Medications:</span> {booking.symptomForm.currentMedications.join(', ')}</p>}
            {booking.symptomForm.allergies?.length && <p><span className="font-medium text-gray-700">Allergies:</span> {booking.symptomForm.allergies.join(', ')}</p>}
          </CardBody>
        </Card>
      )}

      {/* Actions */}
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-gray-900">Actions</h2>
        </CardHeader>
        <CardBody className="flex flex-wrap gap-2">
          {canCancel && (
            <button
              onClick={() => {
                const reason = prompt('Reason for cancellation (optional):');
                if (reason !== null) cancelMut.mutate(reason ?? 'No reason provided');
              }}
              disabled={cancelMut.isPending}
              className="px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
            >
              {cancelMut.isPending ? 'Cancelling…' : 'Cancel Appointment'}
            </button>
          )}
          {(booking.status === 'CONFIRMED' || booking.status === 'RESCHEDULED') && (
            <Link href={`/patient/appointments/${booking.id}/reschedule`}>
              <button className="px-3 py-1.5 text-sm border border-gray-300 text-gray-700 rounded hover:bg-gray-50">
                Reschedule
              </button>
            </Link>
          )}
          {(booking.status === 'COMPLETED' || booking.status === 'NO_SHOW') && (
            <Link href={`/patient/appointments/${booking.id}/summary`}>
              <button className="px-3 py-1.5 text-sm bg-primary-600 text-white rounded hover:bg-primary-700">
                View Post-Visit Summary
              </button>
            </Link>
          )}
        </CardBody>
      </Card>

      {/* Post-visit summary inline if available */}
      {summary && (
        <Card className={cn(summary.llmStatus === 'FALLBACK' && 'border-amber-200 bg-amber-50')}>
          <CardHeader>
            <h2 className="text-sm font-semibold text-gray-900">Post-Visit Summary</h2>
          </CardHeader>
          <CardBody className="space-y-2">
            <p className="text-sm text-gray-700 whitespace-pre-wrap">{summary.summaryText}</p>
            <div className="flex items-center gap-2">
              <Badge className="bg-amber-100 text-amber-900">LLM Status: {summary.llmStatus}</Badge>
              {summary.llmStatus === 'FALLBACK' && (
                <WarningBanner title="AI summary unavailable" message="This is a standard fallback summary. Your doctor's notes are available in the full view." />
              )}
            </div>
            <Link href={`/patient/appointments/${booking.id}/summary`}>
              <button className="text-sm text-primary-700 hover:underline">View full summary →</button>
            </Link>
          </CardBody>
        </Card>
      )}
    </div>
  );
}