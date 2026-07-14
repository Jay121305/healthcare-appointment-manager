// app/(patient)/doctors/page.tsx — doctor search by specialisation.
// GET /doctors?specialisation= — per task spec M2 endpoint list.

'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Card, CardBody, EmptyState, SpinnerScreen } from '@/components/ui/Misc';
import { Badge } from '@/components/ui/Misc';
import { Field, Input, Select } from '@/components/ui/Field';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/authContext';
import type { DoctorPublicDTO, PaginatedResponse } from '@/lib/types';

const SPECIALISATIONS = [
  'Cardiology',
  'Dermatology',
  'Endocrinology',
  'Gastroenterology',
  'General Medicine',
  'Neurology',
  'Oncology',
  'Orthopedics',
  'Pediatrics',
  'Psychiatry',
  'Radiology',
  'Urology',
] as const;

export default function PatientDoctorsPage() {
  const { user, loading: authLoading } = useAuth();
  const [search, setSearch] = useState('');
  const [specialisation, setSpecialisation] = useState('');
  const [page, setPage] = useState(1);

  const { data, isError } = useQuery<PaginatedResponse<DoctorPublicDTO>, ApiError>({
    queryKey: ['doctors', search, specialisation, page],
    queryFn: async () => {
      const params: Record<string, string> = { page: String(page), limit: '10' };
      if (search) params.q = search;
      if (specialisation) params.specialisation = specialisation;
      return api.listDoctors(params);
    },
    enabled: !!user && !authLoading,
  });

  if (authLoading) return <SpinnerScreen label="Loading your account…" />;
  if (!user) return null;

  if (isError) {
    return (
      <div className="space-y-6">
        <h1 className="text-lg font-semibold text-gray-900">Find a Doctor</h1>
        <div className="border border-dashed border-gray-300 rounded-lg p-8 text-center">
          <p className="text-sm font-medium text-gray-700">Doctor search unavailable</p>
          <p className="mt-1 text-xs text-gray-500">
            The backend endpoint <code className="bg-gray-100 px-1 rounded">GET /doctors</code> is not yet implemented.
            See assumption A2(M7).
          </p>
        </div>
      </div>
    );
  }

  const doctors = data?.items ?? [];

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-gray-900">Find a Doctor</h1>

      <Card className="p-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Search by name">
            <Input
              placeholder="Dr. Smith"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </Field>
          <Field label="Specialisation">
            <Select
              value={specialisation}
              onChange={(e) => { setSpecialisation(e.target.value); setPage(1); }}
            >
              <option value="">All specialisations</option>
              {SPECIALISATIONS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end">
            <button
              onClick={() => { setSearch(''); setSpecialisation(''); setPage(1); }}
              className="w-full text-sm border border-gray-300 text-gray-700 py-1.5 rounded hover:bg-gray-50"
            >
              Clear filters
            </button>
          </div>
        </div>
      </Card>

      {doctors.length === 0 ? (
        <EmptyState
          title="No doctors found"
          description="Try adjusting your search or filters."
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {doctors.map((doc) => (
              <Card key={doc.id} className="flex flex-col">
                <CardBody className="flex-1 flex flex-col justify-between">
                  <div>
                    <p className="font-medium text-gray-900">{doc.fullName}</p>
                    <p className="text-xs text-gray-500">{doc.specialisation}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      <Badge className="bg-gray-100 text-gray-700">{doc.slotDurationMinutes} min slots</Badge>
                      {doc.nextAvailableDate && (
                        <Badge className="bg-emerald-100 text-emerald-700">
                          Next: {doc.nextAvailableDate}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <Link
                    href={`/patient/book/${doc.id}`}
                    className="mt-3 text-center text-sm bg-primary-600 text-white py-1.5 rounded hover:bg-primary-700"
                  >
                    Book appointment
                  </Link>
                </CardBody>
              </Card>
            ))}
          </div>

          {(data?.total ?? 0) > 10 && (
            <div className="flex justify-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1 border border-gray-300 rounded disabled:opacity-50 text-sm"
              >
                Previous
              </button>
              <span className="flex items-center px-3 text-sm text-gray-500">Page {page}</span>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page >= Math.ceil((data?.total ?? 0) / 10)}
                className="px-3 py-1 border border-gray-300 rounded disabled:opacity-50 text-sm"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}