// app/(public)/login/page.tsx — unified login, role determined by JWT response.

'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { useAuth } from '@/lib/authContext';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirect = searchParams.get('redirect');
  const { setSession } = useAuth();
  const { addToast } = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.login(email.trim().toLowerCase(), password);
      setSession(res.accessToken, res.refreshToken, res.user);
      addToast({ type: 'success', title: 'Welcome back', message: `Logged in as ${res.user.profile?.fullName ?? res.user.role}` });
      router.push(redirect ?? `/${res.user.role.toLowerCase()}/dashboard`);
    } catch (err) {
      if (err instanceof ApiError) {
        const msg = err.raw?.message ?? 'Invalid email or password';
        setError(msg);
        addToast({ type: 'error', title: 'Login failed', message: msg });
      } else {
        setError('Unexpected error');
        addToast({ type: 'error', title: 'Error', message: 'Unexpected error' });
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-md mx-auto px-4 py-8">
      <h1 className="text-lg font-semibold text-gray-900">Sign in</h1>
      <p className="mt-1 text-sm text-gray-600">
        Use one of the seed accounts or register a new patient.
      </p>
      <form onSubmit={handleSubmit} className="mt-5 space-y-4">
        <Field label="Email" htmlFor="email" error={error}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@healthcare.local"
            required
            disabled={loading}
          />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="AdminPass123!"
            required
            disabled={loading}
          />
        </Field>
        <Button type="submit" className="w-full" loading={loading}>
          Sign in
        </Button>
      </form>
      <div className="mt-4 text-sm text-gray-600">
        <Link href="/signup/patient" className="text-primary-700 hover:underline">
          Create a patient account
        </Link>
      </div>
    </div>
  );
}