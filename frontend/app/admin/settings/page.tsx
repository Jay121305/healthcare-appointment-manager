// app/(admin)/settings/page.tsx — read-only admin settings / health check.

'use client';

import { useAuth } from '@/lib/authContext';
import { Card, CardHeader, CardBody, SpinnerScreen, Badge } from '@/components/ui/Misc';

export default function AdminSettingsPage() {
  const { user, loading: authLoading } = useAuth();

  if (authLoading) return <SpinnerScreen />;
  if (!user) return null;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-lg font-semibold text-gray-900">Admin Settings</h1>

      <Card>
        <CardHeader><h2 className="text-sm font-semibold text-gray-900">Environment Health</h2></CardHeader>
        <CardBody className="space-y-4">
          <dl className="grid gap-2 sm:grid-cols-3 text-sm">
            <dt className="text-gray-500">Environment</dt>
            <dd className="font-medium">Production</dd>
            <dt className="text-gray-500">Backend URL</dt>
            <dd className="font-medium font-mono text-xs">{process.env.NEXT_PUBLIC_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}</dd>
            <dt className="text-gray-500">Status</dt>
            <dd className="font-medium"><Badge className="bg-emerald-100 text-emerald-800">Healthy</Badge></dd>
          </dl>
          <p className="text-xs text-gray-500 mt-2">This panel is read-only. Worker health, queue depths, and database stats would be added here in a production build.</p>
        </CardBody>
      </Card>
    </div>
  );
}