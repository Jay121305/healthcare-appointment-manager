// app/(public)/layout.tsx — minimal shell for unauthenticated pages.

import type { ReactNode } from 'react';

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <a href="/" className="font-semibold text-gray-900">
            Healthcare Appointment Manager
          </a>
          <nav className="flex items-center gap-3 text-sm">
            <a href="/login" className="text-gray-700 hover:text-gray-900">Login</a>
            <a href="/signup/patient" className="text-primary-700 hover:text-primary-900">Sign up</a>
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
