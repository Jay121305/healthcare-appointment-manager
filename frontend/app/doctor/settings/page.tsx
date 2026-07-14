// app/(doctor)/settings/page.tsx — doctor profile + Google Calendar connect/disconnect.

'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/authContext';
import { useToast } from '@/components/ui/Toast';
import { Card, CardHeader, CardBody, SpinnerScreen } from '@/components/ui/Misc';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { Badge, ErrorBanner } from '@/components/ui/Misc';
import type { CalendarStatusResponse, DoctorProfile } from '@/lib/types';

export default function DoctorSettingsPage() {
  const { user, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const { addToast } = useToast();

  const [form, setForm] = useState({ fullName: '', specialisation: '', phone: '', workingHours: '' });

  const { data: calendarStatus, isLoading: calLoading } = useQuery<CalendarStatusResponse, ApiError>({
    queryKey: ['calendar-status'],
    queryFn: () => api.calendarStatus(),
    enabled: !!user && !authLoading,
  });

  const connectMut = useMutation({
    mutationFn: () => api.calendarConnect(),
    onSuccess: (res) => { window.location.href = res.redirectUrl; },
    onError: (err: ApiError) => addToast({ type: 'error', title: 'Connect failed', message: err.raw?.message }),
  });

  const disconnectMut = useMutation({
    mutationFn: () => api.calendarDisconnect(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['calendar-status'] }); addToast({ type: 'success', title: 'Calendar disconnected' }); },
    onError: (err: ApiError) => addToast({ type: 'error', title: 'Disconnect failed', message: err.raw?.message }),
  });

  useEffect(() => {
    if (user?.profile) {
      const p = user.profile as DoctorProfile;
      setForm({ fullName: p.fullName, specialisation: p.specialisation, phone: p.phone ?? '', workingHours: JSON.stringify(p.workingHours, null, 2) });
    }
  }, [user]);

  const saveProfile = async () => {
    // No backend endpoint for doctor self-profile update yet — placeholder
    addToast({ type: 'info', title: 'Profile edit', message: 'Backend endpoint for doctor self-update pending.' });
  };

  if (authLoading) return <SpinnerScreen />;
  if (!user) return null;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-lg font-semibold text-gray-900">Settings</h1>

      {/* Profile */}
      <Card>
        <CardHeader><h2 className="text-sm font-semibold text-gray-900">Profile</h2></CardHeader>
        <CardBody className="space-y-4">
          <Field label="Full name" htmlFor="fullName">
            <Input id="fullName" value={form.fullName} onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))} required />
          </Field>
          <Field label="Specialisation" htmlFor="specialisation">
            <Input id="specialisation" value={form.specialisation} onChange={(e) => setForm((f) => ({ ...f, specialisation: e.target.value }))} required />
          </Field>
          <Field label="Phone" htmlFor="phone">
            <Input id="phone" type="tel" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
          </Field>
          <Field label="Working Hours (JSON)" htmlFor="workingHours" hint='e.g., {"mon":{"start":"09:00","end":"17:00"},"tue":{"start":"09:00","end":"17:00"}}'>
            <Textarea id="workingHours" value={form.workingHours} onChange={(e) => { try { setForm((f) => ({ ...f, workingHours: JSON.parse(e.target.value) })); } catch {} }} rows={4} className="font-mono text-xs" />
          </Field>
          <div className="pt-4 border-t flex justify-end">
            <Button onClick={saveProfile}>Save Profile</Button>
          </div>
        </CardBody>
      </Card>

      {/* Google Calendar */}
      <Card>
        <CardHeader><h2 className="text-sm font-semibold text-gray-900">Google Calendar Sync</h2></CardHeader>
        <CardBody className="space-y-4">
          {calLoading ? (
            <div className="text-sm text-gray-500">Loading calendar status…</div>
          ) : calendarStatus ? (
            <div className="space-y-3">
              <dl className="grid gap-2 sm:grid-cols-3 text-sm">
                <dt className="text-gray-500">Status</dt>
                <dd className="font-medium">
                  {calendarStatus.connected ? <Badge className="bg-emerald-100 text-emerald-800">Connected</Badge> : <Badge className="bg-gray-100 text-gray-600">Not connected</Badge>}
                </dd>
                {calendarStatus.connected && calendarStatus.googleEmail && (
                  <>
                    <dt className="text-gray-500">Google account</dt>
                    <dd className="font-medium col-span-2">{calendarStatus.googleEmail}</dd>
                  </>
                )}
                {calendarStatus.connected && calendarStatus.connectedAt && (
                  <>
                    <dt className="text-gray-500">Connected</dt>
                    <dd className="font-medium col-span-2">{new Date(calendarStatus.connectedAt).toLocaleString()}</dd>
                  </>
                )}
              </dl>
              <div className="pt-4 border-t flex gap-2">
                {!calendarStatus.connected ? (
                  <Button onClick={() => connectMut.mutate()} loading={connectMut.isPending}>Connect Google Calendar</Button>
                ) : (
                  <Button variant="danger" onClick={() => disconnectMut.mutate()} loading={disconnectMut.isPending}>Disconnect</Button>
                )}
              </div>
              <p className="text-xs text-gray-500">
                When connected, confirmed appointments and reschedules will sync to your Google Calendar.
                Cancellations remove the event. This is best-effort — failures don&apos;t affect your booking.
              </p>
            </div>
          ) : (
            <ErrorBanner title="Could not load calendar status" message="Please try again later." />
          )}
        </CardBody>
      </Card>
    </div>
  );
}