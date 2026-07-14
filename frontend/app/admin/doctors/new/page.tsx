// app/(admin)/doctors/new/page.tsx — create doctor form.
// POST /admin/doctors.

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/authContext';
import { useToast } from '@/components/ui/Toast';
import { Card, CardHeader, CardBody, SpinnerScreen } from '@/components/ui/Misc';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea, Select } from '@/components/ui/Field';
import { ErrorBanner } from '@/components/ui/Misc';
import type { CreateDoctorInput } from '@/lib/types';

export default function NewDoctorPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { addToast } = useToast();

  const [form, setForm] = useState<CreateDoctorInput>({
    email: '',
    password: '',
    fullName: '',
    specialisation: 'General Medicine',
    workingHours: {
      mon: { start: '09:00', end: '17:00' },
      tue: { start: '09:00', end: '17:00' },
      wed: { start: '09:00', end: '17:00' },
      thu: { start: '09:00', end: '17:00' },
      fri: { start: '09:00', end: '17:00' },
      sat: null,
      sun: null,
    },
    slotDurationMinutes: 30,
    phone: '',
  });
  const [error, setError] = useState('');

  const createMut = useMutation({
    mutationFn: (input: CreateDoctorInput) => api.adminCreateDoctor(input),
    onSuccess: () => {
      addToast({ type: 'success', title: 'Doctor created', message: 'Doctor account has been created.' });
      router.push('/admin/dashboard');
    },
    onError: (err: ApiError) => {
      if (err.code === 'USER_EXISTS') setError('An account with this email already exists.');
      else addToast({ type: 'error', title: 'Create failed', message: err.raw?.message });
    },
  });

  if (authLoading) return <SpinnerScreen />;
  if (!user) return null;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-900">Create Doctor</h1>
      </div>

      {error && <ErrorBanner title="Error" message={error} />}

      <Card>
        <CardHeader><h2 className="text-sm font-semibold text-gray-900">Account Details</h2></CardHeader>
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Email" htmlFor="email">
              <Input id="email" type="email" autoComplete="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} required disabled={createMut.isPending} />
            </Field>
            <Field label="Password" htmlFor="password">
              <Input id="password" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} required minLength={8} disabled={createMut.isPending} />
            </Field>
          </div>
          <Field label="Full name" htmlFor="fullName">
            <Input id="fullName" value={form.fullName} onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))} required disabled={createMut.isPending} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Specialisation" htmlFor="specialisation">
              <Select id="specialisation" value={form.specialisation} onChange={(e) => setForm((f) => ({ ...f, specialisation: e.target.value }))} disabled={createMut.isPending}>
                <option value="Cardiology">Cardiology</option>
                <option value="Dermatology">Dermatology</option>
                <option value="Endocrinology">Endocrinology</option>
                <option value="Gastroenterology">Gastroenterology</option>
                <option value="General Medicine">General Medicine</option>
                <option value="Neurology">Neurology</option>
                <option value="Oncology">Oncology</option>
                <option value="Orthopedics">Orthopedics</option>
                <option value="Pediatrics">Pediatrics</option>
                <option value="Psychiatry">Psychiatry</option>
                <option value="Radiology">Radiology</option>
                <option value="Urology">Urology</option>
              </Select>
            </Field>
            <Field label="Slot duration (min)" htmlFor="slotDuration">
              <Input id="slotDuration" type="number" min="5" max="180" value={form.slotDurationMinutes} onChange={(e) => setForm((f) => ({ ...f, slotDurationMinutes: Number(e.target.value) }))} required disabled={createMut.isPending} />
            </Field>
          </div>
          <Field label="Phone" htmlFor="phone">
            <Input id="phone" type="tel" value={form.phone ?? ''} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} disabled={createMut.isPending} />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><h2 className="text-sm font-semibold text-gray-900">Working Hours</h2></CardHeader>
        <CardBody className="space-y-4">
          <p className="text-xs text-gray-500">Enter as JSON. Days: mon, tue, wed, thu, fri, sat, sun. Use null for off days.</p>
          <Textarea
            value={JSON.stringify(form.workingHours, null, 2)}
            onChange={(e) => {
              try {
                const parsed = JSON.parse(e.target.value);
                setForm((f) => ({ ...f, workingHours: parsed }));
              } catch {
                // ignore invalid JSON while typing
              }
            }}
            rows={8}
            className="font-mono text-xs"
            disabled={createMut.isPending}
          />
        </CardBody>
      </Card>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => router.back()} disabled={createMut.isPending}>Cancel</Button>
        <Button onClick={() => createMut.mutate(form)} loading={createMut.isPending} disabled={createMut.isPending}>
          Create Doctor
        </Button>
      </div>
    </div>
  );
}