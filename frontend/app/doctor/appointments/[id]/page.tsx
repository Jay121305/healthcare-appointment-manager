// app/(doctor)/appointments/[id]/page.tsx — booking detail + pre-visit summary + notes form.
// GET /bookings/:id, GET /visits/:bookingId/pre-summary (G2 gap), POST /visits/:bookingId/notes.

'use client';

import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatDate, formatTime, formatDateTime, cn, urgencyBadgeClass, llmStatusBadgeClass, llmStatusVerb, statusBadgeClass } from '@/lib/utils';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/authContext';
import { useToast } from '@/components/ui/Toast';
import { Card, CardHeader, CardBody, SpinnerScreen } from '@/components/ui/Misc';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { Badge, ErrorBanner, WarningBanner } from '@/components/ui/Misc';
import type { BookingResponse, PreVisitSummaryResponse, PrescriptionInput, SubmitNotesInput } from '@/lib/types';

export default function DoctorAppointmentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, loading: authLoading } = useAuth();
  const { addToast } = useToast();

  const bookingId = params.id as string;
  const [notes, setNotes] = useState('');
  const [prescriptions, setPrescriptions] = useState<PrescriptionInput[]>([]);

  const { data: booking, isLoading: bookingLoading, isError: bookingError } = useQuery<BookingResponse, ApiError>({
    queryKey: ['booking', bookingId],
    queryFn: () => api.getBooking(bookingId),
    enabled: !!user && !authLoading,
  });

  const { data: preVisit, isLoading: preVisitLoading } = useQuery<PreVisitSummaryResponse, ApiError>({
    queryKey: ['pre-visit-summary', bookingId],
    queryFn: () => api.getPreVisitSummary(bookingId),
    enabled: !!user && !authLoading && !bookingError,
    staleTime: 30_000,
  });

  const submitNotesMut = useMutation({
    mutationFn: (input: SubmitNotesInput) => api.submitNotes(bookingId, input),
    onSuccess: () => {
      addToast({ type: 'success', title: 'Notes submitted', message: 'Post-visit summary generation queued.' });
      queryClient.invalidateQueries({ queryKey: ['booking', bookingId] });
      queryClient.invalidateQueries({ queryKey: ['post-visit-summary', bookingId] });
      router.refresh();
    },
    onError: (err: ApiError) => addToast({ type: 'error', title: 'Submit failed', message: err.raw?.message }),
  });

  if (authLoading) return <SpinnerScreen />;
  if (!user) return null;
  if (bookingLoading) return <SpinnerScreen label="Loading appointment…" />;
  if (bookingError || !booking) return <ErrorBanner title="Not found" message="Appointment not found." />;

  const canSubmitNotes = booking.status === 'CONFIRMED' || booking.status === 'COMPLETED';
  const hasNotes = booking.postVisitSummary?.doctorNotes?.trim().length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Appointment Details</h1>
          <p className="text-sm text-gray-500">Patient: {booking.patient?.fullName ?? booking.patientId}</p>
        </div>
        <Badge className={statusBadgeClass(booking.status)}>{booking.status}</Badge>
      </div>

      <Card>
        <CardHeader><h2 className="text-sm font-semibold text-gray-900">Booking Info</h2></CardHeader>
        <CardBody className="grid gap-2 sm:grid-cols-2 text-sm">
          <div><dt className="text-gray-500">Date</dt><dd className="font-medium">{formatDate(booking.bookingDate)}</dd></div>
          <div><dt className="text-gray-500">Time</dt><dd className="font-medium">{formatTime(booking.startTime)}</dd></div>
          <div><dt className="text-gray-500">Booked</dt><dd className="font-medium">{formatDateTime(booking.bookedAt)}</dd></div>
          <div><dt className="text-gray-500">Status</dt><dd className="font-medium"><Badge className={statusBadgeClass(booking.status)}>{booking.status}</Badge></dd></div>
        </CardBody>
      </Card>

      {/* Symptom form */}
      {booking.symptomForm && (
        <Card>
          <CardHeader><h2 className="text-sm font-semibold text-gray-900">Patient Symptom Form</h2></CardHeader>
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

      {/* Pre-visit summary */}
      <Card className={cn(preVisit?.llmStatus === 'FALLBACK' && 'border-amber-200 bg-amber-50')}>
        <CardHeader className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">Pre-Visit Summary (AI)</h2>
          <Badge className={llmStatusBadgeClass(preVisit?.llmStatus ?? 'PENDING')}>
            {preVisit ? llmStatusVerb(preVisit.llmStatus) : 'Loading…'}
          </Badge>
        </CardHeader>
        <CardBody className="space-y-2">
          {preVisitLoading ? (
            <div className="text-sm text-gray-500">Generating pre-visit summary…</div>
          ) : preVisit ? (
            <>
              {preVisit.llmStatus === 'FALLBACK' && (
                <WarningBanner
                  title="AI summary unavailable"
                  message="Showing standard fallback summary below. The raw symptom form is always available above."
                />
              )}
              <div className="flex items-center gap-2">
                <Badge className={urgencyBadgeClass(preVisit.urgencyLevel)}>
                  {preVisit.urgencyLevel ?? 'Unknown'}
                </Badge>
                {preVisit.llmStatus === 'PENDING' && <Badge className="bg-amber-100 text-amber-800">Generating…</Badge>}
              </div>
              {preVisit.chiefComplaint && <p className="text-sm text-gray-700"><span className="font-medium">Chief complaint:</span> {preVisit.chiefComplaint}</p>}
              {preVisit.suggestedQuestions?.length && (
                <div>
                  <p className="text-sm font-medium text-gray-700">Suggested questions:</p>
                  <ul className="text-sm text-gray-600 list-disc list-inside space-y-0.5">
                    {preVisit.suggestedQuestions.map((q, i) => <li key={i}>{q}</li>)}
                  </ul>
                </div>
              )}
              <p className="text-xs text-gray-500">LLM status: {preVisit.llmStatus} (retry {preVisit.retryCount})</p>
            </>
          ) : (
            <p className="text-sm text-gray-400">No pre-visit summary available.</p>
          )}
        </CardBody>
      </Card>

      {/* Notes form / Post-visit summary */}
      <Card>
        <CardHeader><h2 className="text-sm font-semibold text-gray-900">Clinical Notes & Prescription</h2></CardHeader>
        <CardBody className="space-y-4">
          {hasNotes ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-gray-700">Submitted Notes</p>
              <p className="text-sm text-gray-700 whitespace-pre-wrap border border-gray-200 rounded p-3 bg-gray-50">{booking.postVisitSummary?.doctorNotes}</p>
              <div className="flex items-center gap-2">
                <Badge className={llmStatusBadgeClass(booking.postVisitSummary?.llmStatus ?? 'PENDING')}>
                  Post-visit: {booking.postVisitSummary?.llmStatus ? llmStatusVerb(booking.postVisitSummary.llmStatus) : 'Pending'}
                </Badge>
                <a href={`/doctor/appointments/${bookingId}/summary`} className="text-sm text-primary-700 hover:underline">
                  View post-visit summary →
                </a>
              </div>
            </div>
          ) : canSubmitNotes ? (
            <form onSubmit={(e) => { e.preventDefault(); submitNotesMut.mutate({ notes, prescriptions }); }}>
              <Field label="Clinical Notes" htmlFor="notes" required>
                <Textarea
                  id="notes"
                  rows={6}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Enter your clinical notes for this visit…"
                  required
                />
              </Field>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-gray-700">Prescriptions</p>
                  <button type="button" onClick={() => setPrescriptions((p) => [...p, { medicationName: '', dosage: '', frequency: 'ONCE_DAILY', frequencyCustom: '', startDate: '', endDate: '', instructions: '' }])} className="text-xs text-primary-700 hover:underline">Add prescription</button>
                </div>
                {prescriptions.map((rx, i) => (
                  <div key={i} className="border border-gray-200 rounded-lg p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-gray-700">Prescription {i + 1}</span>
                      {prescriptions.length > 0 && <button type="button" onClick={() => setPrescriptions((p) => p.filter((_, j) => j !== i))} className="text-red-600 text-sm hover:underline">Remove</button>}
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Field label="Medication" htmlFor={`med-${i}`}>
                        <Input id={`med-${i}`} value={rx.medicationName} onChange={(e) => setPrescriptions((p) => p.map((r, j) => j === i ? { ...r, medicationName: e.target.value } : r))} required />
                      </Field>
                      <Field label="Dosage" htmlFor={`dos-${i}`}>
                        <Input id={`dos-${i}`} value={rx.dosage} onChange={(e) => setPrescriptions((p) => p.map((r, j) => j === i ? { ...r, dosage: e.target.value } : r))} required />
                      </Field>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <Field label="Frequency" htmlFor={`freq-${i}`}>
                        <select id={`freq-${i}`} value={rx.frequency} onChange={(e) => setPrescriptions((p) => p.map((r, j) => j === i ? { ...r, frequency: e.target.value } : r))} className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:ring-2 focus:ring-primary-200">
                          <option value="ONCE_DAILY">Once daily</option>
                          <option value="TWICE_DAILY">Twice daily</option>
                          <option value="THRICE_DAILY">Thrice daily</option>
                          <option value="QID">Four times daily</option>
                          <option value="WEEKLY">Weekly</option>
                          <option value="PRN">As needed (PRN)</option>
                          <option value="CUSTOM">Custom</option>
                        </select>
                      </Field>
                      {rx.frequency === 'CUSTOM' && (
                        <Field label="Custom frequency" htmlFor={`freqc-${i}`}>
                          <Input id={`freqc-${i}`} value={rx.frequencyCustom ?? ''} onChange={(e) => setPrescriptions((p) => p.map((r, j) => j === i ? { ...r, frequencyCustom: e.target.value } : r))} placeholder="e.g., every 8 hours for 5 days" />
                        </Field>
                      )}
                      <Field label="Start date" htmlFor={`start-${i}`}>
                        <Input id={`start-${i}`} type="date" value={rx.startDate ?? ''} onChange={(e) => setPrescriptions((p) => p.map((r, j) => j === i ? { ...r, startDate: e.target.value } : r))} required />
                      </Field>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Field label="End date (optional)" htmlFor={`end-${i}`}>
                        <Input id={`end-${i}`} type="date" value={rx.endDate ?? ''} onChange={(e) => setPrescriptions((p) => p.map((r, j) => j === i ? { ...r, endDate: e.target.value } : r))} />
                      </Field>
                    </div>
                    <Field label="Instructions (optional)" htmlFor={`instr-${i}`}>
                      <Textarea id={`instr-${i}`} value={rx.instructions ?? ''} onChange={(e) => setPrescriptions((p) => p.map((r, j) => j === i ? { ...r, instructions: e.target.value } : r))} rows={2} placeholder="Take with food, avoid alcohol, etc." />
                    </Field>
                  </div>
                ))}
              </div>

              <div className="pt-4 border-t flex justify-end gap-2">
                <Button variant="ghost" onClick={() => router.back()} disabled={submitNotesMut.isPending}>Back</Button>
                <Button onClick={() => submitNotesMut.mutate({ notes, prescriptions })} loading={submitNotesMut.isPending} disabled={!notes.trim()}>
                  Submit Notes & Prescriptions
                </Button>
              </div>
            </form>
          ) : (
            <p className="text-sm text-gray-500">Notes can be submitted for confirmed or completed appointments.</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
