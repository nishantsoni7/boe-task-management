// Monthly attendance review for payroll — requests matched with actual
// attendance, per employee, as pure logic.
//
// WHAT THIS IS
// ------------
// Before a payroll month is locked, the reviewer needs every salary-relevant
// attendance event of the month in one place: actual late arrivals and
// minutes late, whether the employee informed on time, early departures, time
// out, half days and leave, missing punches, absences, and what the reviewer
// has decided about each.
//
// WHAT THIS IS NOT
// ----------------
// A calculation. Nothing here produces a rupee figure. The payroll engine
// (src/lib/payroll/engine.ts) remains the only thing that turns attendance into
// money, and the only path that changes what it charges for a day is the
// existing attendance correction (waivers / day treatment). This module reads
// what the stored DRAFT already charges (payroll_deduction_lines) and says
// whether that agrees with the reviewer's decision. Because it never charges
// anything itself, it cannot deduct the same minutes twice.
//
// The monthly late-arrival flag (the fourth and later uninformed, unexcused
// late arrival) is a REVIEW FLAG ONLY. It does not deduct anything.

import type { AttendanceRequestRow, RequestType, ReasonCode } from './requests'
import { REQUEST_TYPE_LABEL, REASON_LABEL, requestSummary, clockMinutes } from './requests'
import { istDateRange, istMinutesOfDay } from '../istDate'

// ─── Inputs ──────────────────────────────────────────────────────────────────

export type ReconEmployee = {
  id: string
  full_name: string | null
  employee_code: string | null
  is_active: boolean
  payroll_active: boolean | null
  joining_date: string | null
}

export type ReconAttendance = {
  employee_id: string
  attendance_date: string
  check_in_at: string | null
  check_out_at: string | null
  punch_direction_source: string | null
}

export type ReconCorrection = {
  id: string
  employee_id: string
  attendance_date: string
  corrected_check_in_at: string | null
  corrected_check_out_at: string | null
  day_treatment: string
  waive_late_arrival: boolean
  waive_early_checkout: boolean
  waive_missing_punch: boolean
  remark: string | null
}

export const PAY_DECISIONS = ['paid_waived', 'use_paid_leave', 'unpaid_actual', 'needs_correction'] as const
export type PayDecision = (typeof PAY_DECISIONS)[number]

export const PAY_DECISION_LABEL: Record<PayDecision, string> = {
  paid_waived:      'Paid / waived',
  use_paid_leave:   'Use paid leave',
  unpaid_actual:    'Unpaid actual time',
  needs_correction: 'Needs correction',
}

export type ReconReview = {
  id: string
  employee_id: string
  attendance_date: string
  event_key: string
  excused: boolean
  excuse_reason: string | null
  pay_decision: PayDecision | null
  decision_reason: string | null
  attendance_fingerprint: string
  reviewed_by: string
  reviewed_at: string
}

/** A stored deduction line from the generated draft for this month. */
export type ReconDraftLine = {
  employee_id: string
  line_date: string
  deduction_type: string
  hours_deducted: number
  amount_deducted: number
}

export type ReconRedemption = {
  employee_id: string
  attendance_date: string
  deduction_type: string
  credits: number
}

export type ReconSchedule = {
  scheduled_in_minutes: number
  grace_end_minutes: number
  scheduled_out_minutes: number
  weekly_off_day: number
}

export type ReconInput = {
  year: number
  month: number
  /** IST business date — events after it are upcoming, not yet reviewable. */
  today: string
  /** Last date the month's attendance covers company-wide; null = nothing imported. */
  coverageThrough: string | null
  schedule: ReconSchedule
  /** Full-day holidays only; a half-day holiday is still a working day. */
  holidayDates: Set<string>
  /** Whether a payroll draft has been generated for the month. */
  draftGenerated: boolean
  employees: ReconEmployee[]
  attendance: ReconAttendance[]
  corrections: ReconCorrection[]
  requests: AttendanceRequestRow[]
  reviews: ReconReview[]
  draftLines: ReconDraftLine[]
  redemptions: ReconRedemption[]
}

// ─── Output ──────────────────────────────────────────────────────────────────

export type EventKind = 'late_arrival' | 'early_departure' | 'missing_punch' | 'absent' | 'request'

export type ReconRequestInfo = {
  id: string
  type: RequestType
  type_label: string
  status: AttendanceRequestRow['status']
  summary: string
  reason_code: ReasonCode
  reason_label: string
  reason_note: string | null
  submitted_at: string
  informed_before_shift: boolean
  decided_by: string | null
  decided_at: string | null
  decision_note: string | null
}

export type ReconEvent = {
  /** Stable per (employee, date): what a review decision is keyed on. */
  event_key: string
  date: string
  kind: EventKind
  title: string
  actual: {
    check_in: string | null
    check_out: string | null
    source: 'machine' | 'corrected' | 'none'
    minutes_late: number | null
    minutes_early: number | null
  }
  request: ReconRequestInfo | null
  /** Late arrivals only: a request submitted before the shift started. */
  informed: boolean | null
  excused: boolean
  excuse_reason: string | null
  /** Company vehicle, company work or company time out — excusable, never inferred from notes. */
  company_exception: boolean
  counts_toward_policy: boolean
  /** The fourth and later uninformed, unexcused late arrival of the month. */
  policy_flag: boolean
  /** What the stored draft charges for this date and event, stated plainly. */
  payroll_state: string
  draft_amount: number | null
  credits_redeemed: number
  /** Mismatches the reviewer must look at (approved vs actual, pending, …). */
  flags: string[]
  decision: {
    pay_decision: PayDecision | null
    decision_reason: string | null
    reviewed_by: string
    reviewed_at: string
  } | null
  /** Attendance or the request changed after the decision was recorded. */
  stale: boolean
  /** Reviewer decision disagrees with the draft (needs a correction to apply). */
  decision_notes: string[]
  fingerprint: string
  upcoming: boolean
  resolved: boolean
}

export type ReconEmployeeResult = {
  employee: ReconEmployee
  events: ReconEvent[]
  uninformed_late_count: number
  policy_flag_dates: string[]
  unresolved_count: number
}

export type ReconResult = {
  employees: ReconEmployeeResult[]
  totals: { events: number; unresolved: number; policy_flagged_employees: number }
}

/** Monthly flag threshold: MORE THAN this many uninformed, unexcused lates. */
export const LATE_POLICY_ALLOWANCE = 3

// ─── Helpers ─────────────────────────────────────────────────────────────────

const key = (employeeId: string, date: string) => `${employeeId}|${date}`

function groupBy<T>(rows: T[], k: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const r of rows) {
    const kk = k(r)
    const list = m.get(kk)
    if (list) list.push(r)
    else m.set(kk, [r])
  }
  return m
}

function monthBounds(year: number, month: number): { start: string; end: string } {
  const mm = String(month).padStart(2, '0')
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${String(last).padStart(2, '0')}` }
}

function isWeeklyOff(date: string, weeklyOffDay: number): boolean {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay() === weeklyOffDay
}

function rupees(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}

function requestInfo(r: AttendanceRequestRow): ReconRequestInfo {
  return {
    id: r.id,
    type: r.request_type,
    type_label: REQUEST_TYPE_LABEL[r.request_type],
    status: r.status,
    summary: requestSummary(r),
    reason_code: r.reason_code,
    reason_label: REASON_LABEL[r.reason_code],
    reason_note: r.reason_note,
    submitted_at: r.submitted_at,
    informed_before_shift: r.informed_before_shift,
    decided_by: r.decided_by,
    decided_at: r.decided_at,
    decision_note: r.decision_note,
  }
}

function isCompanyReason(r: AttendanceRequestRow): boolean {
  return r.reason_code === 'company_vehicle' || r.reason_code === 'company_work' ||
    (r.request_type === 'time_out' && r.work_kind === 'company')
}

/** Draft deduction types that belong to each event kind. */
const DRAFT_TYPES: Record<Exclude<EventKind, 'request'>, string[]> = {
  late_arrival:    ['late_arrival'],
  early_departure: ['early_checkout'],
  missing_punch:   ['missing_punch_in', 'missing_punch_out'],
  absent:          ['absent'],
}

function draftTypesForRequest(t: RequestType): string[] {
  switch (t) {
    case 'late_arrival':    return ['late_arrival']
    case 'early_departure': return ['early_checkout']
    case 'time_out':        return ['early_checkout', 'short_hours', 'half_day']
    case 'half_day':        return ['half_day', 'absent', 'late_arrival', 'early_checkout']
    case 'full_day_leave':  return ['absent', 'half_day']
  }
}

// ─── The builder ─────────────────────────────────────────────────────────────

export function buildReconciliation(input: ReconInput): ReconResult {
  const { start, end } = monthBounds(input.year, input.month)
  const s = input.schedule

  const attendanceBy  = new Map(input.attendance.map(a => [key(a.employee_id, a.attendance_date), a]))
  const correctionBy  = new Map(input.corrections.map(c => [key(c.employee_id, c.attendance_date), c]))
  const reviewBy      = new Map(input.reviews.map(r => [`${key(r.employee_id, r.attendance_date)}|${r.event_key}`, r]))
  const draftBy       = groupBy(input.draftLines, l => key(l.employee_id, l.line_date))
  const redemptionBy  = groupBy(input.redemptions, r => key(r.employee_id, r.attendance_date))

  // Requests that still speak for their dates. A cancelled request is history
  // (the audit trail keeps it); a rejected one still says the employee informed.
  const liveRequests = input.requests.filter(r => r.status !== 'cancelled')
  const requestsByEmpDate = new Map<string, AttendanceRequestRow[]>()
  for (const r of liveRequests) {
    for (const d of istDateRange(r.start_date < start ? start : r.start_date, r.end_date > end ? end : r.end_date)) {
      const k = key(r.employee_id, d)
      const list = requestsByEmpDate.get(k)
      if (list) list.push(r)
      else requestsByEmpDate.set(k, [r])
    }
  }

  // Absence is only asserted for dates the imported attendance actually covers;
  // before an import, every day would otherwise read as absent.
  const reviewableThrough = input.coverageThrough

  const employees: ReconEmployeeResult[] = []

  for (const emp of input.employees) {
    const events: ReconEvent[] = []

    for (const date of istDateRange(start, end)) {
      if (emp.joining_date && date < emp.joining_date) continue
      const k = key(emp.id, date)
      const raw = attendanceBy.get(k)
      const corr = correctionBy.get(k)
      const reqs = requestsByEmpDate.get(k) ?? []
      const workingDay = !isWeeklyOff(date, s.weekly_off_day) && !input.holidayDates.has(date)
      const upcoming = date > input.today

      const checkIn  = corr ? corr.corrected_check_in_at  : raw?.check_in_at  ?? null
      const checkOut = corr ? corr.corrected_check_out_at : raw?.check_out_at ?? null
      const source: ReconEvent['actual']['source'] = corr ? 'corrected' : raw ? 'machine' : 'none'
      // A lone machine punch whose direction was only guessed from the clock is
      // not a measured arrival or departure (see src/lib/attendance/punchDirection.ts).
      const directionKnown = !!corr || (checkIn != null && checkOut != null) || raw?.punch_direction_source === 'confirmed'
      const inMin  = checkIn  && directionKnown ? istMinutesOfDay(checkIn)  : null
      const outMin = checkOut && directionKnown ? istMinutesOfDay(checkOut) : null

      const minutesLate  = inMin  != null && inMin  > s.grace_end_minutes     ? inMin - s.scheduled_in_minutes   : null
      const minutesEarly = outMin != null && outMin < s.scheduled_out_minutes ? s.scheduled_out_minutes - outMin : null

      const actual = { check_in: checkIn, check_out: checkOut, source, minutes_late: minutesLate, minutes_early: minutesEarly }
      const draft = draftBy.get(k) ?? []
      const redeemed = redemptionBy.get(k) ?? []

      const makeEvent = (
        eventKey: string,
        kind: EventKind,
        title: string,
        req: AttendanceRequestRow | null,
        draftTypes: string[],
        waived: boolean,
        extra: Partial<ReconEvent> = {},
      ): ReconEvent => {
        const lines = draft.filter(l => draftTypes.includes(l.deduction_type))
        const amount = lines.reduce((t, l) => t + Number(l.amount_deducted || 0), 0)
        const credits = redeemed.filter(r => draftTypes.includes(r.deduction_type)).reduce((t, r) => t + Number(r.credits || 0), 0)
        const payrollState = !input.draftGenerated
          ? 'No payroll draft generated for this month yet.'
          : waived
            ? 'Waived in the draft by an attendance correction.'
            : lines.length === 0
              ? 'The draft charges nothing for this.'
              : amount === 0
                ? 'Charged in the draft, then absorbed (paid leave or BOE Credits): ₹0.'
                : `The draft deducts ${rupees(amount)} (${lines.map(l => `${Number(l.hours_deducted)} h ${l.deduction_type.replace(/_/g, ' ')}`).join(', ')}).`

        const fingerprint = JSON.stringify([
          checkIn, checkOut, corr?.id ?? null,
          reqs.map(r => [r.id, r.status, r.decided_at]).sort(),
        ])
        const review = reviewBy.get(`${k}|${eventKey}`) ?? null
        const stale = !!review && review.attendance_fingerprint !== fingerprint

        const decisionNotes: string[] = []
        if (review && !stale && input.draftGenerated) {
          if (review.pay_decision === 'paid_waived' && amount > 0 && !waived)
            decisionNotes.push(`Decision is Paid / waived, but the draft still deducts ${rupees(amount)}. Apply a waiver through the attendance correction to change pay.`)
          if (review.pay_decision === 'unpaid_actual' && waived)
            decisionNotes.push('Decision is Unpaid actual time, but an attendance correction waives this day.')
          if (review.pay_decision === 'use_paid_leave')
            decisionNotes.push('Payroll applies earned paid leave automatically to the earliest eligible item of the month; check the payslip to confirm it covered this.')
        }

        return {
          event_key: eventKey,
          date,
          kind,
          title,
          actual,
          request: req ? requestInfo(req) : null,
          informed: null,
          excused: review?.excused ?? false,
          excuse_reason: review?.excuse_reason ?? null,
          company_exception: req ? isCompanyReason(req) : false,
          counts_toward_policy: false,
          policy_flag: false,
          payroll_state: payrollState,
          draft_amount: input.draftGenerated ? amount : null,
          credits_redeemed: credits,
          flags: [],
          decision: review ? {
            pay_decision: review.pay_decision,
            decision_reason: review.decision_reason,
            reviewed_by: review.reviewed_by,
            reviewed_at: review.reviewed_at,
          } : null,
          stale,
          decision_notes: decisionNotes,
          fingerprint,
          upcoming,
          resolved: false,
          ...extra,
        }
      }

      const consumed = new Set<string>()
      const reqOf = (t: RequestType) => reqs.find(r => r.request_type === t) ?? null

      // ── Actual late arrival ────────────────────────────────────────────────
      if (minutesLate != null && workingDay) {
        const lateReq = reqOf('late_arrival')
        // Informed = any live request covering the morning, submitted before
        // the shift started. Rejection does not undo having informed.
        const informedBy = reqs.find(r =>
          (r.request_type === 'late_arrival' ||
           r.request_type === 'full_day_leave' ||
           (r.request_type === 'half_day' && r.half_session === 'first_half')) &&
          r.informed_before_shift)
        const related = lateReq ?? informedBy ?? null
        if (related) consumed.add(related.id)
        const ev = makeEvent('late_arrival', 'late_arrival', `Late arrival · ${minutesLate} min`, related,
          DRAFT_TYPES.late_arrival, !!corr?.waive_late_arrival)
        ev.informed = !!informedBy
        ev.counts_toward_policy = !ev.informed && !ev.excused
        if (!related) ev.flags.push('No request was submitted.')
        if (lateReq?.status === 'approved' && lateReq.expected_arrival_time && inMin != null) {
          const expected = clockMinutes(lateReq.expected_arrival_time)!
          if (inMin > expected + (s.grace_end_minutes - s.scheduled_in_minutes))
            ev.flags.push(`Arrived later than approved (expected ${lateReq.expected_arrival_time.slice(0, 5)}).`)
        }
        if (related?.status === 'pending') ev.flags.push('The request is still pending.')
        if (related?.status === 'rejected') ev.flags.push('The request was rejected.')
        events.push(ev)
      }

      // ── Actual early departure ─────────────────────────────────────────────
      if (minutesEarly != null && workingDay) {
        const earlyReq = reqOf('early_departure')
          ?? reqs.find(r => r.request_type === 'half_day' && r.half_session === 'second_half')
          ?? reqOf('full_day_leave')
        if (earlyReq) consumed.add(earlyReq.id)
        const ev = makeEvent('early_departure', 'early_departure', `Early departure · ${minutesEarly} min`, earlyReq,
          DRAFT_TYPES.early_departure, !!corr?.waive_early_checkout)
        if (!earlyReq) ev.flags.push('No request was submitted.')
        if (earlyReq?.request_type === 'early_departure' && earlyReq.status === 'approved' && earlyReq.departure_time && outMin != null) {
          if (outMin < clockMinutes(earlyReq.departure_time)! - 15)
            ev.flags.push(`Left earlier than approved (approved ${earlyReq.departure_time.slice(0, 5)}).`)
        }
        if (earlyReq?.status === 'pending') ev.flags.push('The request is still pending.')
        if (earlyReq?.status === 'rejected') ev.flags.push('The request was rejected.')
        events.push(ev)
      }

      // ── Missing punch ──────────────────────────────────────────────────────
      if ((checkIn == null) !== (checkOut == null) && workingDay) {
        const ev = makeEvent('missing_punch', 'missing_punch',
          checkIn == null ? 'Missing punch-in' : 'Missing punch-out', null,
          DRAFT_TYPES.missing_punch, !!corr?.waive_missing_punch)
        const timeOut = reqs.find(r => r.request_type === 'time_out')
        if (timeOut) ev.flags.push('A time-out request exists for this day — the return punch may be missing.')
        events.push(ev)
      }

      // ── Requests not already attached to an actual event ───────────────────
      for (const r of reqs) {
        if (consumed.has(r.id)) continue
        if (r.request_type === 'full_day_leave' && !workingDay) continue
        const ev = makeEvent(`request:${r.id}`, 'request', REQUEST_TYPE_LABEL[r.request_type], r,
          draftTypesForRequest(r.request_type),
          r.request_type === 'late_arrival' ? !!corr?.waive_late_arrival
            : r.request_type === 'early_departure' ? !!corr?.waive_early_checkout
            : false)
        const hasPunch = checkIn != null || checkOut != null
        if (r.status === 'pending') ev.flags.push('The request is still pending.')
        if (r.status === 'rejected') ev.flags.push('The request was rejected.')
        if (!upcoming) {
          if (r.request_type === 'full_day_leave' && hasPunch)
            ev.flags.push('Leave was requested, but attendance shows punches on this day.')
          if (r.request_type !== 'full_day_leave' && !hasPunch && (!reviewableThrough || date <= reviewableThrough))
            ev.flags.push('No attendance recorded for this day.')
          if (r.request_type === 'late_arrival' && hasPunch)
            ev.flags.push('Arrived within the grace period — no late arrival on the record.')
          if (r.request_type === 'early_departure' && hasPunch && checkOut != null)
            ev.flags.push('Left at or after the scheduled time — no early departure on the record.')
          if (r.request_type === 'time_out')
            ev.flags.push('Actual time away is not recorded: attendance stores only the first and last punch.')
        }
        events.push(ev)
      }

      // ── Absence with no request ────────────────────────────────────────────
      const covered = reqs.some(r => r.request_type === 'full_day_leave' || r.request_type === 'half_day')
      if (workingDay && !upcoming && !raw && !corr && !covered &&
          reviewableThrough != null && date <= reviewableThrough) {
        const ev = makeEvent('absent', 'absent', 'Absent · no request', null, DRAFT_TYPES.absent, false)
        ev.flags.push('No punches and no request for this working day.')
        events.push(ev)
      }
      if (corr && corr.day_treatment === 'absent' && workingDay && !events.some(e => e.date === date && e.kind === 'absent')) {
        const ev = makeEvent('absent', 'absent', 'Absent · by correction', null, DRAFT_TYPES.absent, false)
        events.push(ev)
      }
    }

    // ── Monthly late-arrival review flag ─────────────────────────────────────
    let count = 0
    const flagged: string[] = []
    for (const ev of events) {
      if (ev.kind !== 'late_arrival' || !ev.counts_toward_policy) continue
      count++
      if (count > LATE_POLICY_ALLOWANCE) {
        ev.policy_flag = true
        flagged.push(ev.date)
      }
    }

    for (const ev of events) {
      ev.resolved = !ev.upcoming && !!ev.decision && !ev.stale &&
        ev.decision.pay_decision != null && ev.decision.pay_decision !== 'needs_correction'
    }
    const unresolved = events.filter(e => !e.upcoming && !e.resolved).length

    if (events.length > 0 || !emp.is_active) {
      employees.push({
        employee: emp,
        events,
        uninformed_late_count: count,
        policy_flag_dates: flagged,
        unresolved_count: unresolved,
      })
    }
  }

  employees.sort((a, b) =>
    b.unresolved_count - a.unresolved_count ||
    (a.employee.full_name ?? '').localeCompare(b.employee.full_name ?? ''))

  return {
    employees,
    totals: {
      events: employees.reduce((t, e) => t + e.events.length, 0),
      unresolved: employees.reduce((t, e) => t + e.unresolved_count, 0),
      policy_flagged_employees: employees.filter(e => e.policy_flag_dates.length > 0).length,
    },
  }
}

/** A review decision body, validated. */
export type ReviewInput = {
  employee_id: string
  attendance_date: string
  event_key: string
  excused: boolean
  excuse_reason: string | null
  pay_decision: PayDecision | null
  decision_reason: string | null
}

const EVENT_KEY_RE = /^(late_arrival|early_departure|missing_punch|absent|request:[0-9a-f-]{36})$/

export function validateReviewInput(body: Record<string, unknown>): { ok: true; value: ReviewInput } | { ok: false; error: string } {
  const employeeId = typeof body.employee_id === 'string' ? body.employee_id : ''
  const date = typeof body.attendance_date === 'string' ? body.attendance_date : ''
  const eventKey = typeof body.event_key === 'string' ? body.event_key : ''
  if (!employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !EVENT_KEY_RE.test(eventKey))
    return { ok: false, error: 'employee_id, attendance_date and event_key are required' }

  const excused = body.excused === true
  const excuseReason = typeof body.excuse_reason === 'string' ? body.excuse_reason.trim() : ''
  if (excused && eventKey !== 'late_arrival') return { ok: false, error: 'Only a late arrival can be excused.' }
  if (excused && !excuseReason) return { ok: false, error: 'Give a reason for excusing the late arrival.' }

  const decision = body.pay_decision == null || body.pay_decision === '' ? null : body.pay_decision
  if (decision != null && !(PAY_DECISIONS as readonly unknown[]).includes(decision))
    return { ok: false, error: 'Choose a valid salary treatment.' }
  const reason = typeof body.decision_reason === 'string' ? body.decision_reason.trim() : ''
  if (decision && !reason) return { ok: false, error: 'Give a short reason for the salary treatment.' }
  if (!decision && !excused) return { ok: false, error: 'Choose a salary treatment or excuse the late arrival.' }
  if (excuseReason.length > 500 || reason.length > 500) return { ok: false, error: 'Keep reasons under 500 characters.' }

  return {
    ok: true,
    value: {
      employee_id: employeeId,
      attendance_date: date,
      event_key: eventKey,
      excused,
      excuse_reason: excused ? excuseReason : null,
      pay_decision: decision as PayDecision | null,
      decision_reason: decision ? reason : null,
    },
  }
}
