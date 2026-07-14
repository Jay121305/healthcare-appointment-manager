// app/(patient)/appointments/[id]/reschedule/page.tsx — reschedule flow.
// Mirrors the booking flow but for an existing booking. Uses POST /bookings/:bookingId/reschedule.

'use client';

import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatTime, formatDate, formatCountdown, cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/authContext';
import { useToast } from '@/components/ui/Toast';
import { Card, CardHeader, CardBody, SpinnerScreen, EmptyState, Badge } from '@/components/ui/Misc';
import { Button } from '@/components/ui/Button';
import { useCountdown } from '@/lib/hooks';
import type { SlotInfo, PlaceHoldResult, RescheduleBookingResult } from '@/lib/types';

export default function ReschedulePage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, loading: authLoading } = useAuth();
  const { addToast } = useToast();

  const bookingId = params.id as string;
  const [step, setStep] = useState<'date' | 'slots' | 'confirm'>('date');
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [hold, setHold] = useState<PlaceHoldResult | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const { remaining, isExpired } = useCountdown(
    hold ? Math.ceil((new Date(hold.expiresAt).getTime() - Date.now()) / 1000) : 0,
    () => { addToast({ type: 'warning', title: 'Hold expired', message: 'Please pick a slot again.' }); resetToDate(); },
  );

  const { data: booking } = useQuery({
    queryKey: ['booking', bookingId],
    queryFn: () => api.getBooking(bookingId),
    enabled: !!user && !authLoading,
  });

  const { data: slotsData, refetch: refetchSlots } = useQuery({
    queryKey: ['slots', booking?.doctorId, selectedDate],
    queryFn: () => api.getSlots(booking!.doctorId, selectedDate),
    enabled: step === 'slots' && !!selectedDate,
  });

  const placeHoldMut = useMutation({
    mutationFn: (slot: SlotInfo) => api.placeHold({ doctorId: booking!.doctorId, date: selectedDate, startTime: slot.startUTC }),
    onSuccess: (result) => { setHold(result); setStep('confirm'); addToast({ type: 'success', title: 'Slot held', message: `You have ${result.ttlSeconds}s to confirm.` }); },
    onError: (err: ApiError) => {
      if (err.code === 'SLOT_UNAVAILABLE') { addToast({ type: 'error', title: 'Slot taken', message: err.raw?.message }); refetchSlots(); }
      else if (err.code === 'SLOT_HELD') { addToast({ type: 'warning', title: 'Slot held by another', message: err.raw?.message }); }
      else { addToast({ type: 'error', title: 'Could not hold slot', message: err.raw?.message }); }
    },
  });

  const rescheduleMut = useMutation({
    mutationFn: (newHoldToken: string) => api.rescheduleBooking(bookingId, { newHoldToken }),
    onSuccess: (result: RescheduleBookingResult) => {
      addToast({ type: 'success', title: 'Rescheduled', message: `New time: ${formatDate(result.newBooking.bookingDate)} ${formatTime(result.newBooking.startTime)}` });
      queryClient.invalidateQueries({ queryKey: ['patient-bookings'] });
      router.push(`/patient/appointments/${result.newBooking.id}`);
    },
    onError: (err: ApiError) => {
      if (err.code === 'NEW_HOLD_EXPIRED') { addToast({ type: 'warning', title: 'Hold expired', message: 'Please pick a slot again.' }); resetToDate(); }
      else if (err.code === 'NEW_SLOT_ON_LEAVE') { addToast({ type: 'error', title: 'Doctor on leave', message: err.raw?.message }); resetToDate(); }
      else { addToast({ type: 'error', title: 'Reschedule failed', message: err.raw?.message }); }
    },
  });

  const resetToDate = () => {
    setStep('date');
    setSelectedDate('');
    setHold(null);
    setConfirmError(null);
  };

  if (authLoading) return <SpinnerScreen />;
  if (!user || !booking) return null;

  const slots = slotsData?.slots ?? [];
  const availableSlots = slots.filter((s) => s.available);

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Reschedule Appointment</h1>
          <p className="text-sm text-gray-500">Current: {formatDate(booking.bookingDate)} at {formatTime(booking.startTime)}</p>
        </div>
        <Badge className="bg-amber-100 text-amber-800">Rescheduling</Badge>
      </div>

      {hold && (
        <div className={cn('fixed bottom-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-mono', isExpired ? 'bg-red-100 text-red-800' : 'bg-primary-600 text-white')}>
          Hold expires in: {formatCountdown(remaining)}
        </div>
      )}

      {/* Step 1: Date */}
      {step === 'date' && (
        <Card>
          <CardHeader><h2 className="text-lg font-semibold text-gray-900">Pick a new date</h2></CardHeader>
          <CardBody>
            <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
            <input
              type="date"
              min={formatDate(new Date())}
              max={formatDate(new Date(Date.now() + 90 * 86400000))}
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:ring-2 focus:ring-primary-200"
            />
            <div className="mt-4 flex justify-end">
              <Button onClick={() => setStep('slots')} disabled={!selectedDate}>Next</Button>
            </div>
          </CardBody>
        </Card>
      )}

      {/* Step 2: Slots */}
      {step === 'slots' && (
        <Card>
          <CardHeader><h2 className="text-lg font-semibold text-gray-900">Available times on {selectedDate}</h2></CardHeader>
          <CardBody>
            {slotsData === undefined ? (
              <SpinnerScreen label="Loading slots…" />
            ) : availableSlots.length === 0 ? (
              <EmptyState title="No slots available" description={slotsData?.reason ?? 'Try another date.'} />
            ) : (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {availableSlots.map((slot) => (
                  <button
                    key={slot.startUTC}
                    onClick={() => { placeHoldMut.mutate(slot); }}
                    disabled={placeHoldMut.isPending}
                    className="p-3 border border-gray-300 rounded-lg text-left hover:bg-gray-50 hover:border-primary-400"
                  >
                    <div className="font-medium text-gray-900">{formatTime(slot.startUTC)}</div>
                    <div className="text-xs text-gray-500">{formatTime(slot.endUTC)}</div>
                  </button>
                ))}
              </div>
            )}
            <div className="mt-4 flex justify-between">
              <Button variant="ghost" onClick={() => setStep('date')} disabled={placeHoldMut.isPending}>Back</Button>
            </div>
          </CardBody>
        </Card>
      )}

      {/* Step 3: Confirm */}
      {step === 'confirm' && hold && (
        <Card>
          <CardHeader><h2 className="text-lg font-semibold text-gray-900">Confirm New Time</h2></CardHeader>
          <CardBody className="space-y-4">
            {confirmError && (
              <div className="border border-red-200 bg-red-50 rounded-md p-3 text-sm text-red-800">
                {confirmError}
              </div>
            )}
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-gray-500">New date</dt><dd className="font-medium">{formatDate(selectedDate)}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">New time</dt><dd className="font-medium">{hold.startTime}</dd></div>
            </dl>
            <div className="pt-4 border-t flex justify-end gap-2">
              <Button variant="ghost" onClick={() => { setHold(null); setStep('slots'); }} disabled={rescheduleMut.isPending}>Back</Button>
              <Button onClick={() => rescheduleMut.mutate(hold.holdToken)} loading={rescheduleMut.isPending}>
                Confirm Reschedule
              </Button>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
