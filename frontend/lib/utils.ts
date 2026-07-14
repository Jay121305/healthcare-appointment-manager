// lib/utils.ts
// Pure display helpers used across the UI.

import type { BookingStatus, LlmStatus, UrgencyLevel } from './types';

export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ');
}

export function formatDate(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatTime(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function statusBadgeClass(status: BookingStatus): string {
  switch (status) {
    case 'CONFIRMED':
      return 'bg-emerald-100 text-emerald-800';
    case 'COMPLETED':
      return 'bg-blue-100 text-blue-800';
    case 'CANCELLED':
      return 'bg-gray-200 text-gray-700';
    case 'NO_SHOW':
      return 'bg-red-100 text-red-800';
    case 'RESCHEDULED':
      return 'bg-amber-100 text-amber-800';
    default:
      return 'bg-gray-100 text-gray-700';
  }
}

export function urgencyBadgeClass(level: UrgencyLevel | null | undefined): string {
  if (!level) return 'bg-gray-100 text-gray-700';
  switch (level) {
    case 'Low':
      return 'bg-emerald-100 text-emerald-800';
    case 'Medium':
      return 'bg-amber-100 text-amber-800';
    case 'High':
      return 'bg-red-100 text-red-800';
    default:
      return 'bg-gray-100 text-gray-700';
  }
}

export function urgencyLabel(level: UrgencyLevel | string | null | undefined): UrgencyLevel {
  if (!level) return 'Medium';
  const l = String(level).toLowerCase();
  if (l === 'low') return 'Low';
  if (l === 'high') return 'High';
  return 'Medium';
}

export function llmStatusBadgeClass(status: LlmStatus): string {
  switch (status) {
    case 'GENERATED':
      return 'bg-emerald-100 text-emerald-800';
    case 'PENDING':
    case 'RETRYING':
      return 'bg-amber-100 text-amber-800';
    case 'FALLBACK':
      return 'bg-amber-200 text-amber-900';
    case 'FAILED':
      return 'bg-red-100 text-red-800';
    default:
      return 'bg-gray-100 text-gray-700';
  }
}

export function llmStatusVerb(status: LlmStatus): string {
  switch (status) {
    case 'PENDING':
      return 'Generating';
    case 'RETRYING':
      return 'Retrying LLM';
    case 'FALLBACK':
      return 'AI unavailable — standard summary shown';
    case 'FAILED':
      return 'AI summary failed';
    case 'GENERATED':
      return 'AI-generated';
    default:
      return 'Unknown';
  }
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function todayLocalDateInput(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(base: Date, days: number): Date {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

export function toLocalDateInput(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}