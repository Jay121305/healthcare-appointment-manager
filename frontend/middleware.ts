// middleware.ts — Edge middleware for UX-layer role gating (Layer 1).
// Reads the non-httpOnly "role" cookie. If the route prefix doesn't match,
// redirects to the correct dashboard or to /login. The cookie is NOT a
// security token — server still verifies the JWT on every API call (Rule 1).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const roleRoutes: Record<string, string[]> = {
  PATIENT: ['/patient'],
  DOCTOR: ['/doctor'],
  ADMIN: ['/admin'],
};

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths: login, signup, static assets, api routes, root
  if (
    pathname === '/login' ||
    pathname.startsWith('/signup') ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next/') ||
    pathname.includes('.') ||
    pathname === '/'
  ) {
    return NextResponse.next();
  }

  const role = request.cookies.get('role')?.value as 'PATIENT' | 'DOCTOR' | 'ADMIN' | undefined;

  if (!role) {
    // No role hint — redirect to login with original path preserved
    const url = new URL('/login', request.url);
    url.searchParams.set('redirect', pathname);
    return NextResponse.redirect(url);
  }

  const allowedPrefixes = roleRoutes[role] ?? [];
  const hasAccess = allowedPrefixes.some((prefix) => pathname.startsWith(prefix));

  if (!hasAccess) {
    // Role doesn't match — bounce to the correct dashboard
    const dashboard = allowedPrefixes[0] ?? '/login';
    return NextResponse.redirect(new URL(dashboard, request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.png$).*)'],
};