// lib/api.ts
// Single typed fetch wrapper for every backend endpoint M7 needs.
// All page/component API calls go through this file — no inline fetch()
// in components.
//
// Token storage strategy (assumption A1(M7)):
//   - access token  (15-min HS256)  -> in-memory module variable
//   - refresh token (7-day rotating) -> localStorage key "rt"
//   - role cookie -> set on login so Edge middleware can read it for
//     fast UX-layer redirects. NOT a security token; server re-verifies
//     the JWT on every API call (Rule 1).
//
// On 401: attempt one POST /auth/refresh using the stored refresh token,
// persist the rotated token, retry the original request once. On any
// second 401 (or if no refresh token is available), clear auth and
// redirect to /login.

import type {
  ApiErrorResponse,
  AuthLoginResponse,
  AuthRefreshResponse,
  AuthSignupPatientInput,
  BookingResponse,
  BookingsListResponse,
  CalendarConnectResponse,
  CalendarStatusResponse,
  CancelBookingResult,
  CreateDoctorInput,
  DoctorPublicDTO,
  DoctorWithUser,
  LeaveDaysResponse,
  MarkLeaveInput,
  MarkLeaveResult,
  PaginatedResponse,
  PlaceHoldInput,
  PlaceHoldResult,
  PreVisitSummaryResponse,
  PostVisitSummaryResponse,
  RescheduleBookingResult,
  RescheduleInput,
  SlotAvailabilityResponse,
  SubmitNotesInput,
  SubmitNotesResult,
  SymptomFormInput,
  AttachSymptomFormResponse,
  UpdateDoctorInput,
  UserProfile,
} from './types';

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

const ACCESS_TOKEN_KEY = '__access_token__';
const REFRESH_TOKEN_KEY = 'rt';
const ROLE_COOKIE = 'role';

// ─── in-memory access token (SSR-safe) ────────────────────────────────────
let accessTokenInMemory: string | null = null;

function writeAccessToken(token: string | null): void {
  accessTokenInMemory = token;
  if (typeof window !== 'undefined') {
    if (token) {
      (window as unknown as Record<string, unknown>)[ACCESS_TOKEN_KEY] = token;
    } else {
      delete (window as unknown as Record<string, unknown>)[ACCESS_TOKEN_KEY];
    }
  }
}

function readAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  if (accessTokenInMemory) return accessTokenInMemory;
  const w = window as unknown as Record<string, unknown>;
  const token = w[ACCESS_TOKEN_KEY];
  if (typeof token === 'string') {
    accessTokenInMemory = token;
    return token;
  }
  return null;
}

// ─── localStorage refresh token ────────────────────────────────────────────
function readRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeRefreshToken(token: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(REFRESH_TOKEN_KEY, token);
  } catch {
    // ignore quota / privacy mode errors
  }
}

function clearRefreshToken(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    // ignore
  }
}

// ─── role cookie helpers (for Edge middleware) ────────────────────────────
function setRoleCookie(role: 'PATIENT' | 'DOCTOR' | 'ADMIN'): void {
  if (typeof document === 'undefined') return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${ROLE_COOKIE}=${role}; path=/; max-age=604800; SameSite=Lax${secure}`;
}

function clearRoleCookie(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${ROLE_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
}

// ─── ApiError ─────────────────────────────────────────────────────────────
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly raw: ApiErrorResponse;

  constructor(status: number, code: string, message: string, raw: ApiErrorResponse) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.raw = raw;
  }
}

// ─── redirect to /login (client-side) ──────────────────────────────────────
function redirectLogin(): void {
  if (typeof window !== 'undefined') {
    clearAuthTokens();
    window.location.assign('/login');
  }
}

// ─── auth token bookkeeping (exported for AuthContext) ─────────────────────
export function getAccessToken(): string | null {
  return readAccessToken();
}

export function setAuthTokens(accessToken: string, refreshToken: string, role: 'PATIENT' | 'DOCTOR' | 'ADMIN'): void {
  writeAccessToken(accessToken);
  writeRefreshToken(refreshToken);
  setRoleCookie(role);
}

export function clearAuthTokens(): void {
  writeAccessToken(null);
  clearRefreshToken();
  clearRoleCookie();
}

// ─── URL builder ───────────────────────────────────────────────────────────
type QueryParams = Record<string, string | number | boolean | undefined | null | string[]>;

function buildUrl(path: string, params?: QueryParams): string {
  const url = new URL(`${API_BASE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        value.forEach((v) => url.searchParams.append(key, String(v)));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

async function parseError(res: Response): Promise<ApiErrorResponse> {
  try {
    const data = (await res.json()) as ApiErrorResponse;
    if (data && typeof data === 'object' && typeof data.error === 'string') return data;
    return { error: 'INTERNAL_ERROR', message: `HTTP ${res.status}` };
  } catch {
    return { error: 'INTERNAL_ERROR', message: `HTTP ${res.status}` };
  }
}

// ─── refresh once, then retry ──────────────────────────────────────────────
let refreshInFlight: Promise<boolean> | null = null;

async function refreshOnce(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const refreshToken = readRefreshToken();
    if (!refreshToken) return false;
    try {
      const res = await fetch(buildUrl('/auth/refresh'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
        cache: 'no-store',
      });
      if (!res.ok) return false;
      const data = (await res.json()) as AuthRefreshResponse;
      if (!data.accessToken || !data.refreshToken) return false;
      writeAccessToken(data.accessToken);
      writeRefreshToken(data.refreshToken);
      return true;
    } catch {
      return false;
    }
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

// ─── fetch helper ──────────────────────────────────────────────────────────
async function fetchJson<T>(
  path: string,
  init: RequestInit & { params?: QueryParams } = {},
): Promise<T> {
  const { params, ...rest } = init;
  const url = buildUrl(path, params);

  const buildHeaders = (token: string | null): HeadersInit => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  };

  let res = await fetch(url, {
    ...rest,
    headers: { ...buildHeaders(readAccessToken()), ...(rest.headers as Record<string, string> | undefined) },
    cache: 'no-store',
  });

  // 401 → refresh once → retry once
  if (res.status === 401) {
    const refreshed = await refreshOnce();
    if (refreshed) {
      res = await fetch(url, {
        ...rest,
        headers: { ...buildHeaders(readAccessToken()), ...(rest.headers as Record<string, string> | undefined) },
        cache: 'no-store',
      });
    }
    if (res.status === 401) {
      redirectLogin();
      const err = await parseError(res);
      throw new ApiError(401, err.error ?? 'UNAUTHENTICATED', err.message ?? 'Session expired', err);
    }
  }

  if (!res.ok) {
    const err = await parseError(res);
    throw new ApiError(res.status, err.error ?? 'API_ERROR', err.message ?? 'Request failed', err);
  }

  if (res.status === 204) return undefined as T;

  // Some endpoints return plain text or empty body — guard the JSON parse.
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

// ─── typed wrappers ────────────────────────────────────────────────────────
export const api = {
  // Auth
  signupPatient: (input: AuthSignupPatientInput) =>
    fetchJson<AuthLoginResponse>('/auth/signup/patient', { method: 'POST', body: JSON.stringify(input) }),
  login: (email: string, password: string) =>
    fetchJson<AuthLoginResponse>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  refresh: (refreshToken: string) =>
    fetchJson<AuthRefreshResponse>('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken }) }),
  logout: () =>
    fetchJson<{ message: string }>('/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: readRefreshToken() ?? '' }),
    }),
  me: () => fetchJson<UserProfile>('/auth/me'),

  // Booking slots + holds
  getSlots: (doctorId: string, date: string) =>
    fetchJson<SlotAvailabilityResponse>('/bookings/slots', { method: 'GET', params: { doctorId, date } }),
  placeHold: (input: PlaceHoldInput) =>
    fetchJson<PlaceHoldResult>('/bookings/holds', { method: 'POST', body: JSON.stringify(input) }),
  attachSymptomForm: (holdToken: string, form: SymptomFormInput) =>
    fetchJson<AttachSymptomFormResponse>(`/bookings/${encodeURIComponent(holdToken)}/symptom-form`, {
      method: 'POST',
      body: JSON.stringify(form),
    }),
  confirmBooking: (holdToken: string) =>
    fetchJson<BookingResponse>(`/bookings/${encodeURIComponent(holdToken)}/confirm`, { method: 'POST', body: '{}' }),
  cancelBooking: (bookingId: string, reason?: string) =>
    fetchJson<CancelBookingResult>(`/bookings/${encodeURIComponent(bookingId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  rescheduleBooking: (bookingId: string, input: RescheduleInput) =>
    fetchJson<RescheduleBookingResult>(`/bookings/${encodeURIComponent(bookingId)}/reschedule`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // Bookings list / detail (see A2(M7): these endpoints are referenced by
  // the M7 task spec; the backend at the time of writing did not expose GET
  // /bookings or GET /bookings/:id. We call the spec endpoint names here
  // per Rule 9. If the backend returns 404, the page shows the appropriate
  // failure state — no invented routes on the client.)
  listBookings: (params?: QueryParams) =>
    fetchJson<BookingsListResponse>('/bookings', { method: 'GET', params }),
  getBooking: (bookingId: string) =>
    fetchJson<BookingResponse>(`/bookings/${encodeURIComponent(bookingId)}`, { method: 'GET' }),
  // G3 (see M7_FRONTEND_SPEC.md §0): today's appointments for the calling doctor.
  // Endpoint exposed by the M7 backend-companion PR; additive, role-gated.
  doctorTodayAppointments: () =>
    fetchJson<BookingsListResponse>('/bookings/today', { method: 'GET' }),

  // Doctor search (see A2(M7): GET /doctors and GET /doctors/:id are
  // referenced by the M7 task spec for patient-facing doctor search.)
  listDoctors: (params?: QueryParams) =>
    fetchJson<PaginatedResponse<DoctorPublicDTO>>('/doctors', { method: 'GET', params }),
  getDoctor: (doctorId: string) =>
    fetchJson<DoctorPublicDTO>(`/doctors/${encodeURIComponent(doctorId)}`, { method: 'GET' }),

  // Visits
  submitNotes: (bookingId: string, input: SubmitNotesInput) =>
    fetchJson<SubmitNotesResult>(`/visits/${encodeURIComponent(bookingId)}/notes`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  getPreVisitSummary: (bookingId: string) =>
    fetchJson<PreVisitSummaryResponse>(`/visits/${encodeURIComponent(bookingId)}/pre-summary`, { method: 'GET' }),
  getPostVisitSummary: (bookingId: string) =>
    fetchJson<PostVisitSummaryResponse>(`/visits/${encodeURIComponent(bookingId)}/post-summary`, { method: 'GET' }),

  // Calendar
  calendarConnect: () => fetchJson<CalendarConnectResponse>('/calendar/connect', { method: 'GET' }),
  calendarDisconnect: () =>
    fetchJson<{ message: string }>('/calendar/disconnect', { method: 'POST', body: '{}' }),
  calendarStatus: () => fetchJson<CalendarStatusResponse>('/calendar/status', { method: 'GET' }),

  // Admin: doctors
  adminListDoctors: (params?: QueryParams) =>
    fetchJson<PaginatedResponse<DoctorWithUser>>('/admin/doctors', { method: 'GET', params }),
  adminGetDoctor: (doctorId: string) =>
    fetchJson<DoctorWithUser>(`/admin/doctors/${encodeURIComponent(doctorId)}`, { method: 'GET' }),
  adminCreateDoctor: (input: CreateDoctorInput) =>
    fetchJson<DoctorWithUser>('/admin/doctors', { method: 'POST', body: JSON.stringify(input) }),
  adminUpdateDoctor: (doctorId: string, input: UpdateDoctorInput) =>
    fetchJson<DoctorWithUser>(`/admin/doctors/${encodeURIComponent(doctorId)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  adminDeleteDoctor: (doctorId: string) =>
    fetchJson<void>(`/admin/doctors/${encodeURIComponent(doctorId)}`, { method: 'DELETE' }),
  adminGetDoctorSlots: (doctorId: string, date: string) =>
    fetchJson<SlotAvailabilityResponse>(`/admin/doctors/${encodeURIComponent(doctorId)}/slots`, {
      method: 'GET',
      params: { date },
    }),
  adminGetLeaveDays: (doctorId: string) =>
    fetchJson<LeaveDaysResponse>(`/admin/doctors/${encodeURIComponent(doctorId)}/leave`, { method: 'GET' }),
  adminDeleteLeaveDay: (doctorId: string, leaveId: string) =>
    fetchJson<void>(`/admin/doctors/${encodeURIComponent(doctorId)}/leave/${encodeURIComponent(leaveId)}`, {
      method: 'DELETE',
    }),
  adminMarkLeave: (doctorId: string, input: MarkLeaveInput) =>
    fetchJson<MarkLeaveResult>(`/admin/doctors/${encodeURIComponent(doctorId)}/leave`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};

export const apiConfig = { API_BASE_URL };
