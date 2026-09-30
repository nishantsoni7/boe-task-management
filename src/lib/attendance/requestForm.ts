// The Attendance request form's own rules: which tile means which backend
// type, which fields a tile shows, what is sent, and what is missing.
//
// The four tiles are a way of ASKING. The server still receives one of the five
// existing request types and validates it exactly as before
// (./requests.ts validateRequestInput) — nothing here replaces that check, it
// only stops an employee from sending something the server will refuse, and
// stops a switch of tile from carrying stale values across.

import { istAddDays, istToday } from '../istDate'
import type { AttendanceRequestRow, ReasonCode, RequestType } from './requests'

export const FORM_TILES = ['leave', 'late', 'early', 'out'] as const
export type FormTile = (typeof FORM_TILES)[number]

export const TILE_LABEL: Record<FormTile, string> = {
  leave: 'Leave',
  late:  'Coming late',
  early: 'Leaving early',
  out:   'Going out briefly',
}

export type LeaveKind = 'full' | 'half'

/** The backend type a tile (and, for Leave, its Full/Half choice) stands for. */
export function requestTypeFor(tile: FormTile, leave: LeaveKind): RequestType {
  switch (tile) {
    case 'late':  return 'late_arrival'
    case 'early': return 'early_departure'
    case 'out':   return 'time_out'
    case 'leave': return leave === 'half' ? 'half_day' : 'full_day_leave'
  }
}

/** The reverse, for pre-filling a correction. */
export function tileForType(type: RequestType): { tile: FormTile; leave: LeaveKind } {
  switch (type) {
    case 'late_arrival':    return { tile: 'late',  leave: 'full' }
    case 'early_departure': return { tile: 'early', leave: 'full' }
    case 'time_out':        return { tile: 'out',   leave: 'full' }
    case 'half_day':        return { tile: 'leave', leave: 'half' }
    case 'full_day_leave':  return { tile: 'leave', leave: 'full' }
  }
}

// ─── Date shortcuts ──────────────────────────────────────────────────────────

/**
 * Today and Tomorrow as IST business dates. Both come from the same instant, so
 * they cannot disagree across IST midnight (18:30 UTC): at 18:29 UTC "today" is
 * the 5th and "tomorrow" the 6th; one minute later they are the 6th and 7th.
 */
export function dateShortcuts(now: Date = new Date()): { today: string; tomorrow: string } {
  const today = istToday(now)
  return { today, tomorrow: istAddDays(today, 1) }
}

export type DateChoice = 'today' | 'tomorrow' | 'other'

/**
 * Which shortcut a date is. Derived from the date, never stored, so a form left
 * open across midnight shows the truth: the date the employee chose stays put
 * and simply stops being called "Today".
 */
export function dateChoice(date: string, now: Date = new Date()): DateChoice {
  const { today, tomorrow } = dateShortcuts(now)
  if (date === today) return 'today'
  if (date === tomorrow) return 'tomorrow'
  return 'other'
}

// ─── State, payload, validation ──────────────────────────────────────────────

export type FormState = {
  tile: FormTile
  leave: LeaveKind
  date: string
  /** Leave only: last day of a multi-day leave. Empty = one day. */
  endDate: string
  expected: string
  depart: string
  back: string
  half: 'first_half' | 'second_half' | ''
  kind: 'personal' | 'company' | ''
  reason: ReasonCode | ''
  note: string
}

export function initialFormState(now: Date = new Date(), original?: AttendanceRequestRow | null): FormState {
  const clock = (v: string | null | undefined) => (v ? v.slice(0, 5) : '')
  if (original) {
    const { tile, leave } = tileForType(original.request_type)
    return {
      tile, leave,
      date: original.start_date,
      endDate: original.end_date !== original.start_date ? original.end_date : '',
      expected: clock(original.expected_arrival_time),
      depart: clock(original.departure_time),
      back: clock(original.return_time),
      half: original.half_session ?? '',
      kind: original.work_kind ?? '',
      reason: original.reason_code,
      note: original.reason_note ?? '',
    }
  }
  return {
    tile: 'late', leave: 'full',
    date: istToday(now),
    endDate: '', expected: '', depart: '', back: '', half: '', kind: '',
    reason: '', note: '',
  }
}

/**
 * What is sent. Only the chosen tile's fields carry a value; everything else is
 * null, so switching tile never submits a stale time, half or purpose.
 */
export function buildPayload(s: FormState, replacesId: string | null = null): Record<string, unknown> {
  const type = requestTypeFor(s.tile, s.leave)
  return {
    request_type: type,
    start_date: s.date,
    end_date: type === 'full_day_leave' && s.endDate ? s.endDate : null,
    expected_arrival_time: type === 'late_arrival' && s.expected ? s.expected : null,
    departure_time: type === 'early_departure' || type === 'time_out' ? s.depart : null,
    return_time: type === 'time_out' ? s.back : null,
    half_session: type === 'half_day' ? s.half : null,
    work_kind: type === 'time_out' ? s.kind : null,
    reason_code: s.reason,
    reason_note: s.note.trim() || null,
    replaces_request_id: replacesId,
  }
}

export type FormField = 'date' | 'endDate' | 'half' | 'expected' | 'depart' | 'back' | 'kind' | 'reason' | 'note'
export type FormErrors = Partial<Record<FormField, string>>

/** Field order as shown, so the first error is the first thing on screen. */
export const FIELD_ORDER: FormField[] = ['date', 'endDate', 'half', 'expected', 'depart', 'back', 'kind', 'reason', 'note']

/**
 * Missing or obviously wrong entries, per field. The server's validation stays
 * the authority (working-hours window, retro limit, overlaps); this covers what
 * the form can say before a round trip, in the words the field is labelled with.
 */
export function validateForm(s: FormState): FormErrors {
  const e: FormErrors = {}
  const type = requestTypeFor(s.tile, s.leave)
  if (!s.date) e.date = 'Choose a date.'
  if (type === 'full_day_leave' && s.endDate && s.endDate < s.date) e.endDate = 'The last day cannot be before the first day.'
  if (type === 'half_day' && !s.half) e.half = 'Choose first half or second half.'
  if (type === 'early_departure' && !s.depart) e.depart = 'Enter the time you plan to leave.'
  if (type === 'time_out') {
    if (!s.depart) e.depart = 'Enter the time you will leave.'
    if (!s.back) e.back = 'Enter the time you expect to be back.'
    else if (s.depart && s.back <= s.depart) e.back = 'The return time must be after the time you leave.'
    if (!s.kind) e.kind = 'Say whether this is personal or company work.'
  }
  if (!s.reason) e.reason = 'Choose a reason.'
  if (s.reason === 'other' && !s.note.trim()) e.note = 'Add a short explanation for “Other”.'
  return e
}
