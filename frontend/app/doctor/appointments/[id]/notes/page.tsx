// app/(doctor)/appointments/[id]/notes/page.tsx — clinical notes + prescriptions form.
// POST /visits/:bookingId/notes (M4).

'use client';

import { useParams, useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/authContext';
import { useToast } from '@/components/ui/Toast';
import { Card, CardHeader, CardBody, SpinnerScreen } from '@/components/ui/Misc';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Field';

export default function DoctorNotesPage() {
  const params = useParams();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { addToast } = useToast();
  const bookingId = params.id as string;

  const [notes, setNotes] = useState('');
  const [prescriptions, setPrescriptions] = useState<Array<{
    medicationName: string; dosage: string; frequency: string; frequencyCustom: string; startDate: string; endDate: string; instructions: string;
  }>>([{ medicationName: '', dosage: '', frequency: 'ONCE_DAILY', frequencyCustom: '', startDate: '', endDate: '', instructions: '' }]);

  const submitMut = useMutation({
    mutationFn: (input: { notes: string; prescriptions?: typeof prescriptions }) => api.submitNotes(bookingId, input),
    onSuccess: () => {
      addToast({ type: 'success', title: 'Notes submitted', message: 'Post-visit summary generation queued.' });
      router.push(`/doctor/appointments/${bookingId}/summary`);
    },
    onError: (err: ApiError) => addToast({ type: 'error', title: 'Submit failed', message: err.raw?.message }),
  });

  if (authLoading) return <SpinnerScreen />;
  if (!user) return null;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">Clinical Notes & Prescriptions</h1>
        <p className="text-sm text-gray-500">Appointment: {bookingId}</p>
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-gray-900">Clinical Notes</h2>
        </CardHeader>
        <CardBody>
          <Field label="Notes" htmlFor="notes">
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Enter clinical findings, diagnosis, treatment plan…"
              rows={6}
              required
            />
          </Field>
          {submitMut.isPending && <p className="mt-2 text-xs text-primary-600">Submitting…</p>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">Prescriptions</h2>
          <Button variant="ghost" size="sm" onClick={() => setPrescriptions((p) => [...p, { medicationName: '', dosage: '', frequency: 'ONCE_DAILY', frequencyCustom: '', startDate: '', endDate: '', instructions: '' }])}>
            + Add prescription
          </Button>
        </CardHeader>
        <CardBody className="space-y-4">
          {prescriptions.map((rx, idx) => (
            <div key={idx} className="border border-gray-200 rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-medium text-gray-700">Prescription {idx + 1}</span>
                {prescriptions.length > 1 && (
                  <button type="button" onClick={() => setPrescriptions((p) => p.filter((_, i) => i !== idx))} className="text-red-600 text-sm hover:underline">Remove</button>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Medication name" htmlFor={`med-${idx}`}>
                  <Input id={`med-${idx}`} value={rx.medicationName} onChange={(e) => setPrescriptions((p) => p.map((r, i) => i === idx ? { ...r, medicationName: e.target.value } : r))} required />
                </Field>
                <Field label="Dosage" htmlFor={`dos-${idx}`}>
                  <Input id={`dos-${idx}`} value={rx.dosage} onChange={(e) => setPrescriptions((p) => p.map((r, i) => i === idx ? { ...r, dosage: e.target.value } : r))} required />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Frequency" htmlFor={`freq-${idx}`}>
                  <select id={`freq-${idx}`} value={rx.frequency} onChange={(e) => setPrescriptions((p) => p.map((r, i) => i === idx ? { ...r, frequency: e.target.value } : r))} className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:ring-2 focus:ring-primary-200">
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
                  <Field label="Custom frequency" htmlFor={`freqc-${idx}`}>
                    <Input id={`freqc-${idx}`} value={rx.frequencyCustom} onChange={(e) => setPrescriptions((p) => p.map((r, i) => i === idx ? { ...r, frequencyCustom: e.target.value } : r))} placeholder="e.g., every 8 hours for 5 days" />
                  </Field>
                )}
                <Field label="Start date" htmlFor={`start-${idx}`}>
                  <Input id={`start-${idx}`} type="date" value={rx.startDate} onChange={(e) => setPrescriptions((p) => p.map((r, i) => i === idx ? { ...r, startDate: e.target.value } : r))} required />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="End date (optional)" htmlFor={`end-${idx}`}>
                  <Input id={`end-${idx}`} type="date" value={rx.endDate} onChange={(e) => setPrescriptions((p) => p.map((r, i) => i === idx ? { ...r, endDate: e.target.value } : r))} />
                </Field>
              </div>
              <Field label="Instructions (optional)" htmlFor={`instr-${idx}`}>
                <Textarea id={`instr-${idx}`} value={rx.instructions} onChange={(e) => setPrescriptions((p) => p.map((r, i) => i === idx ? { ...r, instructions: e.target.value } : r))} rows={2} placeholder="Take with food, avoid alcohol, etc." />
              </Field>
            </div>
          ))}
        </CardBody>
      </Card>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => router.back()} disabled={submitMut.isPending}>Back</Button>
        <Button onClick={() => submitMut.mutate({ notes, prescriptions })} loading={submitMut.isPending} disabled={!notes.trim()}>
          Submit Notes & Prescriptions
        </Button>
      </div>
    </div>
  );
}