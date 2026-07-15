// frontend/middleware.ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export const runtime = 'nodejs'

export function middleware(request: NextRequest) {
  return NextResponse.next()
}