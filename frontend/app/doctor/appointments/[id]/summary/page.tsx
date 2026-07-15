// app/(doctor)/appointments/[id]/summary/page.tsx — post-visit summary read (doctor view with raw notes).
// GET /visits/:bookingId/summary (same endpoint as patient, but includes doctorNotes for doctor role).

'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { formatDateTime, llmStatusBadgeClass, llmStatusVerb, cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/authContext';
import { Card, CardHeader, CardBody, SpinnerScreen, Badge, ErrorBanner } from '@/components/ui/Misc';
import type { PostVisitSummaryResponse } from '@/lib/types';
import { SummaryChat } from '@/components/shared/SummaryChat';

export default function DoctorSummaryPage() {
  const params = useParams();
  const { user, loading: authLoading } = useAuth();
  const bookingId = params.id as string;

  const { data: summary, isLoading, isError, error } = useQuery<PostVisitSummaryResponse, ApiError>({
    queryKey: ['post-visit-summary', bookingId],
    queryFn: () => api.getPostVisitSummary(bookingId),
    enabled: !!user && !authLoading,
    retry: false,
  });

  if (authLoading) return <SpinnerScreen label="Loading your account…" />;
  if (!user) return null;
  if (isLoading) return <SpinnerScreen label="Loading summary…" />;
  if (isError) return <ErrorBanner title="Summary not available" message={(error as ApiError).raw?.message ?? 'Could not load post-visit summary.'} />;
  if (!summary) return <ErrorBanner title="Not found" message="Post-visit summary not yet generated." />;

  return (
    <SummaryChat
      bookingId={bookingId}
      initialSummary={summary.summaryText}
      isDoctor={true}
      initialLlmStatus={summary.llmStatus}
      doctorNotes={summary.doctorNotes ?? ''}
    />
  );
}