// Employee objections — the rules an objection obeys, in one place.
//
// An objection is a report, never a change. Nothing here computes or alters an
// amount; the snapshot builders below only DESCRIBE what the employee was
// looking at, so a reviewed objection still reads sensibly after an admin has
// corrected the underlying day. The correction itself stays in the existing
// admin workflow.
//
// Kept free of Supabase and React so both the API routes and the screens agree
// on what a valid objection is without either owning the definition.

export const OBJECTION_STATUSES = ['pending', 'approved', 'rejected'] as const
export type ObjectionStatus = (typeof OBJECTION_STATUSES)[number]

export const REVIEWABLE_STATUSES = ['approved', 'rejected'] as const
export type ReviewableStatus = (typeof REVIEWABLE_STATUSES)[number]

/** Long enough to explain a disputed day, short enough not to be an essay. */
export const REASON_MAX_LENGTH = 500

export type ObjectionRow = {
  id: string
  employee_id: string
  attendance_date: string | null
  payroll_result_id: string | null
  reason: string
  subject_snapshot: string
  status: ObjectionStatus
  reviewed_by: string | null
  reviewed_at: string | null
  review_note: string | null
  created_at: string
}

// ─── Where an admin reviews one ──────────────────────────────────────────────
//
// A payroll objection is reviewed on the payslip it disputes, not on a list of
// complaints: the figures, the employee's reason and Resolve/Reject are one
// screen. That screen is keyed by (period, employee), and an objection only
// stores payroll_result_id — so the pair is read back through the result, by
// the server, in /api/objections. Nothing here accepts a route from a caller.

/** The query parameter a payroll-issue notification lands on, on /payroll. */
export const ISSUE_PARAM = 'issue'

/** An objection as the admin list returns it, with its result's route keys. */
export type AdminObjectionRow = ObjectionRow & {
  employee?: { full_name?: string | null; employee_code?: string | null } | null
  payroll_result?:
    | { payroll_period_id: string | null; employee_id: string | null }
    | { payroll_period_id: string | null; employee_id: string | null }[]
    | null
}

/**
 * The admin review route for a payroll objection, or null when this is not one
 * (an attendance objection) or the result it named no longer exists.
 *
 * Null is a real answer, not a failure: a payroll result is deleted when a
 * period is regenerated, and a link to a payslip that is gone is worse than no
 * link at all.
 */
export function payrollObjectionHref(o: AdminObjectionRow): string | null {
  if (!o.payroll_result_id) return null
  // PostgREST returns a to-one embed as an object, but types it as either.
  const r = Array.isArray(o.payroll_result) ? o.payroll_result[0] : o.payroll_result
  if (!r?.payroll_period_id || !r?.employee_id) return null
  return `/payroll/results/${r.payroll_period_id}/${r.employee_id}`
}

// ─── Matching an objection to the row it belongs on ──────────────────────────
//
// An attendance objection is keyed by DATE, and a date is not a person. Every
// employee has an 11 July, so "the objection for 11 July" is only a sentence
// once you have said whose 11 July — and the self-service screen had not.
//
// It looked correct because /api/objections pins a non-admin to their own rows,
// so for an ordinary employee the list already contained nobody else. An ADMIN
// gets the company-wide queue from that same endpoint, and their own
// /my-attendance then borrowed a colleague's badge for any date they shared:
// one employee's pending issue on 11 July appeared as "Issue Pending" on the
// admin's own 11 July row, which is a false statement about the admin's record.
//
// Fixed HERE rather than in the API, because the admin queue legitimately needs
// every employee's objections — it is the screen that reviews them. What was
// wrong was reading a company-wide list as if it were a personal one.
//
// The payroll half never had this: it keys on payroll_result_id, and a result
// belongs to exactly one employee, so a colleague's objection can never match a
// row on your own payslip list.

/**
 * The viewer's OWN attendance objections, in the order given.
 *
 * Both halves of the rule are load-bearing: the employee id is what stops a
 * colleague's issue appearing, and `attendance_date` is what keeps payroll
 * objections out of a list of days. An empty viewer id yields nothing rather
 * than everything — an unknown viewer must not inherit the whole company's.
 */
export function ownAttendanceObjections<
  T extends { employee_id: string; attendance_date: string | null },
>(rows: readonly T[], employeeId: string): T[] {
  if (!employeeId) return []
  return rows.filter(o => !!o.attendance_date && o.employee_id === employeeId)
}

/**
 * Newest objection per attendance date, for the row badges.
 *
 * Expects rows already newest-first (the API orders by created_at desc), so the
 * first hit for a date is the current one. Scope this to one employee with
 * ownAttendanceObjections() first — this function knows nothing about whose
 * days it is indexing.
 */
export function objectionsByAttendanceDate<T extends { attendance_date: string | null }>(
  rows: readonly T[],
): Map<string, T> {
  const byDate = new Map<string, T>()
  for (const o of rows) {
    if (o.attendance_date && !byDate.has(o.attendance_date)) byDate.set(o.attendance_date, o)
  }
  return byDate
}

export function isObjectionStatus(v: unknown): v is ObjectionStatus {
  return typeof v === 'string' && (OBJECTION_STATUSES as readonly string[]).includes(v)
}

export function isReviewableStatus(v: unknown): v is ReviewableStatus {
  return typeof v === 'string' && (REVIEWABLE_STATUSES as readonly string[]).includes(v)
}

// ─── What the employee sees ──────────────────────────────────────────────────

/**
 * The status in the employee's own terms.
 *
 * "Approved" is deliberately shown as "Resolved": from where the employee
 * stands the useful fact is that an admin has dealt with it, and "approved"
 * invites the reading that a specific amount was agreed — which reviewing an
 * objection never decides.
 */
export function employeeStatusLabel(status: ObjectionStatus): string {
  switch (status) {
    case 'pending':  return 'Issue Pending'
    case 'approved': return 'Resolved'
    case 'rejected': return 'Rejected'
  }
}

export function statusTone(status: ObjectionStatus): { bg: string; fg: string } {
  switch (status) {
    case 'pending':  return { bg: 'rgba(232,160,48,0.15)', fg: '#B45309' }
    case 'approved': return { bg: 'rgba(16,185,129,0.12)', fg: '#059669' }
    case 'rejected': return { bg: 'rgba(140,148,166,0.14)', fg: '#6B7280' }
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

export type ObjectionTarget =
  | { kind: 'attendance'; attendanceDate: string }
  | { kind: 'payroll';    payrollResultId: string }

export type ValidationFailure = { ok: false; message: string }
export type ValidationSuccess = { ok: true; reason: string; target: ObjectionTarget }
export type ValidationResult   = ValidationSuccess | ValidationFailure

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Exactly one target and a real reason, decided before anything touches the
 * database. Mirrors the table's own CHECK constraints so a bad request comes
 * back as a 400 the employee can act on rather than a constraint violation.
 */
export function validateObjectionInput(input: {
  attendance_date?: unknown
  payroll_result_id?: unknown
  reason?: unknown
}): ValidationResult {
  const rawReason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (!rawReason) {
    return { ok: false, message: 'Please describe what looks wrong.' }
  }
  if (rawReason.length > REASON_MAX_LENGTH) {
    return { ok: false, message: `Please keep this under ${REASON_MAX_LENGTH} characters.` }
  }

  const date     = typeof input.attendance_date === 'string'   ? input.attendance_date.trim()   : ''
  const resultId = typeof input.payroll_result_id === 'string' ? input.payroll_result_id.trim() : ''

  if (!!date === !!resultId) {
    return { ok: false, message: 'An objection must name exactly one attendance date or one payroll result.' }
  }

  if (date) {
    if (!ISO_DATE.test(date)) {
      return { ok: false, message: 'Invalid attendance date.' }
    }
    return { ok: true, reason: rawReason, target: { kind: 'attendance', attendanceDate: date } }
  }

  return { ok: true, reason: rawReason, target: { kind: 'payroll', payrollResultId: resultId } }
}

// ─── Snapshots ───────────────────────────────────────────────────────────────
//
// Composed on the SERVER from the employee's own record. Never accepted from
// the browser: a client-supplied snapshot would let an employee write any
// salary figure they liked into a row an admin later reads as fact.

function money(n: number | null | undefined): string {
  if (n == null) return '—'
  return '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function attendanceSnapshot(day: {
  attendance_date: string
  check_in_at: string | null
  check_out_at: string | null
  effective_status: string
  clock: (instant: string) => string
}): string {
  const inAt  = day.check_in_at  ? day.clock(day.check_in_at)  : 'no punch-in'
  const outAt = day.check_out_at ? day.clock(day.check_out_at) : 'no punch-out'
  return `${day.attendance_date} · ${inAt} → ${outAt} · ${day.effective_status}`
}

export function payrollSnapshot(result: {
  payroll_month: number | null
  payroll_year: number | null
  gross_salary: number | null
  total_deductions: number | null
  net_salary: number | null
}): string {
  const period = result.payroll_month && result.payroll_year
    ? `${String(result.payroll_month).padStart(2, '0')}/${result.payroll_year}`
    : 'period unknown'
  return [
    period,
    `gross ${money(result.gross_salary)}`,
    `deductions ${money(result.total_deductions)}`,
    `net ${money(result.net_salary)}`,
  ].join(' · ')
}
