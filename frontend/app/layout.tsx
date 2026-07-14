// app/layout.tsx
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'Healthcare Appointment Manager',
  description: 'Patient, Doctor & Admin portals for appointment management',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} font-sans antialiased`}>
      <body className="bg-gray-50 min-h-screen text-gray-900">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}