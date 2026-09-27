// Monthly attendance review for payroll — requests matched with actual
// attendance, per employee, as pure logic.
//
// WHAT THIS IS
// ------------
// Before a payroll month is locked, the reviewer needs every salary-relevant
// attendance event of the month in one place: actual late arrivals and
// minutes late, whether the employee informed on time, early departures, time
// out, half days and leave, missing punches, absences, and what the reviewer
// has decided about each — and whether the payroll DRAFT agrees.
//
// WHAT THIS IS NOT
// ----------------
// A calculation. Nothing here produces a rupee figure. The payroll engine
// (src/lib/payroll/engine.ts) is the only thing that turns attendance into
// money, and the only path that changes what it charges for a day is the
// attendance correction (src/lib/payroll/attendanceCorrectionService.ts).
// `planReviewApplication` below turns a reviewed decision into the correction
// that path should apply; the reviewer's decision is RESOLVED only once the
// stored draft actually matches it — never because a decision row was saved.
//
// The monthly late-arrival flag (the fourth and later uninformed, unexcused
// late arrival) is a REVIEW FLAG ONLY. It does not deduct anything.

import type { AttendanceRequestRow, RequestType, ReasonCode } from './requests'
import { REQUEST_TYPE_LABEL, REASON_LABEL, requestSummary, clockMinutes } from './requests'
import { istDateRange, istMinutesOfDay } from '../istDate'
import type { ValidatedCorrection } from '../payroll/correctionRules'

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

/**
 * The salary treatments a reviewer can record.
 *
 * There is deliberately NO "use paid leave": the engine allocates the month's
 * earned paid leave itself, to the earliest eligible item, and has no way to
 * be told to spend it on a particular day. Offering the choice would record a
 * decision payroll cannot honour. What the automatic rule actually did is
 * described on each event instead.
 */
export const PAY_DECISIONS = ['paid_waived', 'unpaid_actual', 'needs_correction'] as const
export type PayDecision = (typeof PAY_DECISIONS)[number]

export const PAY_DECISION_LABEL: Record<PayDecision, string> = {
  paid_waived:      'Paid / waived',
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
  applied_correction_id?: string | null
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
  reason_code: ReconRequestReason
  reason_label: string
  reason_note: string | null
  submitted_at: string
  informed_before_shift: boolean
  decided_by: string | null
  decided_at: string | null
  decision_note: string | null
  /** Requested clock times, as the employee stated them. Never measured. */
  requested_departure: string | null
  requested_return: string | null
}
type ReconRequestReason = ReasonCode

/**
 * Where an event stands against payroll.
 *
 *   upcoming         the date has not happened yet
 *   needs_decision   no reviewer decision yet
 *   stale            decided, but the attendance, correction, request or
 *                    schedule changed since — review again
 *   needs_correction the reviewer asked for a correction
 *   no_draft         decided, but no payroll draft exists to reflect it
 *   action_required  the draft does not match the decision; it must be
 *                    changed in payroll (automatically on save where the
 *                    correction path supports it, otherwise on the payslip)
 *   resolved         the draft matches the decision
 */
export type SalaryStatus =
  | 'upcoming' | 'needs_decision' | 'stale' | 'needs_correction'
  | 'no_draft' | 'action_required' | 'resolved'

export type DayState = {
  raw: { check_in_at: string | null; check_out_at: string | null; direction_confirmed: boolean } | null
  correction: ReconCorrection | null
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
  /** An attendance correction currently waives this event's charge. */
  waived_by_correction: boolean
  credits_redeemed: number
  /** Mismatches the reviewer must look at (approved vs actual, pending, …). */
  flags: string[]
  decision: {
    pay_decision: PayDecision | null
    decision_reason: string | null
    reviewed_by: string
    reviewed_at: string
    applied_correction_id: string | null
  } | null
  /** Attendance or the request changed after the decision was recorded. */
  stale: boolean
  stale_reasons: string[]
  salary_status: SalaryStatus
  /** Why payroll does not yet reflect the decision, and what to do. */
  action_note: string | null
  /** Saving Paid / waived or Unpaid actual on this event applies it through the correction path. */
  applies_in_one_step: boolean
  /** Why not, when it cannot. */
  one_step_blocker: string | null
  /** Decisions this event accepts (time out has no measured duration to charge). */
  allowed_decisions: PayDecision[]
  fingerprint: string
  upcoming: boolean
  resolved: boolean
  day_state: DayState
}

export type ReconEmployeeResult = {
  employee: ReconEmployee
  events: ReconEvent[]
  uninformed_late_count: number
  policy_flag_dates: string[]
  unresolved_count: number
  /** Decided events whose draft disagrees (action_required). */
  conflict_count: number
}

export type ReconResult = {
  employees: ReconEmployeeResult[]
  totals: { events: number; unresolved: number; conflicts: number; policy_flagged_employees: number }
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
    requested_departure: r.departure_time ? r.departure_time.slice(0, 5) : null,
    requested_return: r.return_time ? r.return_time.slice(0, 5) : null,
  }
}

function isCompanyReason(r: AttendanceRequestRow): boolean {
  return r.reason_code === 'company_vehicle' || r.reason_code === 'company_work' ||
    (r.request_type === 'time_out' && r.work_kind === 'company')
}

/**
 * Draft deduction types that belong to each event kind. Each draft line is
 * attributed to at most ONE event per day, so a figure is never counted twice.
 */
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
    // Time out has no line of its own: the engine sees only first-in/last-out.
    // An actual early departure on that day is its own event.
    case 'time_out':        return []
    case 'half_day':        return ['half_day', 'absent']
    case 'full_day_leave':  return ['absent', 'half_day']
  }
}

/** The correction waiver that settles each event key, where one exists. */
export const WAIVER_FIELD: Partial<Record<string, 'waive_late_arrival' | 'waive_early_checkout' | 'waive_missing_punch'>> = {
  late_arrival:    'waive_late_arrival',
  early_departure: 'waive_early_checkout',
  missing_punch:   'waive_missing_punch',
}

/**
 * The fingerprint is a small JSON object, so a stale decision can say WHY it
 * is stale. Only what bears on THIS event is included: a waiver applied to the
 * same day's early departure must not make the late-arrival decision stale.
 */
type Fingerprint = {
  punches: [string | null, string | null]
  correction: { treatment: string; waived: boolean } | null
  requests: [string, string, string | null][]
  schedule: [number, number, number]
}

function staleReasons(stored: string, current: Fingerprint): string[] {
  let old: Partial<Fingerprint>
  try { old = JSON.parse(stored) } catch { return ['The review predates this check — review again.'] }
  if (!old || Array.isArray(old)) return ['The review predates this check — review again.']
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const out: string[] = []
  if (!same(old.punches, current.punches)) out.push('The punches changed.')
  if (!same(old.correction, current.correction)) out.push('The attendance correction for this day changed.')
  if (!same(old.requests, current.requests)) out.push('The request changed (edited, decided or cancelled).')
  if (!same(old.schedule, current.schedule)) out.push('The payroll schedule settings changed.')
  return out
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
      const rawDirectionConfirmed = !!raw && ((raw.check_in_at != null && raw.check_out_at != null) || raw.punch_direction_source === 'confirmed')
      const directionKnown = !!corr || (checkIn != null && checkOut != null) || raw?.punch_direction_source === 'confirmed'
      const inMin  = checkIn  && directionKnown ? istMinutesOfDay(checkIn)  : null
      const outMin = checkOut && directionKnown ? istMinutesOfDay(checkOut) : null

      const minutesLate  = inMin  != null && inMin  > s.grace_end_minutes     ? inMin - s.scheduled_in_minutes   : null
      const minutesEarly = outMin != null && outMin < s.scheduled_out_minutes ? s.scheduled_out_minutes - outMin : null

      const actual = { check_in: checkIn, check_out: checkOut, source, minutes_late: minutesLate, minutes_early: minutesEarly }
      const draft = draftBy.get(k) ?? []
      const redeemed = redemptionBy.get(k) ?? []
      const dayState: DayState = {
        raw: raw ? { check_in_at: raw.check_in_at, check_out_at: raw.check_out_at, direction_confirmed: rawDirectionConfirmed } : null,
        correction: corr ?? null,
      }

      const makeEvent = (
        eventKey: string,
        kind: EventKind,
        title: string,
        req: AttendanceRequestRow | null,
        draftTypes: string[],
      ): ReconEvent => {
        const waiverField = WAIVER_FIELD[eventKey]
        const waived = !!(corr && waiverField && corr.day_treatment === 'auto' && corr[waiverField])
        const lines = draft.filter(l => draftTypes.includes(l.deduction_type))
        const amount = lines.reduce((t, l) => t + Number(l.amount_deducted || 0), 0)
        const credits = redeemed.filter(r => draftTypes.includes(r.deduction_type)).reduce((t, r) => t + Number(r.credits || 0), 0)

        let payrollState: string
        if (!input.draftGenerated) payrollState = 'No payroll draft generated for this month yet.'
        else if (waived) payrollState = 'Waived in the draft by an attendance correction: ₹0.'
        else if (corr && corr.day_treatment !== 'auto') payrollState = `The day is set to "${corr.day_treatment.replace('_', ' ')}" by an attendance correction; the draft charges ${rupees(amount)} for this.`
        else if (lines.length === 0) payrollState = draftTypes.length === 0
          ? 'Payroll has no charge of its own for this: it sees only the first and last punch.'
          : 'The draft charges nothing for this.'
        else if (amount === 0 && credits > 0) payrollState = `Charged, then covered by the employee's BOE Credits (${credits}): ₹0.`
        else if (amount === 0) payrollState = 'Charged, then absorbed by the month\'s automatic paid leave (payroll\'s rule: the earliest eligible item). ₹0 — not a manual choice.'
        else payrollState = `The draft deducts ${rupees(amount)} (${lines.map(l => `${Number(l.hours_deducted)} h ${l.deduction_type.replace(/_/g, ' ')}`).join(', ')}).`

        const fp: Fingerprint = {
          punches: [checkIn, checkOut],
          correction: corr ? { treatment: corr.day_treatment, waived: waiverField ? !!corr[waiverField] : false } : null,
          requests: reqs.map(r => [r.id, r.status, r.decided_at] as [string, string, string | null]).sort(),
          schedule: [s.scheduled_in_minutes, s.grace_end_minutes, s.scheduled_out_minutes],
        }
        const fingerprint = JSON.stringify(fp)
        const review = reviewBy.get(`${k}|${eventKey}`) ?? null
        const reasons = review ? staleReasons(review.attendance_fingerprint, fp) : []

        const isTimeOut = req?.request_type === 'time_out' && kind === 'request'
        const allowed: PayDecision[] = isTimeOut ? ['paid_waived', 'needs_correction'] : [...PAY_DECISIONS]

        // Can a Paid / waived or Unpaid decision be applied in one step?
        let blocker: string | null = null
        if (!waiverField) blocker = kind === 'request' && isTimeOut
          ? 'Actual time away unavailable: a salary effect needs a supported attendance source or an explicit correction on the payslip.'
          : 'This kind of event is settled by the day treatment on the payslip (full day, half day, absent), which is a separate judgement.'
        else if (corr && corr.day_treatment !== 'auto') blocker = 'This day has a manual day treatment; waivers do not apply to it. Change it on the payslip.'
        else if (!corr && raw && !rawDirectionConfirmed) blocker = 'The only punch on this day had its direction guessed from the clock; confirm the punches on the payslip first.'
        else if (!corr && !raw) blocker = 'There is no attendance record to correct.'

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
          waived_by_correction: waived,
          credits_redeemed: credits,
          flags: [],
          decision: review ? {
            pay_decision: review.pay_decision,
            decision_reason: review.decision_reason,
            reviewed_by: review.reviewed_by,
            reviewed_at: review.reviewed_at,
            applied_correction_id: review.applied_correction_id ?? null,
          } : null,
          stale: reasons.length > 0,
          stale_reasons: reasons,
          salary_status: 'needs_decision',
          action_note: null,
          applies_in_one_step: blocker == null,
          one_step_blocker: blocker,
          allowed_decisions: allowed,
          fingerprint,
          upcoming,
          resolved: false,
          day_state: dayState,
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
        const ev = makeEvent('late_arrival', 'late_arrival', `Late arrival · ${minutesLate} min`, related, DRAFT_TYPES.late_arrival)
        ev.informed = !!informedBy
        ev.counts_toward_policy = !ev.informed && !ev.excused
        if (!related) ev.flags.push('No request was submitted.')
        if (related?.status === 'approved')
          ev.flags.push('Approved = permission recorded. Whether the late minutes are paid is the salary treatment below.')
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
        const ev = makeEvent('early_departure', 'early_departure', `Early departure · ${minutesEarly} min`, earlyReq, DRAFT_TYPES.early_departure)
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
          checkIn == null ? 'Missing punch-in' : 'Missing punch-out', null, DRAFT_TYPES.missing_punch)
        const timeOut = reqs.find(r => r.request_type === 'time_out')
        if (timeOut) ev.flags.push('A time-out request exists for this day — the return punch may be missing.')
        events.push(ev)
      }

      // ── Requests not already attached to an actual event ───────────────────
      for (const r of reqs) {
        if (consumed.has(r.id)) continue
        if (r.request_type === 'full_day_leave' && !workingDay) continue
        const title = r.request_type === 'time_out'
          ? `Time out (requested ${r.departure_time?.slice(0, 5)}–${r.return_time?.slice(0, 5)}) · actual time away unavailable`
          : REQUEST_TYPE_LABEL[r.request_type]
        const ev = makeEvent(`request:${r.id}`, 'request', title, r, draftTypesForRequest(r.request_type))
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
            ev.flags.push('Actual time away unavailable: attendance stores only the first and last punch. The requested times are not measured and are never charged.')
        }
        events.push(ev)
      }

      // ── Absence with no request ────────────────────────────────────────────
      const covered = reqs.some(r => r.request_type === 'full_day_leave' || r.request_type === 'half_day')
      if (workingDay && !upcoming && !raw && !corr && !covered &&
          reviewableThrough != null && date <= reviewableThrough) {
        const ev = makeEvent('absent', 'absent', 'Absent · no request', null, DRAFT_TYPES.absent)
        ev.flags.push('No punches and no request for this working day.')
        events.push(ev)
      }
      if (corr && corr.day_treatment === 'absent' && workingDay && !events.some(e => e.date === date && e.kind === 'absent')) {
        events.push(makeEvent('absent', 'absent', 'Absent · by correction', null, DRAFT_TYPES.absent))
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

    for (const ev of events) settleSalaryStatus(ev, input.draftGenerated)

    employees.push({
      employee: emp,
      events,
      uninformed_late_count: count,
      policy_flag_dates: flagged,
      unresolved_count: events.filter(e => !e.upcoming && !e.resolved).length,
      conflict_count: events.filter(e => e.salary_status === 'action_required').length,
    })
  }

  const withEvents = employees.filter(e => e.events.length > 0 || !e.employee.is_active)
  withEvents.sort((a, b) =>
    b.conflict_count - a.conflict_count ||
    b.unresolved_count - a.unresolved_count ||
    (a.employee.full_name ?? '').localeCompare(b.employee.full_name ?? ''))

  return {
    employees: withEvents,
    totals: {
      events: withEvents.reduce((t, e) => t + e.events.length, 0),
      unresolved: withEvents.reduce((t, e) => t + e.unresolved_count, 0),
      conflicts: withEvents.reduce((t, e) => t + e.conflict_count, 0),
      policy_flagged_employees: withEvents.filter(e => e.policy_flag_dates.length > 0).length,
    },
  }
}

/**
 * Does the stored draft reflect this decision?
 *
 *   Paid / waived       the draft charges ₹0 for the event (a waiver, or no
 *                       charge at all). ₹0 because automatic paid leave or
 *                       BOE Credits absorbed it also counts as not deducted —
 *                       and the event says which it was.
 *   Unpaid actual time  no correction waives it; the engine's normal charge
 *                       (which its automatic paid-leave rule may still absorb)
 *                       stands.
 */
export function draftMatchesDecision(ev: Pick<ReconEvent, 'draft_amount' | 'waived_by_correction'>, decision: PayDecision): boolean {
  if (ev.draft_amount == null) return false
  if (decision === 'paid_waived') return ev.waived_by_correction || ev.draft_amount === 0
  if (decision === 'unpaid_actual') return !ev.waived_by_correction
  return false
}

function settleSalaryStatus(ev: ReconEvent, draftGenerated: boolean): void {
  const d = ev.decision?.pay_decision ?? null
  let status: SalaryStatus
  let note: string | null = null
  if (ev.upcoming) status = 'upcoming'
  else if (!ev.decision || d == null) status = 'needs_decision'
  else if (ev.stale) { status = 'stale'; note = `Review again: ${ev.stale_reasons.join(' ')}` }
  else if (d === 'needs_correction') status = 'needs_correction'
  else if (!draftGenerated) { status = 'no_draft'; note = 'Generate the payroll draft; the decision is then checked against it.' }
  else if (draftMatchesDecision(ev, d)) status = 'resolved'
  else {
    status = 'action_required'
    note = d === 'paid_waived'
      ? `Action required in payroll: the draft still deducts ₹${Math.round(ev.draft_amount ?? 0)}.`
      : 'Action required in payroll: an attendance correction still waives this charge.'
    note += ev.applies_in_one_step
      ? ' Save the decision again to apply it through the attendance correction.'
      : ` ${ev.one_step_blocker ?? ''} Open the payslip to correct the day.`
  }
  ev.salary_status = status
  ev.action_note = note
  ev.resolved = status === 'resolved'
}

// ─── Review → correction ─────────────────────────────────────────────────────

export type ReviewApplication =
  /** The draft already reflects the decision; nothing to write. */
  | { kind: 'none' }
  /** Apply this correction through the attendance-correction path. */
  | { kind: 'apply'; correction: ValidatedCorrection }
  /** Cannot be applied in one step; the reviewer must act on the payslip. */
  | { kind: 'action_required'; reason: string }

/**
 * The correction that makes payroll honour a Paid / waived or Unpaid actual
 * decision, built on the day's CURRENT state so nothing else changes:
 *
 *   - the current correction's punches, day treatment and other waivers are
 *     carried over (a new version supersedes it; history is kept);
 *   - with no correction, the raw punches are copied verbatim — only when both
 *     are present or the direction was confirmed, because a correction makes
 *     the direction 'confirmed', and confirming a GUESSED lone punch could
 *     create a late-arrival charge that did not exist before;
 *   - only the one waiver flag that settles this event changes.
 *
 * Returns `none` when the day already carries the requested waiver state, so
 * saving twice never writes a second correction or a second waiver.
 */
export function planReviewApplication(
  ev: Pick<ReconEvent, 'event_key' | 'date' | 'day_state' | 'one_step_blocker'> &
    Partial<Pick<ReconEvent, 'draft_amount' | 'waived_by_correction'>>,
  decision: PayDecision | null,
  remark: string,
): ReviewApplication {
  if (decision !== 'paid_waived' && decision !== 'unpaid_actual') return { kind: 'none' }
  const field = WAIVER_FIELD[ev.event_key]
  const corr = ev.day_state.correction
  const want = decision === 'paid_waived'

  // Events without a waiver of their own (absence, half day, leave, time out)
  // need nothing when the draft already agrees — e.g. "no deduction" for a
  // time out the draft never charged. Otherwise they are settled on the payslip.
  const alreadyMatches = ev.draft_amount != null &&
    draftMatchesDecision({ draft_amount: ev.draft_amount, waived_by_correction: !!ev.waived_by_correction }, decision)
  if (!field || (corr && corr.day_treatment !== 'auto')) {
    return alreadyMatches
      ? { kind: 'none' }
      : { kind: 'action_required', reason: ev.one_step_blocker ?? 'This event is settled on the payslip.' }
  }

  const current = corr ? !!corr[field] : false
  if (current === want) return { kind: 'none' }

  const raw = ev.day_state.raw
  if (!corr) {
    if (!raw) return { kind: 'action_required', reason: 'There is no attendance record to correct.' }
    if (!raw.direction_confirmed) return { kind: 'action_required', reason: ev.one_step_blocker ?? 'Punch direction was guessed.' }
  }

  return {
    kind: 'apply',
    correction: {
      attendance_date: ev.date,
      corrected_check_in_at:  corr ? corr.corrected_check_in_at  : raw!.check_in_at,
      corrected_check_out_at: corr ? corr.corrected_check_out_at : raw!.check_out_at,
      day_treatment: 'auto',
      waive_late_arrival:   field === 'waive_late_arrival'   ? want : !!corr?.waive_late_arrival,
      waive_early_checkout: field === 'waive_early_checkout' ? want : !!corr?.waive_early_checkout,
      waive_missing_punch:  field === 'waive_missing_punch'  ? want : !!corr?.waive_missing_punch,
      remark,
    },
  }
}

// ─── Review input ────────────────────────────────────────────────────────────

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
