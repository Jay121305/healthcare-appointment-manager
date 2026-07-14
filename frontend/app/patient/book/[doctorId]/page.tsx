// app/(patient)/book/[doctorId]/page.tsx — full booking flow on one page.
// Steps: 1) Pick date → 2) Pick slot & place hold (countdown) → 3) Symptom form → 4) Review & confirm.
// Backend endpoints: GET /bookings/slots, POST /bookings/holds, POST /:holdToken/symptom-form, POST /:holdToken/confirm

'use client';

import React from 'react';
import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatTime, formatDate, formatCountdown, cn, todayLocalDateInput, addDays, toLocalDateInput } from '@/lib/utils';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/authContext';
import { useToast } from '@/components/ui/Toast';
import { Card, CardHeader, CardBody, SpinnerScreen } from '@/components/ui/Misc';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { ErrorBanner } from '@/components/ui/Misc';
import { useCountdown } from '@/lib/hooks';
import type { SlotInfo, PlaceHoldResult, SymptomFormInput } from '@/lib/types';

type Step = 'date' | 'slots' | 'symptom' | 'confirm';

export default function BookPage() {
  const router = useRouter();
  const params = useParams();
  const { user, loading: authLoading } = useAuth();
  const { addToast } = useToast();
  const queryClient = useQueryClient();

  const doctorId = params.doctorId as string;
  const [step, setStep] = useState<Step>('date');
  const [selectedDate, setSelectedDate] = useState<string>(todayLocalDateInput());
  const [hold, setHold] = useState<PlaceHoldResult | null>(null);
  const [symptomForm, setSymptomForm] = useState<SymptomFormInput>({
    primaryComplaint: '',
    durationDays: null,
    severity: null,
    description: '',
    currentMedications: [],
    allergies: [],
  });
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // Countdown hook
  const { remaining, isExpired, start, stop } = useCountdown(
    hold ? Math.ceil((new Date(hold.expiresAt).getTime() - Date.now()) / 1000) : 0,
    () => {
      addToast({ type: 'warning', title: 'Hold expired', message: 'Your slot hold has expired. Please pick a slot again.' });
      resetToDateStep();
    },
  );

  // Start/stop countdown when hold changes
  useEffect(() => {
    if (hold) {
      const secs = Math.ceil((new Date(hold.expiresAt).getTime() - Date.now()) / 1000);
      start(Math.max(0, secs));
    } else {
      stop();
    }
    return () => stop();
  }, [hold, start, stop]);

  // Fetch slots when date changes
  const { data: slotsData, isLoading: slotsLoading, refetch: refetchSlots } = useQuery({
    queryKey: ['slots', doctorId, selectedDate],
    queryFn: () => api.getSlots(doctorId, selectedDate),
    enabled: step === 'slots' || step === 'date',
    staleTime: 30_000,
  });

  // Fetch doctor name for display
  const { data: doctor } = useQuery({
    queryKey: ['doctor', doctorId],
    queryFn: () => api.getDoctor(doctorId),
    staleTime: 60_000,
  });

  // Place hold mutation
  const placeHoldMut = useMutation({
    mutationFn: (slot: SlotInfo) => api.placeHold({ doctorId, date: selectedDate, startTime: slot.startUTC }),
    onSuccess: (result) => {
      setHold(result);
      setStep('symptom');
      addToast({ type: 'success', title: 'Slot held', message: `You have ${result.ttlSeconds}s to complete booking.` });
    },
    onError: (err: ApiError) => {
      if (err.code === 'SLOT_HELD') {
        addToast({ type: 'warning', title: 'Slot held by another', message: err.raw?.message });
      } else if (err.code === 'SLOT_UNAVAILABLE') {
        addToast({ type: 'error', title: 'Slot taken', message: err.raw?.message });
        refetchSlots();
      } else {
        addToast({ type: 'error', title: 'Could not hold slot', message: err.raw?.message });
      }
    },
  });

  // Attach symptom form mutation
  const attachSymptomMut = useMutation({
    mutationFn: (form: SymptomFormInput) => api.attachSymptomForm(hold!.holdToken, form),
    onSuccess: () => setStep('confirm'),
    onError: (err: ApiError) => {
      if (err.code === 'HOLD_EXPIRED') {
        addToast({ type: 'warning', title: 'Hold expired', message: 'Please pick a slot again.' });
        resetToDateStep();
      } else {
        addToast({ type: 'error', title: 'Could not save form', message: err.raw?.message });
      }
    },
  });

  // Confirm booking mutation
  const confirmMut = useMutation({
    mutationFn: () => api.confirmBooking(hold!.holdToken),
    onSuccess: (booking) => {
      addToast({ type: 'success', title: 'Appointment booked!', message: `See you on ${formatDate(booking.bookingDate)} at ${formatTime(booking.startTime)}` });
      queryClient.invalidateQueries({ queryKey: ['patient-bookings'] });
      router.push(`/patient/appointments/${booking.id}`);
    },
    onError: (err: ApiError) => {
      if (err.code === 'SLOT_ALREADY_BOOKED') {
        setConfirmError('This slot was just taken by another patient. Please pick a different slot.');
        resetToDateStep();
      } else if (err.code === 'HOLD_EXPIRED') {
        addToast({ type: 'warning', title: 'Hold expired', message: 'Please pick a slot again.' });
        resetToDateStep();
      } else if (err.code === 'SYMPTOM_FORM_REQUIRED') {
        setConfirmError('Please complete the symptom form first.');
        setStep('symptom');
      } else {
        addToast({ type: 'error', title: 'Booking failed', message: err.raw?.message });
      }
    },
  });

  const resetToDateStep = useCallback(() => {
    setStep('date');
    setHold(null);
    setSymptomForm({ primaryComplaint: '', durationDays: null, severity: null, description: '', currentMedications: [], allergies: [] });
    setConfirmError(null);
  }, []);

  if (authLoading) return <SpinnerScreen label="Loading your account…" />;
  if (!user) return null;

  const slots = slotsData?.slots ?? [];
  const availableSlots = slots.filter((s) => s.available);

  // Progress stepper UI
  const steps: { key: Step; label: string }[] = [
    { key: 'date', label: '1. Date' },
    { key: 'slots', label: '2. Time' },
    { key: 'symptom', label: '3. Symptoms' },
    { key: 'confirm', label: '4. Confirm' },
  ];

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Stepper */}
      <div className="hidden sm:flex items-center">
        {steps.map((s, i) => (
          <React.Fragment key={s.key}>
            <div className="flex items-center">
              <div
                className={cn(
                  'flex items-center justify-center w-8 h-8 rounded-full text-xs font-medium',
                  step === s.key ? 'bg-primary-600 text-white' :
                  steps.findIndex((x) => x.key === step) > i ? 'bg-primary-600 text-white' :
                  'bg-gray-200 text-gray-500',
                )}
              >
                {steps.findIndex((x) => x.key === step) > i ? '✓' : i + 1}
              </div>
              <span className={cn('ml-2 text-sm font-medium', step === s.key ? 'text-primary-600' : 'text-gray-500')}>
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && <div className="flex-1 h-0.5 bg-gray-200 mx-2" />}
          </React.Fragment>
        ))}
      </div>

      {/* Mobile step indicator */}
      <div className="sm:hidden text-sm text-gray-500 mb-4">
        Step {steps.findIndex((x) => x.key === step) + 1} of {steps.length}: {steps.find((x) => x.key === step)?.label}
      </div>

      {/* Countdown banner */}
      {hold && (
        <div className={cn('fixed bottom-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-mono', isExpired ? 'bg-red-100 text-red-800' : 'bg-primary-600 text-white')}>
          Hold expires in: {formatCountdown(remaining)}
        </div>
      )}

      {/* Step: Date picker */}
      {step === 'date' && (
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900">Select appointment date</h2>
            <p className="text-sm text-gray-500">Dr. {doctor?.fullName ?? doctorId}</p>
          </CardHeader>
          <CardBody>
            <Field label="Date" htmlFor="date">
              <Input
                id="date"
                type="date"
                min={todayLocalDateInput()}
                max={toLocalDateInput(addDays(new Date(), 90))}
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
              />
            </Field>
            <div className="mt-4 flex justify-end">
              <Button onClick={() => setStep('slots')} disabled={!selectedDate}>Next</Button>
            </div>
          </CardBody>
        </Card>
      )}

      {/* Step: Slot grid */}
      {step === 'slots' && (
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900">Available times on {selectedDate}</h2>
          </CardHeader>
          <CardBody>
            {slotsLoading ? (
              <SpinnerScreen label="Loading slots…" />
            ) : availableSlots.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <p className="font-medium">No available slots</p>
                <p className="text-sm mt-1">{slotsData?.reason ?? 'Try another date.'}</p>
              </div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {availableSlots.map((slot) => (
                  <button
                    key={slot.startUTC}
                    onClick={() => { placeHoldMut.mutate(slot); }}
                    disabled={placeHoldMut.isPending}
                    className={cn('p-3 border rounded-lg text-left hover:bg-gray-50 transition', 'border-gray-300 hover:border-primary-400')}
                  >
                    <div className="font-medium text-gray-900">{formatTime(slot.startUTC)}</div>
                    <div className="text-xs text-gray-500">{formatTime(slot.endUTC)}</div>
                  </button>
                ))}
              </div>
            )}
            <div className="mt-4 flex justify-between">
              <Button variant="ghost" onClick={() => setStep('date')} disabled={placeHoldMut.isPending}>Back</Button>
              <div />
            </div>
          </CardBody>
        </Card>
      )}

      {/* Step: Symptom form */}
      {step === 'symptom' && hold && (
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900">Symptom form (required)</h2>
            <p className="text-sm text-gray-500">This is the final step before confirmation (Rule 4).</p>
          </CardHeader>
          <CardBody>
            <form onSubmit={(e) => { e.preventDefault(); attachSymptomMut.mutate(symptomForm); }} className="space-y-4">
              {attachSymptomMut.isError && (
                <ErrorBanner title="Failed to save form" message={(attachSymptomMut.error as ApiError)?.raw?.message} />
              )}

              <Field label="Primary complaint" htmlFor="complaint" error={!symptomForm.primaryComplaint && attachSymptomMut.isPending ? 'Required' : undefined}>
                <Input
                  id="complaint"
                  value={symptomForm.primaryComplaint}
                  onChange={(e) => setSymptomForm((p) => ({ ...p, primaryComplaint: e.target.value }))}
                  placeholder="e.g., Persistent headache for 3 days"
                  required
                  disabled={attachSymptomMut.isPending}
                />
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Duration (days)" htmlFor="duration">
                  <Input
                    id="duration"
                    type="number"
                    min="0"
                    value={symptomForm.durationDays ?? ''}
                    onChange={(e) => setSymptomForm((p) => ({ ...p, durationDays: e.target.value ? parseInt(e.target.value) : null }))}
                    disabled={attachSymptomMut.isPending}
                  />
                </Field>
                <Field label="Severity" htmlFor="severity">
                  <select
                    id="severity"
                    value={symptomForm.severity ?? ''}
                    onChange={(e) => setSymptomForm((p) => ({ ...p, severity: e.target.value as SymptomFormInput['severity'] }))}
                    disabled={attachSymptomMut.isPending}
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:ring-2 focus:ring-primary-200"
                  >
                    <option value="">Select</option>
                    <option value="MILD">Mild</option>
                    <option value="MODERATE">Moderate</option>
                    <option value="SEVERE">Severe</option>
                  </select>
                </Field>
              </div>

              <Field label="Description (optional)" htmlFor="description">
                <Textarea
                  id="description"
                  value={symptomForm.description ?? ''}
                  onChange={(e) => setSymptomForm((p) => ({ ...p, description: e.target.value }))}
                  placeholder="Additional details..."
                  disabled={attachSymptomMut.isPending}
                />
              </Field>

              <Field label="Current medications (comma-separated)" htmlFor="meds">
                <Input
                  id="meds"
                  value={(symptomForm.currentMedications ?? []).join(', ')}
                  onChange={(e) => setSymptomForm((p) => ({ ...p, currentMedications: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) }))}
                  placeholder="e.g., Metformin 500mg, Lisinopril 10mg"
                  disabled={attachSymptomMut.isPending}
                />
              </Field>

              <Field label="Allergies (comma-separated)" htmlFor="allergies">
                <Input
                  id="allergies"
                  value={(symptomForm.allergies ?? []).join(', ')}
                  onChange={(e) => setSymptomForm((p) => ({ ...p, allergies: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) }))}
                  placeholder="e.g., Penicillin, Sulfa drugs"
                  disabled={attachSymptomMut.isPending}
                />
              </Field>

              <div className="flex justify-between pt-2">
                <Button type="button" variant="ghost" onClick={() => { setHold(null); setStep('slots'); }} disabled={attachSymptomMut.isPending}>Back</Button>
                <Button type="submit" loading={attachSymptomMut.isPending}>Next: Review & Confirm</Button>
              </div>
            </form>
          </CardBody>
        </Card>
      )}

      {/* Step: Review & Confirm */}
      {step === 'confirm' && hold && (
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900">Review & Confirm</h2>
          </CardHeader>
          <CardBody className="space-y-4">
            {confirmError && (
              <ErrorBanner title="Booking failed" message={confirmError} action={
                <Button variant="outline" onClick={resetToDateStep} size="sm">Pick another slot</Button>
              } />
            )}

            <dl className="space-y-3 text-sm">
              <div className="flex justify-between"><dt className="text-gray-500">Doctor</dt><dd className="font-medium">Dr. {doctor?.fullName ?? doctorId}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Date</dt><dd className="font-medium">{formatDate(selectedDate)}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Time</dt><dd className="font-medium">{hold.startTime}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Complaint</dt><dd className="font-medium">{symptomForm.primaryComplaint}</dd></div>
              {symptomForm.severity && <div className="flex justify-between"><dt className="text-gray-500">Severity</dt><dd className="font-medium">{symptomForm.severity}</dd></div>}
            </dl>

            <div className="pt-4 border-t flex justify-end gap-2">
              <Button variant="ghost" onClick={() => { setHold(null); setStep('slots'); }} disabled={confirmMut.isPending}>Back</Button>
              <Button onClick={() => confirmMut.mutate()} loading={confirmMut.isPending} variant={confirmError ? 'danger' : 'primary'}>
                {confirmError ? 'Try another slot' : 'Confirm Booking'}
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {/* Fallback if hold expired mid-flow */}
      {hold && isExpired && step !== 'date' && (
        <ErrorBanner
          title="Hold expired"
          message="Your slot hold has expired. Please pick a slot again."
          action={<Button variant="outline" onClick={resetToDateStep} size="sm">Pick another slot</Button>}
        />
      )}
    </div>
  );
}