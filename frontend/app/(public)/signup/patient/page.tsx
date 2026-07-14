// app/(public)/signup/patient/page.tsx — patient self-registration.

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/authContext';
import { useToast } from '@/components/ui/Toast';

const GENDER_OPTS = ['MALE', 'FEMALE', 'OTHER'] as const;

export default function PatientSignupPage() {
  const router = useRouter();
  const { setSession } = useAuth();
  const { addToast } = useToast();
  const [form, setForm] = useState({
    email: '',
    password: '',
    fullName: '',
    dateOfBirth: '',
    gender: '',
    phone: '',
    address: '',
    bloodGroup: '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.signupPatient({
        email: form.email.trim().toLowerCase(),
        password: form.password,
        fullName: form.fullName.trim(),
        dateOfBirth: form.dateOfBirth || null,
        gender: form.gender as 'MALE' | 'FEMALE' | 'OTHER' | null,
        phone: form.phone || null,
        address: form.address || null,
        bloodGroup: form.bloodGroup || null,
      });
      setSession(res.accessToken, res.refreshToken, res.user);
      addToast({ type: 'success', title: 'Account created', message: 'Welcome to your patient portal!' });
      router.push('/patient/dashboard');
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.raw?.message ?? 'Signup failed');
        addToast({ type: 'error', title: 'Signup failed', message: err.raw?.message });
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
      <h1 className="text-lg font-semibold text-gray-900">Create patient account</h1>
      <p className="mt-1 text-sm text-gray-600">Create your patient account to book appointments.</p>
      <form onSubmit={handleSubmit} className="mt-5 space-y-4">
        {error && <div className="text-sm text-red-600">{error}</div>}
        <Field label="Email" htmlFor="email">
          <Input id="email" name="email" type="email" autoComplete="email" value={form.email} onChange={handleChange} required disabled={loading} />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input id="password" name="password" type="password" autoComplete="new-password" value={form.password} onChange={handleChange} required minLength={8} disabled={loading} />
        </Field>
        <Field label="Full name" htmlFor="fullName">
          <Input id="fullName" name="fullName" value={form.fullName} onChange={handleChange} required disabled={loading} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date of birth" htmlFor="dateOfBirth">
            <Input id="dateOfBirth" name="dateOfBirth" type="date" value={form.dateOfBirth} onChange={handleChange} disabled={loading} />
          </Field>
          <Field label="Gender" htmlFor="gender">
            <Select id="gender" name="gender" value={form.gender} onChange={handleChange} disabled={loading}>
              <option value="">Select</option>
              {GENDER_OPTS.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Phone" htmlFor="phone">
          <Input id="phone" name="phone" type="tel" value={form.phone} onChange={handleChange} disabled={loading} />
        </Field>
        <Field label="Address" htmlFor="address">
          <Input id="address" name="address" value={form.address} onChange={handleChange} disabled={loading} />
        </Field>
        <Field label="Blood group (optional)" htmlFor="bloodGroup">
          <Input id="bloodGroup" name="bloodGroup" value={form.bloodGroup} onChange={handleChange} disabled={loading} />
        </Field>
        <Button type="submit" className="w-full" loading={loading}>
          Create account
        </Button>
      </form>
      <p className="mt-4 text-sm text-gray-600 text-center">
        Already have an account?{' '}
        <Link href="/login" className="text-primary-700 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}