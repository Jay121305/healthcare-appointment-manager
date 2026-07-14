// app/(patient)/dashboard/page.tsx — upcoming + past appointments.
// GET /bookings (paginated, filtered) — per task spec M3 endpoint list.
// The backend at the time of writing does not expose this endpoint;
// the page will show an "Endpoint pending" notice until the backend adds it.

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { formatDate, formatTime, statusBadgeClass } from '@/lib/utils';
import { Card, CardHeader, CardBody, EmptyState, SpinnerScreen } from '@/components/ui/Misc';
import { Badge } from '@/components/ui/Misc';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/authContext';
import type { BookingsListResponse } from '@/lib/types';

const ITEMS_PER_PAGE = 10;

export default function PatientDashboard() {
  const { user, loading: authLoading } = useAuth();
  const [activeTab, setActiveTab] = useState<'upcoming' | 'past'>('upcoming');
  const [page, setPage] = useState(1);

  const { data, isError } = useQuery<BookingsListResponse, ApiError>({
    queryKey: ['patient-bookings', user?.id, activeTab, page],
    queryFn: async () => {
      const params: Record<string, string> = {
        page: String(page),
        limit: String(ITEMS_PER_PAGE),
        status: activeTab === 'upcoming' ? 'CONFIRMED,RESCHEDULED' : 'COMPLETED,CANCELLED,NO_SHOW',
        direction: activeTab === 'upcoming' ? 'asc' : 'desc',
      };
      // Use the endpoint per M3 task spec (GET /bookings)
      return api.listBookings(params);
    },
    enabled: !!user && !authLoading,
  });

  if (authLoading) return <SpinnerScreen label="Loading your account…" />;
  if (!user) return null;

  if (isError) {
    // The backend doesn't have this endpoint yet — show a friendly notice
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-gray-900">My Appointments</h1>
          <Link href="/patient/doctors">
            <button className="text-sm text-primary-700 hover:underline">Book new appointment</button>
          </Link>
        </div>
        <div className="border border-dashed border-gray-300 rounded-lg p-8 text-center">
          <p className="text-sm font-medium text-gray-700">Appointments list unavailable</p>
          <p className="mt-1 text-xs text-gray-500">
            The backend endpoint <code className="bg-gray-100 px-1 rounded">GET /bookings</code> is not yet implemented.
            See assumption A2(M7) in the project docs.
          </p>
        </div>
      </div>
    );
  }

  const bookings = data?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-900">My Appointments</h1>
        <Link href="/patient/doctors">
          <button className="text-sm bg-primary-600 text-white px-3 py-1.5 rounded hover:bg-primary-700">
            Book new appointment
          </button>
        </Link>
      </div>

      <div className="border-b">
        <nav className="flex gap-4" aria-label="Appointment tabs">
          <button
            onClick={() => { setActiveTab('upcoming'); setPage(1); }}
            className={`pb-2 text-sm font-medium border-b-2 ${activeTab === 'upcoming' ? 'border-primary-600 text-primary-600' : 'border-transparent text-gray-500'}`}
          >
            Upcoming
          </button>
          <button
            onClick={() => { setActiveTab('past'); setPage(1); }}
            className={`pb-2 text-sm font-medium border-b-2 ${activeTab === 'past' ? 'border-primary-600 text-primary-600' : 'border-transparent text-gray-500'}`}
          >
            Past
          </button>
        </nav>
      </div>

      {bookings.length === 0 ? (
        <EmptyState
          title={activeTab === 'upcoming' ? 'No upcoming appointments' : 'No past appointments'}
          description={activeTab === 'upcoming' ? 'Book an appointment with a doctor to get started.' : 'Completed and cancelled appointments will appear here.'}
          action={
            <Link href="/patient/doctors">
              <button className="text-sm bg-primary-600 text-white px-3 py-1.5 rounded hover:bg-primary-700">
                Find a doctor
              </button>
            </Link>
          }
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {bookings.map((booking) => (
              <Card key={booking.id} className="flex flex-col">
                <CardHeader className="flex items-start justify-between">
                  <div>
                    <p className="font-medium text-gray-900">
                      {booking.doctor?.fullName ?? `Dr. ${booking.doctorId.slice(0, 8)}`}
                    </p>
                    <p className="text-xs text-gray-500">{booking.doctor?.specialisation ?? 'General'}</p>
                  </div>
                  <Badge className={statusBadgeClass(booking.status)}>{booking.status}</Badge>
                </CardHeader>
                <CardBody className="flex-1 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center gap-2 text-sm text-gray-700">
                      <span>{formatDate(booking.bookingDate)}</span>
                      <span>•</span>
                      <span>{formatTime(booking.startTime)}</span>
                    </div>
                    {booking.symptomForm?.primaryComplaint && (
                      <p className="mt-2 text-xs text-gray-500 line-clamp-2">
                        {booking.symptomForm.primaryComplaint}
                      </p>
                    )}
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Link
                      href={`/patient/appointments/${booking.id}`}
                      className="flex-1 text-center text-xs bg-primary-600 text-white py-1.5 rounded hover:bg-primary-700"
                    >
                      View details
                    </Link>
                    {booking.status === 'CONFIRMED' && (
                      <Link
                        href={`/patient/appointments/${booking.id}/reschedule`}
                        className="flex-1 text-center text-xs border border-gray-300 text-gray-700 py-1.5 rounded hover:bg-gray-50"
                      >
                        Reschedule
                      </Link>
                    )}
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>

          {(data?.total ?? 0) > ITEMS_PER_PAGE && (
            <div className="flex items-center justify-between text-sm text-gray-500">
              <span>
                Page {page} of {Math.ceil((data?.total ?? 0) / ITEMS_PER_PAGE)}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-2 py-1 border border-gray-300 rounded disabled:opacity-50"
                >
                  Prev
                </button>
                <button
                  onClick={() => setPage((p) => p + 1)}
                  disabled={page >= Math.ceil((data?.total ?? 0) / ITEMS_PER_PAGE)}
                  className="px-2 py-1 border border-gray-300 rounded disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}