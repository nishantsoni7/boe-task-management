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

// ─── Naming the thing an issue is about ──────────────────────────────────────

export type IssueSubjectKind = 'attendance' | 'payroll'

export function issueSubjectKind(
  o: Pick<ObjectionRow, 'attendance_date' | 'payroll_result_id'>,
): IssueSubjectKind | null {
  if (o.attendance_date)   return 'attendance'
  if (o.payroll_result_id) return 'payroll'
  return null
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * "21 Jul 2026" or "07/2026" — the record the issue disputes, in one phrase.
 *
 * The payroll half is read back out of the snapshot rather than out of a join:
 * a payroll result is DELETED when its period is regenerated, so the period the
 * employee was looking at survives only in the text captured at submission.
 * That is precisely what the snapshot column is for.
 *
 * The date is formatted from its parts, never through `new Date(...)` in local
 * time — an employee abroad must not see 20 July on their 21 July issue.
 */
export function issueSubjectLabel(
  o: Pick<ObjectionRow, 'attendance_date' | 'payroll_result_id' | 'subject_snapshot'>,
): string {
  if (o.attendance_date) {
    const [y, m, d] = o.attendance_date.split('-').map(Number)
    const month = SHORT_MONTHS[m - 1]
    return month ? `${String(d).padStart(2, '0')} ${month} ${y}` : o.attendance_date
  }
  if (o.payroll_result_id) {
    const first = (o.subject_snapshot ?? '').split(' · ')[0]?.trim()
    return first && first !== 'period unknown' ? first : 'Payroll period'
  }
  return '—'
}

// ─── Raising again after a decision ──────────────────────────────────────────
//
// The database has always allowed this: the two partial unique indexes in
// 20260823000000 key on `status = 'pending'`, so exactly one OPEN issue per
// target is enforced and a reviewed one blocks nothing. What did not allow it
// was the UI — every screen tested "is there an objection for this row?" and,
// finding a rejected one from three weeks ago, replaced Raise Issue with a
// permanent badge. An employee who disagreed with the outcome had no way back.
//
// So the predicate is the DATABASE's rule, restated once here rather than
// re-derived per screen: only a pending issue closes the door.

/**
 * May the employee raise an issue against this target right now?
 *
 * `current` is the NEWEST issue for the target, or undefined when there has
 * never been one. A pending issue is the only thing that stops another.
 */
export function canRaiseIssue(current: { status: ObjectionStatus } | null | undefined): boolean {
  return !current || current.status !== 'pending'
}

/**
 * The label for that action, so a re-raise never reads as a first report.
 *
 * Naming the repeat differently matters: "Raise Issue" beside a Rejected badge
 * looks like the badge is stale, whereas "Raise Again" says plainly that the
 * previous decision stands and this is a new submission.
 */
export function raiseActionLabel(current: { status: ObjectionStatus } | null | undefined): string {
  return current ? 'Raise Again' : 'Raise Issue'
}

// ─── The chain: one target, every attempt ────────────────────────────────────
//
// A re-raise deliberately creates a NEW row and never touches the old one —
// there is no UPDATE policy on the table at all, so the previous decision is
// physically incapable of being rewritten. That makes "the history of this
// issue" a derived thing: the rows sharing a target, read in order.
//
// No parent_id column, on purpose. The target IS the relationship — an
// attendance objection is keyed by (employee, date) and a payroll one by
// (employee, result) — so a foreign key back to the previous attempt would be a
// second, weaker statement of the same fact, and one that could disagree.

/** The target a chain is keyed by, or null for a row naming neither. */
export function issueChainKey(o: Pick<ObjectionRow, 'attendance_date' | 'payroll_result_id' | 'employee_id'>): string | null {
  if (o.attendance_date)   return `${o.employee_id}|date|${o.attendance_date}`
  if (o.payroll_result_id) return `${o.employee_id}|result|${o.payroll_result_id}`
  return null
}

/**
 * Every issue grouped by the thing it disputes, each chain OLDEST FIRST.
 *
 * Input order does not matter: chains are sorted by `created_at` here, so a
 * caller may pass the API's newest-first list or anything else.
 */
export function groupIssueChains<T extends ObjectionRow>(rows: readonly T[]): Map<string, T[]> {
  const chains = new Map<string, T[]>()
  for (const o of rows) {
    const key = issueChainKey(o)
    if (!key) continue
    const existing = chains.get(key)
    if (existing) existing.push(o)
    else chains.set(key, [o])
  }
  for (const chain of chains.values()) {
    chain.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
  }
  return chains
}

// The newest issue of a chain is simply its last element, and the screens read
// it that way. There is deliberately no `latestOfChains()` helper: the badges
// already have `objectionsByAttendanceDate` / `byResult` above, which index the
// API's newest-first list directly, and a second way to say "the current one"
// is a second thing that can disagree with the first.

// ─── History ─────────────────────────────────────────────────────────────────

export type IssueEventKind = 'raised' | 're_raised' | 'approved' | 'rejected'

export type IssueEvent = {
  /** Stable within one chain — the row id plus the event's own name. */
  key: string
  kind: IssueEventKind
  at: string
  /** Who did it, in the reader's terms. */
  actor: string
  title: string
  /** What was said — the employee's reason, or the admin's note. */
  body: string | null
  /** The record as it stood when the issue was raised. Only on a raise. */
  snapshot: string | null
  /** 1-based position of this attempt in the chain. */
  attempt: number
}

/**
 * The complete interaction trail for one chain, oldest first.
 *
 * Every row contributes its own submission, and its decision when it has one.
 * Nothing is merged and nothing is dropped: a chain of three attempts with two
 * decisions produces five events, and the second attempt is labelled as a
 * re-raise so the relationship between them is visible rather than inferred.
 *
 * `reviewerLabel` exists because an employee's own copy of the list does not
 * carry the reviewer's name — the API gives a non-admin their own columns and
 * no joins at all, deliberately — so the actor there is the role, not a person.
 */
export function buildIssueHistory(
  chain: readonly ObjectionRow[],
  { employeeLabel = 'Employee', reviewerLabel = 'Administrator' }: {
    employeeLabel?: string
    reviewerLabel?: string
  } = {},
): IssueEvent[] {
  const events: IssueEvent[] = []

  chain.forEach((o, i) => {
    const attempt = i + 1
    events.push({
      key:      `${o.id}:raised`,
      kind:     attempt === 1 ? 'raised' : 're_raised',
      at:       o.created_at,
      actor:    employeeLabel,
      title:    attempt === 1 ? 'Issue raised' : `Issue raised again (attempt ${attempt})`,
      body:     o.reason,
      snapshot: o.subject_snapshot,
      attempt,
    })

    if (o.status === 'pending') return

    events.push({
      key:      `${o.id}:${o.status}`,
      kind:     o.status,
      at:       o.reviewed_at ?? o.created_at,
      actor:    reviewerLabel,
      title:    o.status === 'approved' ? 'Resolved by admin' : 'Rejected by admin',
      body:     o.review_note,
      snapshot: null,
      attempt,
    })
  })

  return events
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
