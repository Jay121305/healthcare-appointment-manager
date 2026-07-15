// lib/types.ts
// Typed API contract for the M7 frontend. All backend endpoint request/response
// shapes are declared here. The api client (lib/api.ts) imports these types.

// ─────────────────────────────────────────────────────────────────────────────
// Shared
// ─────────────────────────────────────────────────────────────────────────────

export type Role = 'PATIENT' | 'DOCTOR' | 'ADMIN';

export interface ApiErrorResponse {
  error: string;
  message?: string;
  code?: string;
  retryAfterSeconds?: number;
  retryable?: boolean;
  fields?: Record<string, string>;
  bookingIds?: string[];
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

export interface PatientProfile {
  id: string;
  userId: string;
  fullName: string;
  dateOfBirth: string | null;
  gender: 'MALE' | 'FEMALE' | 'OTHER' | null;
  phone: string | null;
  address: string | null;
  bloodGroup: string | null;
}

export interface DoctorProfile {
  id: string;
  userId: string;
  fullName: string;
  specialisation: string;
  workingHours: WorkingHours;
  slotDurationMinutes: number;
  phone: string | null;
  isActive: boolean;
}

export interface WorkingHours {
  mon?: WorkingHoursEntry | null;
  tue?: WorkingHoursEntry | null;
  wed?: WorkingHoursEntry | null;
  thu?: WorkingHoursEntry | null;
  fri?: WorkingHoursEntry | null;
  sat?: WorkingHoursEntry | null;
  sun?: WorkingHoursEntry | null;
}

export interface WorkingHoursEntry {
  start: string; // "HH:mm"
  end: string; // "HH:mm"
}

export interface UserProfile {
  id: string;
  email: string;
  role: Role;
  profile: PatientProfile | DoctorProfile | null;
}

export interface AuthLoginResponse {
  message: string;
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    role: Role;
    profile: PatientProfile | DoctorProfile | null;
  };
}

export interface AuthSignupPatientInput {
  email: string;
  password: string;
  fullName: string;
  dateOfBirth?: string | null;
  gender?: 'MALE' | 'FEMALE' | 'OTHER' | null;
  phone?: string | null;
  address?: string | null;
  bloodGroup?: string | null;
}

export interface AuthRefreshResponse {
  accessToken: string;
  refreshToken: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Doctor (admin-facing + patient-facing)
// ─────────────────────────────────────────────────────────────────────────────

export interface DoctorPublicDTO {
  id: string;
  fullName: string;
  specialisation: string;
  slotDurationMinutes: number;
  nextAvailableDate?: string | null;
  isActive: boolean;
}

export interface DoctorWithUser {
  id: string;
  userId: string;
  fullName: string;
  email: string;
  specialisation: string;
  workingHours: WorkingHours;
  slotDurationMinutes: number;
  phone: string | null;
  isActive: boolean;
  leaveDays?: { leaveDate: string; reason: string | null }[];
}

export interface CreateDoctorInput {
  email: string;
  password: string;
  fullName: string;
  specialisation: string;
  workingHours: WorkingHours;
  slotDurationMinutes?: number;
  phone?: string | null;
}

export interface UpdateDoctorInput {
  fullName?: string;
  specialisation?: string;
  workingHours?: WorkingHours;
  slotDurationMinutes?: number;
  phone?: string | null;
  isActive?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Slots & bookings
// ─────────────────────────────────────────────────────────────────────────────

export interface SlotInfo {
  startUTC: string;
  endUTC: string;
  startTimeLocal: string;
  available: boolean;
}

export interface SlotAvailabilityResponse {
  slots: SlotInfo[];
  reason: string;
}

export interface PlaceHoldInput {
  doctorId: string;
  date: string; // YYYY-MM-DD
  startTime: string; // ISO (the SlotInfo.startUTC value)
  ttlSeconds?: number;
}

export interface PlaceHoldResult {
  holdToken: string;
  expiresAt: string;
  doctorId: string;
  date: string;
  startTime: string;
  ttlSeconds: number;
}

export interface SymptomFormInput {
  primaryComplaint: string;
  durationDays?: number | null;
  severity?: 'MILD' | 'MODERATE' | 'SEVERE' | null;
  description?: string | null;
  currentMedications?: string[] | null;
  allergies?: string[] | null;
}

export interface SymptomFormResponse {
  id?: string;
  primaryComplaint: string;
  durationDays: number | null;
  severity: string | null;
  description: string | null;
  currentMedications: string[];
  allergies: string[];
  submittedAt?: string;
}

export interface AttachSymptomFormResponse {
  holdToken: string;
  formSubmitted: boolean;
  expiresAt: string;
}

export type BookingStatus = 'CONFIRMED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW' | 'RESCHEDULED';

export interface BookingResponse {
  id: string;
  patientId: string;
  doctorId: string;
  bookingDate: string;
  startTime: string;
  status: BookingStatus;
  bookedAt: string;
  updatedAt: string;
  symptomForm?: SymptomFormResponse | null;
  doctor?: DoctorPublicDTO | null;
  patient?: { id: string; fullName: string } | null;
  postVisitSummary?: PostVisitSummaryResponse | null;
  preVisitSummary?: PreVisitSummaryResponse | null;
}

export interface CancelBookingResult {
  booking: BookingResponse;
  message: string;
}

export interface RescheduleBookingResult {
  oldBooking: BookingResponse;
  newBooking: BookingResponse;
  message: string;
}

export type BookingsListResponse = PaginatedResponse<BookingResponse>;

export interface RescheduleInput {
  newHoldToken: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Visits (notes + summaries)
// ─────────────────────────────────────────────────────────────────────────────

export type LlmStatus = 'PENDING' | 'GENERATED' | 'RETRYING' | 'FALLBACK' | 'FAILED';
export type UrgencyLevel = 'Low' | 'Medium' | 'High';

export interface SubmitNotesInput {
  notes: string;
  // The backend /visits/:bookingId/notes route accepts only `notes` (string).
  // Prescription rows are stored via M5 worker-side expansion. The frontend
  // includes prescription form fields but submits them inside a `prescriptions`
  // array — flagged as a documented assumption (see A9(M7)).
  prescriptions?: PrescriptionInput[];
}

export interface PrescriptionInput {
  medicationName: string;
  dosage: string;
  frequency: string;
  frequencyCustom?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  instructions?: string | null;
}

export interface SubmitNotesResult {
  message: string;
  postVisitSummary: {
    id: string;
    bookingId: string;
    llmStatus: LlmStatus;
  };
}

export interface PreVisitSummaryResponse {
  bookingId: string;
  summaryText: string;
  llmStatus: LlmStatus;
  urgencyLevel?: UrgencyLevel | null;
  chiefComplaint?: string | null;
  suggestedQuestions?: string[];
  retryCount: number;
  generatedAt: string | null;
}

export interface PostVisitSummaryResponse {
  bookingId: string;
  summaryText: string;
  llmStatus: LlmStatus;
  retryCount: number;
  generatedAt: string | null;
  doctorNotes?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat / Follow-up Q&A
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

export interface GetChatMessagesResponse {
  bookingId: string;
  messages: ChatMessage[];
  followUpCount: number;
  remainingQuestions: number;
  maxQuestions: number;
}

export interface PostChatMessageResponse {
  answer: string;
  status: LlmStatus;
  remainingQuestions: number;
  maxQuestions: number;
}

export interface RegenerateSummaryResponse {
  message: string;
  bookingId: string;
  llmStatus: LlmStatus;
  maxQuestions?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Calendar
// ─────────────────────────────────────────────────────────────────────────────

export interface CalendarStatusResponse {
  connected: boolean;
  connectedAt: string | null;
  googleEmail: string | null;
}

export interface CalendarConnectResponse {
  redirectUrl: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin leave
// ─────────────────────────────────────────────────────────────────────────────

export interface LeaveConflict {
  bookingId: string;
  patientId: string;
  patientName: string;
  patientEmail: string;
  startTime: string;
  bookingDate: string;
}

export interface ConflictByDate {
  leaveDate: string;
  bookings: LeaveConflict[];
}

export interface MarkLeaveInput {
  rangeStart: string; // YYYY-MM-DD
  rangeEnd: string; // YYYY-MM-DD
  reason?: string | null;
  dryRun?: boolean;
  conflictResolution?: 'PREVIEW' | 'AUTO_CANCEL';
  autoCancel?: boolean;
}

export interface MarkLeaveResult {
  status: 'CONFLICT_DETECTED' | 'NO_CONFLICT';
  conflictDates: ConflictByDate[];
  affectedPatientCount: number;
  leaveRowsCreated: number;
  autoCancelledBookings: { bookingId: string; patientId: string }[];
  notificationsQueued: number;
}

export interface LeaveDaysResponse {
  leaveDays: { leaveDate: string; reason: string | null }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat (follow-up Q&A on post-visit summary)
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

export interface ChatMessagesResponse {
  bookingId: string;
  messages: ChatMessage[];
  followUpCount: number;
  remainingQuestions: number;
  maxQuestions: number;
}

export interface ChatMessageRequest {
  question: string;
}

export interface ChatMessageResponse {
  answer: string;
  llmStatus: LlmStatus;
  remainingQuestions: number;
  maxQuestions: number;
}

export interface RegenerateSummaryResponse {
  message: string;
  bookingId: string;
  llmStatus: LlmStatus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Toasts (UI)
// ─────────────────────────────────────────────────────────────────────────────

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastMessage {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
}
