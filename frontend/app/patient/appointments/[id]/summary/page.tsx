// app/(patient)/appointments/[id]/summary/page.tsx — post-visit summary view.
// GET /visits/:bookingId/summary (alias for /visits/:bookingId/post-summary per M4).

'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/authContext';
import { api, ApiError } from '@/lib/api';
import { SpinnerScreen, ErrorBanner } from '@/components/ui/Misc';
import { SummaryChat } from '@/components/shared/SummaryChat';

export default function PostVisitSummaryPage() {
  const params = useParams();
  const { user, loading: authLoading } = useAuth();
  const bookingId = params.id as string;

  const { data: summary, isLoading, isError, error } = useQuery({
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
      isDoctor={false}
      initialLlmStatus={summary.llmStatus}
    />
  );
}