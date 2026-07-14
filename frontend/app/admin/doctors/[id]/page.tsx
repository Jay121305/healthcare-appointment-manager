// app/(admin)/doctors/[id]/page.tsx — edit doctor profile + slot preview + leave list.
// GET /admin/doctors/:id, PUT /admin/doctors/:id, DELETE /admin/doctors/:id,
// GET /admin/doctors/:id/slots, GET /admin/doctors/:id/leave, DELETE /admin/doctors/:id/leave/:leaveId

'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDate } from '@/lib/utils';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/authContext';
import { useToast } from '@/components/ui/Toast';
import { Card, CardHeader, CardBody, SpinnerScreen, EmptyState } from '@/components/ui/Misc';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea, Select } from '@/components/ui/Field';
import { ErrorBanner } from '@/components/ui/Misc';
import type { DoctorWithUser, WorkingHours, UpdateDoctorInput } from '@/lib/types';

export default function AdminDoctorEditPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, loading: authLoading } = useAuth();
  const { addToast } = useToast();

  const doctorId = params.id as string;
  const [form, setForm] = useState<UpdateDoctorInput>({});
  const [selectedDate, setSelectedDate] = useState<string>('');

  const { data: doctor, isLoading: doctorLoading } = useQuery<DoctorWithUser, ApiError>({
    queryKey: ['admin-doctor', doctorId],
    queryFn: () => api.adminGetDoctor(doctorId),
    enabled: !!user && !authLoading,
  });

  const { data: slotsData, isLoading: slotsLoading } = useQuery({
    queryKey: ['admin-doctor-slots', doctorId, selectedDate],
    queryFn: () => api.adminGetDoctorSlots(doctorId, selectedDate),
    enabled: !!selectedDate && !!user,
  });

  const { data: leaveData } = useQuery({
    queryKey: ['admin-doctor-leave', doctorId],
    queryFn: () => api.adminGetLeaveDays(doctorId),
    enabled: !!user,
  });

  const updateMut = useMutation({
    mutationFn: (input: UpdateDoctorInput) => api.adminUpdateDoctor(doctorId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-doctor', doctorId] });
      queryClient.invalidateQueries({ queryKey: ['admin-doctors'] });
      addToast({ type: 'success', title: 'Doctor updated' });
    },
    onError: (err: ApiError) => addToast({ type: 'error', title: 'Update failed', message: err.raw?.message }),
  });

  const deleteMut = useMutation({
    mutationFn: () => api.adminDeleteDoctor(doctorId),
    onSuccess: () => {
      addToast({ type: 'success', title: 'Doctor deactivated' });
      router.push('/admin/dashboard');
    },
    onError: (err: ApiError) => {
      if (err.code === 'UPCOMING_BOOKINGS_EXIST') {
        addToast({ type: 'error', title: 'Cannot delete', message: `${err.raw?.bookingIds?.length ?? 'Some'} upcoming bookings exist.` });
      } else {
        addToast({ type: 'error', title: 'Delete failed', message: err.raw?.message });
      }
    },
  });

  const deleteLeaveMut = useMutation({
    mutationFn: (leaveId: string) => api.adminDeleteLeaveDay(doctorId, leaveId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-doctor-leave', doctorId] });
      addToast({ type: 'success', title: 'Leave day removed' });
    },
    onError: (err: ApiError) => addToast({ type: 'error', title: 'Delete failed', message: err.raw?.message }),
  });

  useEffect(() => {
    if (doctor) {
      setForm({
        fullName: doctor.fullName,
        specialisation: doctor.specialisation,
        workingHours: doctor.workingHours as WorkingHours,
        slotDurationMinutes: doctor.slotDurationMinutes,
        phone: doctor.phone ?? undefined,
        isActive: doctor.isActive,
      });
    }
  }, [doctor]);

  if (authLoading) return <SpinnerScreen />;
  if (!user) return null;
  if (doctorLoading) return <SpinnerScreen label="Loading doctor…" />;
  if (!doctor) return <ErrorBanner title="Not found" message="Doctor not found." />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Edit Doctor</h1>
          <p className="text-sm text-gray-500">Dr. {doctor.fullName} ({doctor.email})</p>
        </div>
      </div>

      {/* Profile Form */}
      <Card>
        <CardHeader><h2 className="text-sm font-semibold text-gray-900">Profile</h2></CardHeader>
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name" htmlFor="fullName">
              <Input id="fullName" value={form.fullName} onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))} required />
            </Field>
            <Field label="Specialisation" htmlFor="specialisation">
              <Select id="specialisation" value={form.specialisation} onChange={(e) => setForm((f) => ({ ...f, specialisation: e.target.value }))}>
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
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Slot duration (min)" htmlFor="slotDuration">
              <Input id="slotDuration" type="number" min="5" max="180" value={form.slotDurationMinutes} onChange={(e) => setForm((f) => ({ ...f, slotDurationMinutes: Number(e.target.value) }))} required />
            </Field>
            <Field label="Phone" htmlFor="phone">
              <Input id="phone" type="tel" value={form.phone ?? ''} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
            </Field>
          </div>
          <Field label="Working Hours (JSON)" htmlFor="workingHours">
            <Textarea id="workingHours" value={JSON.stringify(form.workingHours, null, 2)} onChange={(e) => { try { setForm((f) => ({ ...f, workingHours: JSON.parse(e.target.value) })); } catch {} }} rows={6} className="font-mono text-xs" />
          </Field>
          <Field label="Status" htmlFor="isActive">
            <Select id="isActive" value={String(form.isActive)} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.value === 'true' }))}>
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </Select>
          </Field>
          <div className="pt-4 border-t flex justify-end gap-2">
            <Button onClick={() => updateMut.mutate(form)} loading={updateMut.isPending}>Save Changes</Button>
          </div>
        </CardBody>
      </Card>

      {/* Slot Preview */}
      <Card>
        <CardHeader><h2 className="text-sm font-semibold text-gray-900">Slot Preview</h2></CardHeader>
        <CardBody className="space-y-4">
          <Field label="Date" htmlFor="slotDate">
            <Input id="slotDate" type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} required />
          </Field>
          {selectedDate && (
            <div>
              {slotsLoading ? (
                <SpinnerScreen label="Loading slots…" />
              ) : slotsData?.slots?.length === 0 ? (
                <EmptyState title="No slots" description={slotsData?.reason ?? 'No available slots for this date.'} />
              ) : (
                <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {slotsData?.slots?.filter((s) => s.available).map((slot) => (
                    <div key={slot.startUTC} className="p-2 border border-gray-300 rounded bg-green-50 text-sm text-center text-green-800">
                      {slot.startTimeLocal} – {slot.endUTC.slice(11, 16)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Leave Days */}
      <Card>
        <CardHeader className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">Leave Days</h2>
          <a href={`/admin/doctors/${doctorId}/leave/new`}>
            <Button size="sm">Add Leave</Button>
          </a>
        </CardHeader>
        <CardBody>
          {leaveData?.leaveDays?.length === 0 ? (
            <EmptyState title="No leave days" description="Add leave days using the button above." />
          ) : (
            <div className="space-y-2">
              {leaveData?.leaveDays?.map((ld) => (
                <div key={ld.leaveDate} className="flex items-center justify-between p-3 border border-gray-200 rounded">
                  <div>
                    <p className="font-medium text-gray-900">{formatDate(ld.leaveDate)}</p>
                    {ld.reason && <p className="text-sm text-gray-500">{ld.reason}</p>}
                  </div>
                  <Button variant="danger" size="sm" onClick={() => deleteLeaveMut.mutate(ld.leaveDate)}>Remove</Button>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Danger Zone */}
      <Card className="border-red-200 bg-red-50">
        <CardHeader>
          <h2 className="text-sm font-semibold text-red-900">Danger Zone</h2>
        </CardHeader>
        <CardBody>
          <p className="text-sm text-red-700 mb-2">Deactivating this doctor will prevent new bookings. Deleting (soft-delete) is only possible if no upcoming bookings exist.</p>
          <div className="flex gap-2">
            <Button variant="danger" onClick={() => { if (confirm('Deactivate this doctor? They cannot be booked but data is preserved.')) updateMut.mutate({ ...form, isActive: false }); }}>Deactivate</Button>
            <Button variant="danger" onClick={() => { if (confirm('Soft-delete this doctor? This cannot be undone if upcoming bookings exist.')) deleteMut.mutate(); }}>Soft Delete</Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}