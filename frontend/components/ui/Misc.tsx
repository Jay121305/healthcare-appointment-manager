// components/ui/Misc.tsx
'use client';

import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full', className)}>
      {children}
    </span>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('border border-gray-200 bg-white rounded-lg shadow-sm', className)}>{children}</div>;
}

export function CardHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-4 py-3 border-b border-gray-200', className)}>{children}</div>;
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-4 py-4', className)}>{children}</div>;
}

export function CardFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-4 py-3 border-t border-gray-200', className)}>{children}</div>;
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="border border-dashed border-gray-300 rounded-lg p-8 text-center">
      <p className="text-sm font-medium text-gray-700">{title}</p>
      {description && <p className="mt-1 text-xs text-gray-500">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorBanner({ title, message, action }: { title: string; message?: string; action?: ReactNode }) {
  return (
    <div className="border border-red-200 bg-red-50 rounded-md p-3 text-sm text-red-800">
      <p className="font-semibold">{title}</p>
      {message && <p className="mt-0.5">{message}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function WarningBanner({ title, message }: { title: string; message?: string }) {
  return (
    <div className="border border-amber-300 bg-amber-50 rounded-md p-3 text-sm text-amber-900">
      <p className="font-semibold">{title}</p>
      {message && <p className="mt-0.5">{message}</p>}
    </div>
  );
}

export function Spinner({ className, size = 'md' }: { className?: string; size?: 'sm' | 'md' | 'lg' }) {
  const sizes = { sm: 'h-4 w-4', md: 'h-5 w-5', lg: 'h-6 w-6' };
  return (
    <svg className={cn('animate-spin', sizes[size], className)} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v1a7 7 0 00-7 7H4z" />
    </svg>
  );
}

export function SpinnerScreen({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center py-12 text-gray-500 text-sm">
      <Spinner className="mr-2" />
      {label}
    </div>
  );
}

export function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn('text-sm font-semibold text-gray-900', className)}>{children}</h2>;
}