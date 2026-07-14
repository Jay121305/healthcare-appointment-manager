// app/(doctor)/appointments/page.tsx — all appointments (upcoming + past).
// GET /bookings with filters (per M3) — backend doesn't have it yet (G1 gap).

'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatDate, formatTime, statusBadgeClass } from '@/lib/utils';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/authContext';
import { Card, CardHeader, CardBody, EmptyState, SpinnerScreen } from '@/components/ui/Misc';
import { Badge } from '@/components/ui/Misc';
import type { BookingResponse } from '@/lib/types';

export default function DoctorAppointmentsPage() {
  const { user, loading: authLoading } = useAuth();
  const [filter, setFilter] = useState<'upcoming' | 'past'>('upcoming');
  const [page, setPage] = useState(1);

  const { data, isError } = useQuery<{ items: BookingResponse[]; total: number; page: number; limit: number }, ApiError>({
    queryKey: ['doctor-appointments', user?.id, filter, page],
    queryFn: async () => {
      const params = {
        status: filter === 'upcoming' ? 'CONFIRMED,RESCHEDULED' : 'COMPLETED,CANCELLED,NO_SHOW',
        direction: filter === 'upcoming' ? 'asc' : 'desc',
        page,
        limit: 10,
      };
      // This is the G1 endpoint — not in backend yet
      return api.listBookings(params);
    },
    enabled: !!user && !authLoading,
  });

  if (authLoading) return <SpinnerScreen />;
  if (!user) return null;

  if (isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold text-gray-900">All Appointments</h1>
        <div className="border border-dashed border-gray-300 rounded-lg p-8 text-center">
          <p className="text-sm font-medium text-gray-700">Appointments list unavailable</p>
          <p className="mt-1 text-xs text-gray-500">
            The backend endpoint <code className="bg-gray-100 px-1 rounded">GET /bookings</code> is not yet implemented (G1 gap).
          </p>
        </div>
      </div>
    );
  }

  const bookings = data?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-900">All Appointments</h1>
        <div className="border-b">
          <nav className="flex gap-4" aria-label="Filter tabs">
            <button
              onClick={() => { setFilter('upcoming'); setPage(1); }}
              className={`pb-2 text-sm font-medium border-b-2 ${filter === 'upcoming' ? 'border-primary-600 text-primary-600' : 'border-transparent text-gray-500'}`}
            >
              Upcoming
            </button>
            <button
              onClick={() => { setFilter('past'); setPage(1); }}
              className={`pb-2 text-sm font-medium border-b-2 ${filter === 'past' ? 'border-primary-600 text-primary-600' : 'border-transparent text-gray-500'}`}
            >
              Past
            </button>
          </nav>
        </div>
      </div>

      {bookings.length === 0 ? (
        <EmptyState title={filter === 'upcoming' ? 'No upcoming appointments' : 'No past appointments'} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {bookings.map((booking) => (
              <Card key={booking.id} className="flex flex-col">
                <CardHeader className="flex items-start justify-between">
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
                  <a
                    href={`/doctor/appointments/${booking.id}`}
                    className="text-center text-xs bg-primary-600 text-white py-1.5 rounded hover:bg-primary-700"
                  >
                    View
                  </a>
                </CardBody>
              </Card>
            ))}
          </div>

          {(data?.total ?? 0) > 10 && (
            <div className="flex items-center justify-between text-sm text-gray-500">
              <span>Page {page} of {Math.ceil((data?.total ?? 0) / 10)}</span>
              <div className="flex gap-2">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-2 py-1 border border-gray-300 rounded disabled:opacity-50">Prev</button>
                <button onClick={() => setPage((p) => p + 1)} disabled={page >= Math.ceil((data?.total ?? 0) / 10)} className="px-2 py-1 border border-gray-300 rounded disabled:opacity-50">Next</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}