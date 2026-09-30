// Attendance requests — the rules a request obeys, in one place.
//
// An employee tells BOE in advance (or as soon as they can) that they will be
// late, leave early, step out, take a half day or take leave. An admin approves
// or rejects it. That is all a request is: a RECORD of permission. Approval
// does not decide whether missed time is paid — that is the payroll review's
// job (./requestReconciliation.ts), and even there the only path that changes
// pay is the existing attendance-correction waiver.
//
// Kept free of Supabase and React so the API routes, the screens and the tests
// agree on what a valid request is without any of them owning the definition.

import { istClockToUtc, istAddDays, istDateRange, istDateOf } from '../istDate'

export const REQUEST_TYPES = [
  'late_arrival',
  'early_departure',
  'time_out',
  'half_day',
  'full_day_leave',
] as const
export type RequestType = (typeof REQUEST_TYPES)[number]

export const REQUEST_TYPE_LABEL: Record<RequestType, string> = {
  late_arrival:    'Late arrival',
  early_departure: 'Early departure',
  time_out:        'Time out during shift',
  half_day:        'Half day',
  full_day_leave:  'Full-day leave',
}

/**
 * A small, useful set — chosen in one tap on a phone. `other` needs a note.
 *
 * `company_vehicle` is its own code so a reviewer can find and excuse those
 * delays; it is never inferred from free text.
 */
export const REASON_CODES = [
  'company_vehicle',
  'company_work',
  'personal',
  'medical',
  'family_emergency',
  'traffic',
  'other',
] as const
export type ReasonCode = (typeof REASON_CODES)[number]

export const REASON_LABEL: Record<ReasonCode, string> = {
  company_vehicle:  'Company vehicle delay',
  company_work:     'Company work',
  personal:         'Personal reason',
  medical:          'Medical',
  family_emergency: 'Family emergency',
  traffic:          'Traffic / transport',
  other:            'Other',
}

export const REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const
export type RequestStatus = (typeof REQUEST_STATUSES)[number]

export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  pending:   'Pending',
  approved:  'Approved',
  rejected:  'Rejected',
  cancelled: 'Cancelled',
}

export type HalfSession = 'first_half' | 'second_half'
export type WorkKind = 'personal' | 'company'

export const NOTE_MAX_LENGTH = 500
/** Leave longer than this is a conversation, not a form. */
export const MAX_LEAVE_DAYS = 31
/** How far back a request may be filed — retroactive, but not archaeology. */
export const MAX_DAYS_BACK = 62
/** How far ahead a request may be filed. */
export const MAX_DAYS_AHEAD = 180

/** A request as the API and the screens carry it. Times are IST "HH:MM". */
export type AttendanceRequestRow = {
  id: string
  employee_id: string
  request_type: RequestType
  start_date: string
  end_date: string
  expected_arrival_time: string | null
  departure_time: string | null
  return_time: string | null
  half_session: HalfSession | null
  work_kind: WorkKind | null
  reason_code: ReasonCode
  reason_note: string | null
  submitted_at: string
  original_submitted_at: string
  shift_start_at: string
  informed_before_shift: boolean
  status: RequestStatus
  decided_by: string | null
  decided_at: string | null
  decision_note: string | null
  cancelled_at: string | null
  cancel_reason: string | null
  replaces_request_id: string | null
  updated_at: string
}

export const REQUEST_COLUMNS =
  'id, employee_id, request_type, start_date, end_date, expected_arrival_time, departure_time, ' +
  'return_time, half_session, work_kind, reason_code, reason_note, submitted_at, original_submitted_at, ' +
  'shift_start_at, informed_before_shift, status, decided_by, decided_at, decision_note, cancelled_at, ' +
  'cancel_reason, replaces_request_id, updated_at'

/** The validated, normalised content of a new request (or a correction). */
export type RequestInput = {
  request_type: RequestType
  start_date: string
  end_date: string
  expected_arrival_time: string | null
  departure_time: string | null
  return_time: string | null
  half_session: HalfSession | null
  work_kind: WorkKind | null
  reason_code: ReasonCode
  reason_note: string | null
}

/** The company working day, IST minutes past midnight (from payroll settings). */
export type ShiftWindow = { scheduled_in_minutes: number; scheduled_out_minutes: number }

// ─── Small parsers ───────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false
  const d = new Date(`${v}T00:00:00.000Z`)
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

/** "HH:MM" (or Postgres "HH:MM:SS") → minutes past midnight, or null. */
export function clockMinutes(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const m = v.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
  if (!m) return null
  const h = Number(m[1]); const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

/** Normalise to "HH:MM". */
export function toClock(v: string | null): string | null {
  const mins = clockMinutes(v)
  if (mins == null) return null
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
}

function includes<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v)
}

// ─── Validation ──────────────────────────────────────────────────────────────

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Validate a request body. `today` is the IST business date, supplied by the
 * caller so the rule is testable and the server's clock is the one that counts.
 */
export function validateRequestInput(
  body: Record<string, unknown>,
  today: string,
  shift: ShiftWindow,
): Validation<RequestInput> {
  const type = body.request_type
  if (!includes(REQUEST_TYPES, type)) return { ok: false, error: 'Choose what kind of request this is.' }

  const start = body.start_date
  if (!isIsoDate(start)) return { ok: false, error: 'Choose a valid date.' }
  let end = start
  if (type === 'full_day_leave' && body.end_date != null && body.end_date !== '') {
    if (!isIsoDate(body.end_date)) return { ok: false, error: 'Choose a valid end date.' }
    end = body.end_date
  }
  if (end < start) return { ok: false, error: 'The end date cannot be before the start date.' }
  if (istDateRange(start, end).length > MAX_LEAVE_DAYS)
    return { ok: false, error: `Leave longer than ${MAX_LEAVE_DAYS} days needs to be discussed directly.` }
  if (start < istAddDays(today, -MAX_DAYS_BACK))
    return { ok: false, error: `Requests can be filed up to ${MAX_DAYS_BACK} days after the date.` }
  if (start > istAddDays(today, MAX_DAYS_AHEAD))
    return { ok: false, error: `Requests can be filed up to ${MAX_DAYS_AHEAD} days ahead.` }

  const reason = body.reason_code
  if (!includes(REASON_CODES, reason)) return { ok: false, error: 'Choose a reason.' }
  const note = typeof body.reason_note === 'string' ? body.reason_note.trim() : ''
  if (note.length > NOTE_MAX_LENGTH) return { ok: false, error: `Keep the note under ${NOTE_MAX_LENGTH} characters.` }
  if (reason === 'other' && !note) return { ok: false, error: 'Add a short note for "Other".' }

  const value: RequestInput = {
    request_type: type,
    start_date: start,
    end_date: end,
    expected_arrival_time: null,
    departure_time: null,
    return_time: null,
    half_session: null,
    work_kind: null,
    reason_code: reason,
    reason_note: note || null,
  }

  const inShift = (m: number) => m > shift.scheduled_in_minutes && m < shift.scheduled_out_minutes

  switch (type) {
    case 'late_arrival': {
      const raw = body.expected_arrival_time
      if (raw != null && raw !== '') {
        const m = clockMinutes(raw)
        if (m == null) return { ok: false, error: 'Enter the expected arrival time as HH:MM.' }
        if (!inShift(m)) return { ok: false, error: 'The expected arrival time must be during the working day.' }
        value.expected_arrival_time = toClock(raw as string)
      }
      break
    }
    case 'early_departure': {
      const m = clockMinutes(body.departure_time)
      if (m == null) return { ok: false, error: 'Enter the time you will leave.' }
      if (!inShift(m)) return { ok: false, error: 'The departure time must be during the working day.' }
      value.departure_time = toClock(body.departure_time as string)
      break
    }
    case 'time_out': {
      const out = clockMinutes(body.departure_time)
      const back = clockMinutes(body.return_time)
      if (out == null || back == null) return { ok: false, error: 'Enter the time you will leave and return.' }
      if (back <= out) return { ok: false, error: 'The return time must be after the departure time.' }
      if (out < shift.scheduled_in_minutes || back > shift.scheduled_out_minutes)
        return { ok: false, error: 'Time out must be within the working day.' }
      if (!includes(['personal', 'company'] as const, body.work_kind))
        return { ok: false, error: 'Say whether this is personal or company work.' }
      value.departure_time = toClock(body.departure_time as string)
      value.return_time = toClock(body.return_time as string)
      value.work_kind = body.work_kind
      break
    }
    case 'half_day': {
      if (!includes(['first_half', 'second_half'] as const, body.half_session))
        return { ok: false, error: 'Choose first half or second half.' }
      value.half_session = body.half_session
      break
    }
    case 'full_day_leave':
      break
  }
  return { ok: true, value }
}

// ─── Informed on time ────────────────────────────────────────────────────────

/** The UTC instant the scheduled shift starts on an IST date. */
export function shiftStartUtc(date: string, shift: Pick<ShiftWindow, 'scheduled_in_minutes'>): string {
  const h = Math.floor(shift.scheduled_in_minutes / 60)
  const m = shift.scheduled_in_minutes % 60
  return istClockToUtc(date, `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)!
}

/**
 * Informed on time = submitted strictly before the scheduled shift start of the
 * request's first date. Both sides are instants, so there is no time-zone
 * arithmetic to get wrong: the shift start is 10:00 IST on that date, and the
 * submission time is the server's clock.
 */
export function isInformedBeforeShift(submittedAt: string, shiftStartAt: string): boolean {
  return Date.parse(submittedAt) < Date.parse(shiftStartAt)
}

/**
 * For a correction: the chain's first submission still counts when the date is
 * unchanged — fixing a typo in an on-time request must not make it late. Moving
 * the request to a different date is a new notice and is judged afresh.
 */
export function informedForCorrection(
  original: Pick<AttendanceRequestRow, 'start_date' | 'original_submitted_at'>,
  next: Pick<RequestInput, 'start_date'>,
  now: string,
  shift: Pick<ShiftWindow, 'scheduled_in_minutes'>,
): boolean {
  const shiftStart = shiftStartUtc(next.start_date, shift)
  const basis = original.start_date === next.start_date ? original.original_submitted_at : now
  return isInformedBeforeShift(basis, shiftStart)
}

/**
 * How a request's timing should be described to a reviewer.
 *
 *   before_shift   sent before the shift began on its first date
 *   after_shift    sent on the day, after the shift had begun
 *   after_date     sent on a LATER IST date than the request's first date — an
 *                  after-the-event (retrospective) submission
 *
 * Purely descriptive: it records what happened and decides nothing about pay.
 * Retrospective requests remain allowed within MAX_DAYS_BACK, as before.
 */
export type SubmissionTiming = 'before_shift' | 'after_shift' | 'after_date'

export function submissionTiming(
  r: Pick<AttendanceRequestRow, 'submitted_at' | 'start_date' | 'informed_before_shift'>,
): SubmissionTiming {
  if (istDateOf(r.submitted_at) > r.start_date) return 'after_date'
  return r.informed_before_shift ? 'before_shift' : 'after_shift'
}

export const SUBMISSION_TIMING_LABEL: Record<SubmissionTiming, string> = {
  before_shift: 'Sent before shift start',
  after_shift:  'Sent after shift start',
  after_date:   'Sent after the date (after the event)',
}

// ─── Duplicates and overlaps ─────────────────────────────────────────────────

/** Only a live request can conflict with a new one. */
export function isActiveStatus(status: RequestStatus): boolean {
  return status === 'pending' || status === 'approved'
}

function datesOverlap(a: { start_date: string; end_date: string }, b: { start_date: string; end_date: string }) {
  return a.start_date <= b.end_date && b.start_date <= a.end_date
}

/**
 * The live request a new one would duplicate or contradict, or null.
 *
 *   - Leave overlaps with anything on the same dates.
 *   - One half day per date (two halves is a leave).
 *   - One late-arrival and one early-departure request per date.
 *   - Time-out requests on the same date may coexist only if their times do
 *     not overlap.
 *
 * A late arrival and an early departure on the same day are legitimate
 * together. `ignoreId` is the request being corrected, which is replaced rather
 * than duplicated.
 */
export function findConflict(
  candidate: RequestInput,
  existing: Pick<AttendanceRequestRow, 'id' | 'request_type' | 'start_date' | 'end_date' | 'departure_time' | 'return_time' | 'status'>[],
  ignoreId: string | null = null,
): (typeof existing)[number] | null {
  for (const r of existing) {
    if (r.id === ignoreId || !isActiveStatus(r.status)) continue
    if (!datesOverlap(candidate, r)) continue
    if (candidate.request_type === 'full_day_leave' || r.request_type === 'full_day_leave') return r
    if (candidate.request_type !== r.request_type) continue
    if (candidate.request_type !== 'time_out') return r
    const a0 = clockMinutes(candidate.departure_time)!, a1 = clockMinutes(candidate.return_time)!
    const b0 = clockMinutes(r.departure_time), b1 = clockMinutes(r.return_time)
    if (b0 == null || b1 == null || (a0 < b1 && b0 < a1)) return r
  }
  return null
}

/**
 * A repeat of a request the employee sent moments ago — a double tap, or a
 * retry after the answer was lost on a bad connection. It is answered with the
 * request that already exists rather than refused or saved twice.
 */
export const RETRY_WINDOW_MS = 10 * 60 * 1000
const CLOCK_SKEW_MS = 60 * 1000

const norm = (v: string | null | undefined) => (v == null || v === '' ? null : v)

export function isSameSubmission(
  candidate: RequestInput,
  existing: Pick<AttendanceRequestRow,
    'request_type' | 'start_date' | 'end_date' | 'expected_arrival_time' | 'departure_time' | 'return_time' |
    'half_session' | 'work_kind' | 'reason_code' | 'reason_note'>,
): boolean {
  return candidate.request_type === existing.request_type &&
    candidate.start_date === existing.start_date &&
    candidate.end_date === existing.end_date &&
    norm(toClock(candidate.expected_arrival_time)) === norm(toClock(existing.expected_arrival_time)) &&
    norm(toClock(candidate.departure_time)) === norm(toClock(existing.departure_time)) &&
    norm(toClock(candidate.return_time)) === norm(toClock(existing.return_time)) &&
    norm(candidate.half_session) === norm(existing.half_session) &&
    norm(candidate.work_kind) === norm(existing.work_kind) &&
    candidate.reason_code === existing.reason_code &&
    norm(candidate.reason_note?.trim()) === norm(existing.reason_note?.trim())
}

/** True when `existing` is a still-pending, identical, just-sent copy of `candidate`. */
export function isRecentTwin(
  candidate: RequestInput,
  existing: Pick<AttendanceRequestRow,
    'status' | 'submitted_at' | 'request_type' | 'start_date' | 'end_date' | 'expected_arrival_time' |
    'departure_time' | 'return_time' | 'half_session' | 'work_kind' | 'reason_code' | 'reason_note'>,
  now: string,
): boolean {
  // The stored time is the database's clock at insert; `now` is the handler's,
  // read a moment earlier. A double tap can therefore look slightly "negative".
  const age = Date.parse(now) - Date.parse(existing.submitted_at)
  return existing.status === 'pending' && age >= -CLOCK_SKEW_MS && age <= RETRY_WINDOW_MS && isSameSubmission(candidate, existing)
}

export function conflictMessage(r: Pick<AttendanceRequestRow, 'request_type' | 'start_date' | 'status'>): string {
  return `You already have a ${REQUEST_STATUS_LABEL[r.status].toLowerCase()} ` +
    `${REQUEST_TYPE_LABEL[r.request_type].toLowerCase()} request for ${r.start_date}. ` +
    'Correct or cancel that one instead.'
}

// ─── What the employee may still do ──────────────────────────────────────────

/**
 * Cancel: a pending request any time; an approved one only before its shift
 * starts. After that the day has happened, and withdrawing an approval would
 * rewrite what the reviewer relied on — the employee asks the admin instead.
 */
export function canEmployeeCancel(r: Pick<AttendanceRequestRow, 'status' | 'shift_start_at'>, now: string): boolean {
  if (r.status === 'pending') return true
  if (r.status === 'approved') return Date.parse(now) < Date.parse(r.shift_start_at)
  return false
}

/** Correct (submit a replacement): same window as cancelling. */
export function canEmployeeCorrect(r: Pick<AttendanceRequestRow, 'status' | 'shift_start_at'>, now: string): boolean {
  return canEmployeeCancel(r, now)
}

// ─── Admin decision ──────────────────────────────────────────────────────────

export type DecisionInput = { status: 'approved' | 'rejected'; note: string | null }

/**
 * Approve needs no note; reject does; revising an existing decision does.
 * `current` is the request's status as stored.
 */
export function validateDecision(body: Record<string, unknown>, current: RequestStatus): Validation<DecisionInput> {
  const status = body.status
  if (status !== 'approved' && status !== 'rejected') return { ok: false, error: 'status must be approved or rejected' }
  const note = typeof body.note === 'string' ? body.note.trim() : ''
  if (note.length > NOTE_MAX_LENGTH) return { ok: false, error: `Keep the note under ${NOTE_MAX_LENGTH} characters.` }
  if (current === 'cancelled') return { ok: false, error: 'This request was cancelled.' }
  if (current === status) return { ok: false, error: `This request is already ${status}.` }
  if (status === 'rejected' && !note) return { ok: false, error: 'Give a short reason for the rejection.' }
  if (current !== 'pending' && !note) return { ok: false, error: 'Give a reason for changing the decision.' }
  return { ok: true, value: { status, note: note || null } }
}

// ─── Display ─────────────────────────────────────────────────────────────────

/** "Late arrival · 12 Oct · expected 10:45" — one line for lists. */
export function requestSummary(r: Pick<AttendanceRequestRow,
  'request_type' | 'start_date' | 'end_date' | 'expected_arrival_time' | 'departure_time' | 'return_time' | 'half_session' | 'work_kind'>): string {
  const d = r.start_date === r.end_date ? r.start_date : `${r.start_date} to ${r.end_date}`
  const t = (v: string | null) => toClock(v) ?? '—'
  switch (r.request_type) {
    case 'late_arrival':    return `${d}${r.expected_arrival_time ? ` · arriving ~${t(r.expected_arrival_time)}` : ''}`
    case 'early_departure': return `${d} · leaving ${t(r.departure_time)}`
    case 'time_out':        return `${d} · out ${t(r.departure_time)}–${t(r.return_time)} (${r.work_kind === 'company' ? 'company work' : 'personal'})`
    case 'half_day':        return `${d} · ${r.half_session === 'first_half' ? 'first half' : 'second half'}`
    case 'full_day_leave':  return d
  }
}
