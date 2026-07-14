// components/shared/RoleGate.tsx
'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/authContext';
import type { Role } from '@/lib/types';

/**
 * Client-side role gate — UX only (Rule 1).
 * If the current role doesn't match `allowed`, redirect to the correct dashboard.
 * If not authenticated, redirect to /login.
 * The actual API calls will still be rejected server-side by the backend.
 */
export function RoleGate({ allowed, children }: { allowed: Role | Role[]; children: React.ReactNode }) {
  const router = useRouter();
  const { role, loading, user } = useAuth();

  useEffect(() => {
    if (!loading) {
      if (!user) {
        router.replace('/login');
      } else {
        const allowedRoles = Array.isArray(allowed) ? allowed : [allowed];
        if (!allowedRoles.includes(role!)) {
          const target = allowedRoles[0] === 'PATIENT'
            ? '/patient/dashboard'
            : allowedRoles[0] === 'DOCTOR'
              ? '/doctor/dashboard'
              : '/admin/dashboard';
          router.replace(target);
        }
      }
    }
  }, [user, role, loading, allowed, router]);

  if (loading || !user) return null;

  const allowedRoles = Array.isArray(allowed) ? allowed : [allowed];
  if (!allowedRoles.includes(role!)) return null;

  return <>{children}</>;
}