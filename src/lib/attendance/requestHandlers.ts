// The /api/attendance-requests handlers, as functions of an already-resolved
// caller. The route files resolve the caller from the bearer token and call
// these; tests call them with a caller and an in-memory database.
//
// AUTHORISATION LIVES HERE, not in the route files, so the tests exercise it:
//
//   employee   own requests only; the employee is always caller.id — there is
//              no employee id in any body or query to aim at somebody else
//   admin      the queue, decisions and the payroll review; never on their
//              OWN request or attendance (another admin must decide it)
//
// Every route runs on the service role, so these checks ARE the boundary.
// RLS in 20270215000000 says the same again for any direct PostgREST client.

import type { Caller, ServiceClient } from '@/lib/security/attendancePayrollApiAuth'
import {
  REQUEST_COLUMNS,
  NOTE_MAX_LENGTH,
  validateRequestInput,
  validateDecision,
  shiftStartUtc,
  isInformedBeforeShift,
  informedForCorrection,
  findConflict,
  conflictMessage,
  isRecentTwin,
  canEmployeeCancel,
  canEmployeeCorrect,
  type AttendanceRequestRow,
} from './requests'
import {
  buildReconciliation,
  validateReviewInput,
  planReviewApplication,
  PAY_DECISION_LABEL,
  type ReconAttendance,
  type ReconCorrection,
  type ReconDraftLine,
  type ReconEmployee,
  type ReconReview,
  type ReconRedemption,
} from './requestReconciliation'
import { currentShiftWindow, notifyAdminsOfRequest, notifyEmployeeOfDecision, requestDbError } from './requestsServer'
import { fetchHolidaysForPeriod, fetchActiveAttendanceRedemptionsByEmployee } from '@/lib/payroll/store'
import { fetchActiveSettings, settingsForPeriod } from '@/lib/payroll/settingsStore'
import { onlyParticipating } from '@/lib/payroll/participation'
import { periodLockStateByMonth, isLocked } from '@/lib/payroll/lockGuard'
import { applyAttendanceCorrection } from '@/lib/payroll/attendanceCorrectionService'
import { fetchAllRows, unwrapPagedRows } from '@/lib/supabasePaging'
import { istToday } from '@/lib/istDate'

export type HandlerResult = { status: number; body: Record<string, unknown> }
const ok = (body: Record<string, unknown>, status = 200): HandlerResult => ({ status, body })
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): HandlerResult =>
  ({ status, body: { error, ...extra } })
const FORBIDDEN = () => fail(403, 'Forbidden')

const WITH_DECIDER = `${REQUEST_COLUMNS}, decider:users!attendance_requests_decided_by_fkey ( full_name )`

// ─── Self-decision ───────────────────────────────────────────────────────────

/**
 * An admin never decides their own request or reviews their own attendance.
 * When no other active admin exists the answer is still no — the operational
 * limitation is named instead of bypassed.
 */
async function selfDecisionRefusal(svc: ServiceClient, callerId: string, what: string): Promise<HandlerResult> {
  const { data } = await svc.from('users').select('id').eq('role', 'admin').eq('is_active', true)
  const others = ((data ?? []) as { id: string }[]).filter(u => u.id !== callerId).length
  return fail(403, others > 0
    ? `Another admin must decide ${what} — you cannot decide your own.`
    : `You are the only active admin, and nobody may decide ${what} for themselves. ` +
      'Add a second admin in Control Center, or settle it outside BOE and record the outcome there.',
    { self_decision: true, other_admins: others })
}

// ─── Requests ────────────────────────────────────────────────────────────────

export async function listRequests(caller: Caller, scope: string | null, status: string | null): Promise<HandlerResult> {
  if (scope !== 'queue') {
    const { data, error } = await caller.svc
      .from('attendance_requests')
      .select(WITH_DECIDER)
      .eq('employee_id', caller.id)
      .order('submitted_at', { ascending: false })
      .limit(100)
    if (error) return fail(500, error.message)
    return ok({ requests: data ?? [] })
  }

  if (!caller.isAdmin) return FORBIDDEN()

  const filter = status ?? 'pending'
  let query = caller.svc
    .from('attendance_requests')
    .select(`${WITH_DECIDER}, employee:users!attendance_requests_employee_id_fkey ( full_name, employee_code, is_active )`)
    .order('submitted_at', { ascending: filter === 'pending' })
    .limit(200)
  if (filter !== 'all') query = query.eq('status', filter)

  const { data, error } = await query
  if (error) return fail(500, error.message)
  const rows = (data ?? []) as unknown as AttendanceRequestRow[]

  // Actual punches for each request's first date, in ONE read — never per row.
  const punches: Record<string, { check_in_at: string | null; check_out_at: string | null; corrected: boolean }> = {}
  if (rows.length > 0) {
    const ids = [...new Set(rows.map(r => r.employee_id))]
    const dates = rows.map(r => r.start_date).sort()
    const [att, corr] = await Promise.all([
      caller.svc.from('attendance_records')
        .select('user_id, attendance_date, check_in_at, check_out_at')
        .in('user_id', ids).gte('attendance_date', dates[0]).lte('attendance_date', dates[dates.length - 1]),
      caller.svc.from('attendance_day_corrections')
        .select('user_id, attendance_date, corrected_check_in_at, corrected_check_out_at')
        .eq('is_current', true)
        .in('user_id', ids).gte('attendance_date', dates[0]).lte('attendance_date', dates[dates.length - 1]),
    ])
    for (const a of (att.data ?? []) as { user_id: string; attendance_date: string; check_in_at: string | null; check_out_at: string | null }[])
      punches[`${a.user_id}|${a.attendance_date}`] = { check_in_at: a.check_in_at, check_out_at: a.check_out_at, corrected: false }
    for (const c of (corr.data ?? []) as { user_id: string; attendance_date: string; corrected_check_in_at: string | null; corrected_check_out_at: string | null }[])
      punches[`${c.user_id}|${c.attendance_date}`] = { check_in_at: c.corrected_check_in_at, check_out_at: c.corrected_check_out_at, corrected: true }
  }

  const shift = await currentShiftWindow(caller.svc)
  return ok({ requests: rows, punches, shift, viewer_id: caller.id })
}

export async function submitRequest(caller: Caller, body: Record<string, unknown> | null, now: string): Promise<HandlerResult> {
  if (!body) return fail(400, 'Invalid JSON body')

  const { data: me } = await caller.svc.from('users').select('full_name, is_active').eq('id', caller.id).maybeSingle()
  if (!me?.is_active) return fail(403, 'Your account is not active.')

  const shift = await currentShiftWindow(caller.svc)
  const validation = validateRequestInput(body, istToday(new Date(now)), shift)
  if (!validation.ok) return fail(400, validation.error)
  const input = validation.value

  // Correction of an existing request — own only.
  const replacesId = typeof body.replaces_request_id === 'string' && body.replaces_request_id ? body.replaces_request_id : null
  let original: AttendanceRequestRow | null = null
  if (replacesId) {
    const { data } = await caller.svc.from('attendance_requests').select(REQUEST_COLUMNS)
      .eq('id', replacesId).eq('employee_id', caller.id).maybeSingle()
    // Same answer whether it is a colleague's request or nobody's.
    if (!data) return fail(404, 'Request not found.')
    original = data as unknown as AttendanceRequestRow

    // A retry of a correction that already went through: the original is now
    // closed, so look for the replacement it produced.
    const { data: replacement } = await caller.svc.from('attendance_requests').select(REQUEST_COLUMNS)
      .eq('replaces_request_id', replacesId).eq('employee_id', caller.id).maybeSingle()
    if (replacement && isRecentTwin(input, replacement as unknown as AttendanceRequestRow, now))
      return ok({ request: replacement, duplicate: true })

    if (!canEmployeeCorrect(original, now)) return fail(409, 'This request can no longer be corrected. Ask an admin.')
  }

  // Duplicates and overlaps against the employee's own live requests.
  const { data: existing, error: exErr } = await caller.svc
    .from('attendance_requests')
    .select(REQUEST_COLUMNS)
    .eq('employee_id', caller.id)
    .in('status', ['pending', 'approved'])
    .lte('start_date', input.end_date)
    .gte('end_date', input.start_date)
  if (exErr) return fail(500, exErr.message)
  const live = (existing ?? []) as unknown as AttendanceRequestRow[]

  // Double tap, or a retry after a lost response: the same request, sent moments
  // ago and still pending, is answered with itself — no second row, no second
  // notification.
  const twin = replacesId ? null : live.find(r => isRecentTwin(input, r, now))
  if (twin) return ok({ request: twin, duplicate: true })

  const conflict = findConflict(input, live, replacesId)
  if (conflict) return fail(409, conflictMessage(conflict as AttendanceRequestRow), { conflict_id: conflict.id })

  const shiftStartAt = shiftStartUtc(input.start_date, shift)
  const informed = original
    ? informedForCorrection(original, input, now, shift)
    : isInformedBeforeShift(now, shiftStartAt)

  const { data, error } = await caller.svc
    .from('attendance_requests')
    .insert({
      ...input,
      employee_id: caller.id,
      shift_start_at: shiftStartAt,
      informed_before_shift: informed,
      replaces_request_id: replacesId,
      updated_by: caller.id,
    })
    .select(REQUEST_COLUMNS)
    .single()

  if (error?.code === '23505' && !replacesId) {
    // Two identical requests raced past the check above; the database refused
    // the second (attendance_requests_live_* indexes). Answer with the winner.
    const { data: winners } = await caller.svc.from('attendance_requests').select(REQUEST_COLUMNS)
      .eq('employee_id', caller.id).in('status', ['pending', 'approved'])
      .lte('start_date', input.end_date).gte('end_date', input.start_date)
    const rows = (winners ?? []) as unknown as AttendanceRequestRow[]
    const raced = rows.find(r => isRecentTwin(input, r, now))
    if (raced) return ok({ request: raced, duplicate: true })
    const other = findConflict(input, rows, null)
    if (other) return fail(409, conflictMessage(other as AttendanceRequestRow), { conflict_id: other.id })
  }

  if (error || !data) {
    const mapped = requestDbError(error?.message ?? 'unknown error')
    return fail(mapped.status, mapped.error)
  }
  const row = data as unknown as AttendanceRequestRow
  await notifyAdminsOfRequest(caller.svc, row, (me.full_name as string | null) ?? null, !!replacesId)
  return ok({ request: row }, 201)
}

export async function cancelRequest(caller: Caller, id: string, body: Record<string, unknown>, now: string): Promise<HandlerResult> {
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, NOTE_MAX_LENGTH) : ''

  const { data } = await caller.svc.from('attendance_requests').select(REQUEST_COLUMNS)
    .eq('id', id).eq('employee_id', caller.id).maybeSingle()
  if (!data) return fail(404, 'Request not found.')
  const row = data as unknown as AttendanceRequestRow

  if (!canEmployeeCancel(row, now)) return fail(409, 'This request can no longer be cancelled. Ask an admin.')

  const { data: updated, error } = await caller.svc.from('attendance_requests')
    .update({
      status: 'cancelled',
      cancelled_at: now,
      cancel_reason: reason || 'Cancelled by the employee',
      updated_by: caller.id,
    })
    .eq('id', id)
    .eq('status', row.status)   // lost race with a decision → no row, 409 below
    .select(REQUEST_COLUMNS)
    .maybeSingle()

  if (error) {
    const mapped = requestDbError(error.message)
    return fail(mapped.status, mapped.error)
  }
  if (!updated) return fail(409, 'This request changed a moment ago. Reload and try again.')
  return ok({ request: updated })
}

export async function decideRequest(caller: Caller, id: string, body: Record<string, unknown>, now: string): Promise<HandlerResult> {
  if (!caller.isAdmin) return FORBIDDEN()

  const { data } = await caller.svc.from('attendance_requests').select(REQUEST_COLUMNS).eq('id', id).maybeSingle()
  if (!data) return fail(404, 'Request not found.')
  const current = data as unknown as AttendanceRequestRow

  if (current.employee_id === caller.id) return selfDecisionRefusal(caller.svc, caller.id, 'this request')

  const v = validateDecision(body, current.status)
  if (!v.ok) return fail(400, v.error)

  const { data: updated, error } = await caller.svc.from('attendance_requests')
    .update({
      status: v.value.status,
      decided_by: caller.id,
      decided_at: now,
      decision_note: v.value.note,
      updated_by: caller.id,
    })
    .eq('id', id)
    .eq('status', current.status)
    .select(REQUEST_COLUMNS)
    .maybeSingle()

  if (error) {
    const mapped = requestDbError(error.message)
    return fail(mapped.status, mapped.error)
  }
  if (!updated) return fail(409, 'This request was changed by someone else a moment ago. Reload.')

  await notifyEmployeeOfDecision(caller.svc, updated as unknown as AttendanceRequestRow)
  return ok({ request: updated })
}

const MAX_CHAIN = 20

export async function requestHistory(caller: Caller, id: string): Promise<HandlerResult> {
  const ids: string[] = []
  let cursor: string | null = id
  let owner: string | null = null
  while (cursor && ids.length < MAX_CHAIN) {
    const res = await caller.svc.from('attendance_requests')
      .select('id, employee_id, replaces_request_id').eq('id', cursor).maybeSingle()
    const row = res.data as { id: string; employee_id: string; replaces_request_id: string | null } | null
    if (!row) break
    owner ??= row.employee_id
    ids.push(row.id)
    cursor = row.replaces_request_id
  }
  // Same 404 for "not yours" and "does not exist".
  if (!owner || (!caller.isAdmin && owner !== caller.id)) return fail(404, 'Request not found.')

  const { data, error } = await caller.svc.from('attendance_request_events')
    .select('id, request_id, action, status_from, status_to, note, created_at, actor:users!attendance_request_events_actor_id_fkey ( full_name )')
    .in('request_id', ids)
    .order('created_at', { ascending: true })
  if (error) return fail(500, error.message)
  return ok({ events: data ?? [] })
}

// ─── Payroll review ──────────────────────────────────────────────────────────

type RawAttendance = Omit<ReconAttendance, 'employee_id'> & { user_id: string }

function monthWindow(year: number, month: number) {
  const mm = String(month).padStart(2, '0')
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${String(last).padStart(2, '0')}` }
}

export function parseMonth(y: unknown, m: unknown): { year: number; month: number } | null {
  const year = Number(y), month = Number(m)
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 || year < 2020 || year > 2100) return null
  return { year, month }
}

/**
 * Everything the month review needs, in a fixed number of bulk reads — never
 * one round trip per employee or per row. Read-only.
 */
export async function loadReconciliation(svc: ServiceClient, year: number, month: number, today: string, onlyEmployee?: string) {
  const { start, end } = monthWindow(year, month)
  // Narrow a query to one employee when the POST re-derives a single event.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scope = (q: any, col: string): any => (onlyEmployee ? q.eq(col, onlyEmployee) : q)

  const [
    periodRes, active, holidays, redemptionsBy, employeesRes, requestsRes, reviewsRes, attendancePaged, correctionsRes,
  ] = await Promise.all([
    svc.from('payroll_periods').select('id, status, settings_snapshot')
      .eq('payroll_year', year).eq('payroll_month', month).maybeSingle(),
    fetchActiveSettings(svc),
    fetchHolidaysForPeriod(svc, month, year),
    fetchActiveAttendanceRedemptionsByEmployee(svc, month, year),
    // Same population payroll generation reads (fetchAllPayrollActiveEmployees).
    scope(onlyParticipating(svc.from('users')
      .select('id, full_name, employee_code, is_active, payroll_active, joining_date'))
      .or('is_deleted.eq.false,is_deleted.is.null'), 'id'),
    // Requests touching the month, including ones that cross into it.
    scope(svc.from('attendance_requests').select(REQUEST_COLUMNS)
      .lte('start_date', end).gte('end_date', start), 'employee_id'),
    scope(svc.from('attendance_day_reviews')
      .select('id, employee_id, attendance_date, event_key, excused, excuse_reason, pay_decision, decision_reason, attendance_fingerprint, reviewed_by, reviewed_at, applied_correction_id')
      .eq('is_current', true).gte('attendance_date', start).lte('attendance_date', end), 'employee_id'),
    fetchAllRows<RawAttendance>((from, to) =>
      scope(svc.from('attendance_records')
        .select('user_id, attendance_date, check_in_at, check_out_at, punch_direction_source')
        .gte('attendance_date', start).lte('attendance_date', end), 'user_id')
        .order('attendance_date').order('user_id').range(from, to)),
    scope(svc.from('attendance_day_corrections')
      .select('id, user_id, attendance_date, corrected_check_in_at, corrected_check_out_at, day_treatment, waive_late_arrival, waive_early_checkout, waive_missing_punch, remark')
      .eq('is_current', true).gte('attendance_date', start).lte('attendance_date', end), 'user_id'),
  ])

  for (const r of [periodRes, employeesRes, requestsRes, reviewsRes, correctionsRes]) {
    if (r.error) throw new Error(r.error.message)
  }
  const attendanceRows = unwrapPagedRows('attendance_records', attendancePaged)
  const period = periodRes.data as { id: string; status: string; settings_snapshot: unknown } | null
  // The rules the month's draft was (or will be) calculated with — so a
  // schedule change after generation marks decisions stale, not silently moves them.
  const settings = period
    ? settingsForPeriod(period as Parameters<typeof settingsForPeriod>[0], active.settings)
    : active.settings

  let draftLines: ReconDraftLine[] = []
  let draftGenerated = false
  if (period) {
    const resultsRes = await scope(svc.from('payroll_results').select('id, employee_id')
      .eq('payroll_period_id', period.id), 'employee_id')
    if (resultsRes.error) throw new Error(resultsRes.error.message)
    const results = (resultsRes.data ?? []) as { id: string; employee_id: string }[]
    draftGenerated = results.length > 0
    if (results.length > 0) {
      const empByResult = new Map(results.map(r => [r.id, r.employee_id]))
      const linesPaged = await fetchAllRows<{ payroll_result_id: string; line_date: string; deduction_type: string; hours_deducted: number; amount_deducted: number }>((from, to) =>
        svc.from('payroll_deduction_lines')
          .select('payroll_result_id, line_date, deduction_type, hours_deducted, amount_deducted')
          .in('payroll_result_id', results.map(r => r.id))
          .order('id').range(from, to))
      draftLines = unwrapPagedRows('payroll_deduction_lines', linesPaged).map(l => ({
        employee_id: empByResult.get(l.payroll_result_id)!,
        line_date: l.line_date,
        deduction_type: l.deduction_type,
        hours_deducted: Number(l.hours_deducted),
        amount_deducted: Number(l.amount_deducted),
      }))
    }
  }

  const requests = (requestsRes.data ?? []) as unknown as AttendanceRequestRow[]
  let employees = (employeesRes.data ?? []) as ReconEmployee[]
  // An employee outside payroll participation (or since deactivated) who still
  // filed a request this month must not vanish from the review.
  const known = new Set(employees.map(e => e.id))
  const missing = [...new Set(requests.map(r => r.employee_id))].filter(id => !known.has(id))
  if (missing.length > 0) {
    const extra = await svc.from('users').select('id, full_name, employee_code, is_active, payroll_active, joining_date').in('id', missing)
    if (extra.error) throw new Error(extra.error.message)
    employees = employees.concat((extra.data ?? []) as ReconEmployee[])
  }

  const attendance: ReconAttendance[] = attendanceRows.map(a => ({
    employee_id: a.user_id,
    attendance_date: a.attendance_date,
    check_in_at: a.check_in_at,
    check_out_at: a.check_out_at,
    punch_direction_source: a.punch_direction_source,
  }))
  const latest = attendance.reduce<string | null>((m, a) => (m == null || a.attendance_date > m ? a.attendance_date : m), null)
  const coverageThrough = latest && latest > today ? today : latest

  const corrections: ReconCorrection[] = ((correctionsRes.data ?? []) as (Omit<ReconCorrection, 'employee_id'> & { user_id: string })[])
    .map(c => ({ ...c, employee_id: c.user_id }))
  const redemptions: ReconRedemption[] = [...redemptionsBy.values()].flat()
    .filter(r => !onlyEmployee || r.employee_id === onlyEmployee)
    .map(r => ({ employee_id: r.employee_id, attendance_date: r.attendance_date, deduction_type: r.deduction_type, credits: r.credits }))

  const result = buildReconciliation({
    year, month, today, coverageThrough,
    schedule: {
      scheduled_in_minutes: settings.scheduled_in_minutes,
      grace_end_minutes: settings.grace_end_minutes,
      scheduled_out_minutes: settings.scheduled_out_minutes,
      weekly_off_day: settings.weekly_off_day,
      rounding_block_minutes: settings.rounding_block_minutes,
      rounding_block_hours: settings.rounding_block_hours,
    },
    holidayDates: new Set(holidays.filter(h => (h.holiday_type ?? 'full_day') === 'full_day').map(h => h.holiday_date)),
    draftGenerated,
    employees,
    attendance,
    corrections,
    requests,
    reviews: (reviewsRes.data ?? []) as ReconReview[],
    draftLines,
    redemptions,
  })

  return {
    result,
    period: period ? { id: period.id, status: period.status } : null,
    coverage_through: coverageThrough,
  }
}

export async function getReconciliation(caller: Caller, y: unknown, m: unknown, summary: boolean, today: string): Promise<HandlerResult> {
  if (!caller.isAdmin) return FORBIDDEN()
  const ym = parseMonth(y, m)
  if (!ym) return fail(400, 'year and month are required')

  try {
    const loaded = await loadReconciliation(caller.svc, ym.year, ym.month, today)
    if (summary) {
      // What the lock step shows: counts, no event detail.
      return ok({
        period: loaded.period,
        totals: loaded.result.totals,
        employees: loaded.result.employees
          .filter(e => e.unresolved_count > 0 || e.conflict_count > 0)
          .map(e => ({
            employee_id: e.employee.id,
            full_name: e.employee.full_name,
            unresolved: e.unresolved_count,
            conflicts: e.conflict_count,
          })),
      })
    }
    const reviewerIds = new Set<string>()
    for (const e of loaded.result.employees) for (const ev of e.events) {
      if (ev.decision) reviewerIds.add(ev.decision.reviewed_by)
      if (ev.request?.decided_by) reviewerIds.add(ev.request.decided_by)
    }
    let names: Record<string, string> = {}
    if (reviewerIds.size > 0) {
      const { data } = await caller.svc.from('users').select('id, full_name').in('id', [...reviewerIds])
      names = Object.fromEntries(((data ?? []) as { id: string; full_name: string | null }[]).map(u => [u.id, u.full_name ?? 'Admin']))
    }
    return ok({ ...loaded, reviewer_names: names, viewer_id: caller.id })
  } catch (e) {
    return fail(500, e instanceof Error ? e.message : String(e))
  }
}

/**
 * Record a review decision and, where the correction path supports it, make
 * payroll honour it in the same action.
 *
 *   1. admin, not their own attendance, month not locked
 *   2. re-derive the event from live data (the browser supplies only its key)
 *   3. plan the correction (planReviewApplication) and apply it through the
 *      SAME service POST /api/payroll/attendance-correction uses — versioned
 *      correction, BOE Credits coverage, regeneration, lock refusal
 *   4. only then record the decision, fingerprinted against the attendance as
 *      it now stands, with the correction it applied
 *
 * If step 3 fails nothing is recorded, so a decision can never claim an effect
 * payroll does not have. Where one step is impossible the decision is still
 * recorded and the event stays "Action required in payroll" until the draft
 * matches it.
 */
export async function saveReview(caller: Caller, body: Record<string, unknown> | null, today: string): Promise<HandlerResult> {
  if (!caller.isAdmin) return FORBIDDEN()
  if (!body) return fail(400, 'Invalid JSON body')
  const v = validateReviewInput(body)
  if (!v.ok) return fail(400, v.error)
  const input = v.value

  if (input.employee_id === caller.id) return selfDecisionRefusal(caller.svc, caller.id, 'your own attendance')

  const [year, month] = input.attendance_date.split('-').map(Number)

  // A locked month is closed. Changes after lock go through the existing
  // unlock / adjustment path, never through a review.
  const lock = await periodLockStateByMonth(caller.svc, month, year)
  if (isLocked(lock)) {
    return fail(422, 'This payroll month is locked. Use the existing unlock or adjustment path to change it.')
  }

  const findEvent = async () => {
    const loaded = await loadReconciliation(caller.svc, year, month, today, input.employee_id)
    const ev = loaded.result.employees
      .find(e => e.employee.id === input.employee_id)?.events
      .find(e => e.date === input.attendance_date && e.event_key === input.event_key)
    return { loaded, ev }
  }

  let found: Awaited<ReturnType<typeof findEvent>>
  try { found = await findEvent() }
  catch (e) { return fail(500, e instanceof Error ? e.message : String(e)) }
  if (!found.ev) return fail(404, 'That event is no longer on the record. Reload the review.')
  if (found.ev.upcoming) return fail(400, 'This date has not happened yet; review it once attendance exists.')
  if (input.pay_decision && !found.ev.allowed_decisions.includes(input.pay_decision)) {
    return fail(400, found.ev.request?.type === 'time_out'
      ? 'Actual time away is unavailable, so a deduction cannot be decided here. Record a correction on the payslip if one is intended.'
      : 'That salary treatment does not apply to this event.')
  }

  // ── Apply through the correction path ──────────────────────────────────────
  let appliedCorrectionId: string | null = null
  let applied: Record<string, unknown> | null = null
  const plan = planReviewApplication(
    found.ev,
    input.pay_decision,
    `Payroll review: ${input.pay_decision ? PAY_DECISION_LABEL[input.pay_decision] : ''} — ${input.decision_reason ?? ''}`.trim(),
  )
  if (plan.kind === 'apply') {
    if (!found.loaded.period) {
      return fail(409, 'Generate the payroll draft for this month first; the decision is applied to the draft.')
    }
    const outcome = await applyAttendanceCorrection(caller.svc, {
      periodId: found.loaded.period.id,
      employeeId: input.employee_id,
      correction: plan.correction,
      actorId: caller.id,
      today,
    })
    if (!outcome.ok) return fail(outcome.status, `The decision was not saved: ${outcome.error}`)
    appliedCorrectionId = outcome.correction_id
    applied = { correction_id: outcome.correction_id, before: outcome.before, after: outcome.after, net_salary: outcome.net_salary }
    // Fingerprint against the attendance as it now stands.
    try { found = await findEvent() }
    catch (e) { return fail(500, `The correction was applied, but the decision could not be recorded: ${String(e)}`) }
    if (!found.ev) return fail(500, 'The correction was applied, but the event could not be re-read to record the decision.')
  }

  const { data, error } = await caller.svc.from('attendance_day_reviews').insert({
    employee_id: input.employee_id,
    attendance_date: input.attendance_date,
    event_key: input.event_key,
    excused: input.excused,
    excuse_reason: input.excuse_reason,
    pay_decision: input.pay_decision,
    decision_reason: input.decision_reason,
    attendance_fingerprint: found.ev.fingerprint,
    reviewed_by: caller.id,
    applied_correction_id: appliedCorrectionId,
  }).select('id, reviewed_at').single()

  if (error) {
    const status = error.code === '23505' ? 409 : 500
    return fail(status, status === 409
      ? 'Someone else saved a decision a moment ago. Reload.'
      : (appliedCorrectionId
        ? `The correction was applied (payroll updated), but the decision could not be recorded: ${error.message}`
        : error.message))
  }
  return ok({
    review: data,
    application: plan.kind,
    action_required: plan.kind === 'action_required' ? plan.reason : null,
    applied,
  }, 201)
}
