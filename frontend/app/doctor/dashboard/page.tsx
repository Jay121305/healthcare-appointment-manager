// app/(doctor)/dashboard/page.tsx -- Today appointments with pre-visit summary + urgency badge.
// GET /bookings/today (per M3 task spec) -- backend does not have it yet per G3 gap.
// We will call it and show a notice if missing.

'use client';

import { useQuery } from '@tanstack/react-query';
import { formatTime, formatDate, cn, urgencyBadgeClass, statusBadgeClass } from '@/lib/utils';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/authContext';
import { Card, CardHeader, CardBody, EmptyState, SpinnerScreen } from '@/components/ui/Misc';
import { Badge, WarningBanner } from '@/components/ui/Misc';
import type { BookingsListResponse } from '@/lib/types';

export default function DoctorDashboard() {
  const { user, loading: authLoading } = useAuth();

  const { data: todayResponse, isLoading, isError } = useQuery<BookingsListResponse, ApiError>({
    queryKey: ['bookings', 'today', user?.id],
    queryFn: () => api.doctorTodayAppointments(),
    enabled: !!user && !authLoading,
    staleTime: 30_000,
  });
  const todayBookings = todayResponse?.items;

  if (authLoading) return <SpinnerScreen label="Loading your account…" />;
  if (!user) return null;

  if (isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold text-gray-900">Today&apos;s Appointments</h1>
        <div className="border border-dashed border-gray-300 rounded-lg p-8 text-center">
          <p className="text-sm font-medium text-gray-700">Today&apos;s appointments unavailable</p>
          <p className="mt-1 text-xs text-gray-500">
            The backend endpoint <code className="bg-gray-100 px-1 rounded">GET /bookings/today</code> is not yet implemented.
            See assumption A2(M7) / G3 in project docs.
          </p>
        </div>
      </div>
    );
  }

  const bookings = todayBookings ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-900">Today&apos;s Appointments</h1>
        {isLoading && <span className="text-sm text-gray-500">Refreshing…</span>}
      </div>

      {bookings.length === 0 ? (
        <EmptyState title="No appointments today" description="Enjoy your day!" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {bookings.map((booking) => (
            <Card key={booking.id} className="flex flex-col">
              <CardHeader className="flex flex-row items-start justify-between">
                <div>
                  <p className="font-medium text-gray-900">{booking.patient?.fullName ?? booking.patientId}</p>
                  <p className="text-xs text-gray-500">{booking.symptomForm?.primaryComplaint ?? 'No symptom form'}</p>
                </div>
                <Badge className={statusBadgeClass(booking.status)}>{booking.status}</Badge>
              </CardHeader>
              <CardBody className="flex-1 flex flex-col justify-between space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-700">{formatTime(booking.startTime)}</span>
                  <span className="text-gray-500">{formatDate(booking.bookingDate)}</span>
                </div>

                {/* Pre-visit summary + urgency */}
                {booking.preVisitSummary ? (
                  <div className={cn('space-y-2', booking.preVisitSummary.llmStatus === 'FALLBACK' && 'border-amber-200 bg-amber-50 rounded-md p-2')}>
                    {booking.preVisitSummary.llmStatus === 'FALLBACK' && (
                      <WarningBanner
                        title="AI summary unavailable"
                        message="Showing standard fallback summary below."
                      />
                    )}
                    <div className="flex items-center gap-2">
                      <Badge className={urgencyBadgeClass(booking.preVisitSummary.urgencyLevel)}>
                        {booking.preVisitSummary.urgencyLevel ?? 'Unknown'}
                      </Badge>
                      {booking.preVisitSummary.llmStatus === 'PENDING' && (
                        <Badge className="bg-amber-100 text-amber-800">Generating…</Badge>
                      )}
                    </div>
                    {booking.preVisitSummary.chiefComplaint && (
                      <p className="text-xs text-gray-700"><span className="font-medium">Complaint:</span> {booking.preVisitSummary.chiefComplaint}</p>
                    )}
                    {booking.preVisitSummary.suggestedQuestions?.length && (
                      <ul className="text-xs text-gray-600 list-disc list-inside space-y-0.5">
                        {booking.preVisitSummary.suggestedQuestions.map((q, i) => (
                          <li key={i}>{q}</li>
                        ))}
                      </ul>
                    )}
                    <p className="text-xs text-gray-500">LLM status: {booking.preVisitSummary.llmStatus} (retry {booking.preVisitSummary.retryCount})</p>
                  </div>
                ) : (
                  <div className="text-xs text-gray-400">Pre-visit summary pending…</div>
                )}

                <div className="pt-2 border-t flex gap-2">
                  <a
                    href={`/doctor/appointments/${booking.id}`}
                    className="flex-1 text-center text-xs bg-primary-600 text-white py-1.5 rounded hover:bg-primary-700"
                  >
                    Open
                  </a>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
