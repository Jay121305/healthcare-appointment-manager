// app/(admin)/dashboard/page.tsx — list all doctors (admin).
// GET /admin/doctors (paginated, filterable).

'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/authContext';
import { Card, EmptyState, SpinnerScreen } from '@/components/ui/Misc';
import { Badge, ErrorBanner } from '@/components/ui/Misc';
import type { DoctorWithUser, PaginatedResponse } from '@/lib/types';

export default function AdminDashboard() {
  const { user, loading: authLoading } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [specialisation, setSpecialisation] = useState('');

  const { data, isError, error } = useQuery<PaginatedResponse<DoctorWithUser>, ApiError>({
    queryKey: ['admin-doctors', page, search, specialisation],
    queryFn: async () => {
      const params: Record<string, string> = { page: String(page), limit: '20' };
      if (search) params.q = search;
      if (specialisation) params.specialisation = specialisation;
      return api.adminListDoctors(params);
    },
    enabled: !!user && !authLoading,
  });

  if (authLoading) return <SpinnerScreen label="Loading admin account…" />;
  if (!user) return null;
  if (isError) return <ErrorBanner title="Could not load doctors" message={(error as ApiError).raw?.message} />;

  const doctors = data?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-900">Doctors</h1>
        <Link href="/admin/doctors/new">
          <button className="text-sm bg-primary-600 text-white px-3 py-1.5 rounded hover:bg-primary-700">Add Doctor</button>
        </Link>
      </div>

      <Card className="p-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <input
            type="text"
            placeholder="Search name or email"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="rounded border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:ring-2 focus:ring-primary-200"
          />
          <select
            value={specialisation}
            onChange={(e) => { setSpecialisation(e.target.value); setPage(1); }}
            className="rounded border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:ring-2 focus:ring-primary-200"
          >
            <option value="">All specialisations</option>
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
          </select>
        </div>
      </Card>

      {doctors.length === 0 ? (
        <EmptyState title="No doctors found" description="Create your first doctor account to get started." action={
          <Link href="/admin/doctors/new"><button className="text-sm bg-primary-600 text-white px-3 py-1.5 rounded hover:bg-primary-700">Add Doctor</button></Link>
        } />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-medium text-gray-500 border-b">
                  <th className="pb-2">Name</th>
                  <th className="pb-2">Email</th>
                  <th className="pb-2">Specialisation</th>
                  <th className="pb-2">Slot Duration</th>
                  <th className="pb-2">Status</th>
                  <th className="pb-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {doctors.map((doc) => (
                  <tr key={doc.id} className="hover:bg-gray-50">
                    <td className="py-3 font-medium text-gray-900">{doc.fullName}</td>
                    <td className="py-3 text-gray-600">{doc.email}</td>
                    <td className="py-3 text-gray-600">{doc.specialisation}</td>
                    <td className="py-3 text-gray-600">{doc.slotDurationMinutes} min</td>
                    <td className="py-3">
                      <Badge className={doc.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-600'}>
                        {doc.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </td>
                    <td className="py-3">
                      <Link href={`/admin/doctors/${doc.id}`} className="text-primary-700 hover:underline text-sm">Edit</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(data?.total ?? 0) > 20 && (
            <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
              <span>Page {page} of {Math.ceil((data?.total ?? 0) / 20)}</span>
              <div className="flex gap-2">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-2 py-1 border border-gray-300 rounded disabled:opacity-50">Prev</button>
                <button onClick={() => setPage((p) => p + 1)} disabled={page >= Math.ceil((data?.total ?? 0) / 20)} className="px-2 py-1 border border-gray-300 rounded disabled:opacity-50">Next</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}