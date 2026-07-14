// app/(admin)/layout.tsx — admin shell with top nav.

'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/authContext';
import { Button } from '@/components/ui/Button';
import { RoleGate } from '@/components/shared/RoleGate';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { logout, loading, user } = useAuth();

  return (
    <RoleGate allowed="ADMIN">
      <div className="min-h-screen flex flex-col">
        {!loading && user && (
          <header className="bg-white border-b sticky top-0 z-10">
            <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-6">
                <Link href="/admin/dashboard" className="font-semibold text-gray-900">
                  Healthcare Manager — Admin
                </Link>
                <nav className="flex items-center gap-4 text-sm">
                  <Link href="/admin/dashboard" className="text-gray-700 hover:text-gray-900">Doctors</Link>
                  <Link href="/admin/settings" className="text-gray-700 hover:text-gray-900">Settings</Link>
                </nav>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-600">Admin: {user.email}</span>
                <Button variant="ghost" size="sm" onClick={() => logout().then(() => router.push('/login'))}>
                  Logout
                </Button>
              </div>
            </div>
          </header>
        )}
        <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-6">{children}</main>
      </div>
    </RoleGate>
  );
}