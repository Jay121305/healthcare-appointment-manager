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
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">Post-Visit Summary (Doctor View)</h1>
        <p className="text-sm text-gray-500">Generated {formatDateTime(summary.generatedAt ?? new Date())}</p>
      </div>

      <Card className={cn(summary.llmStatus === 'FALLBACK' && 'border-amber-200 bg-amber-50')}>
        <CardHeader className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">Patient-Facing Summary</h2>
          <Badge className={llmStatusBadgeClass(summary.llmStatus)}>{llmStatusVerb(summary.llmStatus)}</Badge>
        </CardHeader>
        <CardBody className="space-y-2">
          <p className="text-gray-700 whitespace-pre-wrap">{summary.summaryText}</p>
          {summary.llmStatus === 'FALLBACK' && (
            <div className="border border-amber-300 bg-amber-50 rounded-md p-3 text-sm text-amber-900 mt-2">
              <p className="font-semibold">AI summary unavailable</p>
              <p className="mt-1">This is a standard fallback summary. The AI service was unable to generate a personalized summary.</p>
            </div>
          )}
        </CardBody>
      </Card>

      {summary.doctorNotes && (
        <Card className="border-blue-200 bg-blue-50">
          <CardHeader>
            <h2 className="text-sm font-semibold text-gray-900">Your Raw Notes (Doctor Only)</h2>
          </CardHeader>
          <CardBody>
            <p className="text-gray-700 whitespace-pre-wrap">{summary.doctorNotes}</p>
          </CardBody>
        </Card>
      )}
    </div>
  );
}