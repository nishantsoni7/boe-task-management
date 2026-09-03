// GET  /api/objections            list — own for an employee, all for an admin
// POST /api/objections            file one against your OWN record
//
// One route for both subjects, because there is one table and therefore one
// isolation rule. Splitting it per module is how the rule ends up written twice
// and drifting apart — the mistake this branch already had to undo once.
//
// Service-role, like every other attendance/payroll route, so the identity
// check here IS the boundary. The RLS policies in
// 20260823000000_employee_record_objections.sql say the same thing again for
// any client that reaches PostgREST directly; neither is load-bearing alone.

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller, UNAUTHORIZED, type ServiceClient } from '@/lib/security/attendancePayrollApiAuth'
import {
  validateObjectionInput,
  attendanceSnapshot,
  payrollSnapshot,
  PERIOD_ID_PARAM,
  PERIOD_YEAR_PARAM,
  PERIOD_MONTH_PARAM,
} from '@/lib/objections'
import { istClockOf } from '@/lib/istDate'

const OBJECTION_COLUMNS =
  'id, employee_id, attendance_date, payroll_result_id, reason, subject_snapshot, ' +
  'status, reviewed_by, reviewed_at, review_note, created_at'

export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()

  // The admin queue needs a name to review against; an employee already knows
  // whose record it is, and asking for the join would only widen what the
  // response can carry.
  //
  // An admin also gets the payroll result's period and employee. That pair IS
  // the review route (/payroll/results/[periodId]/[employeeId]), and deriving it
  // HERE — from the objection's own foreign key, on the server — is what lets a
  // notification open the disputed result without any id travelling in from the
  // outside. `notifications.entity_id` is a single uuid column and carries the
  // objection; the route it resolves to is never taken from a URL.
  const columns = caller.isAdmin
    ? `${OBJECTION_COLUMNS}, employee:employee_id ( full_name, employee_code )` +
      ', payroll_result:payroll_result_id ( payroll_period_id, employee_id )'
    : OBJECTION_COLUMNS

  let query = caller.svc
    .from('employee_record_objections')
    .select(columns)
    .order('created_at', { ascending: false })

  // An admin may ask for the queue; anyone else is pinned to their own rows
  // whatever the query string says.
  if (!caller.isAdmin) {
    query = query.eq('employee_id', caller.id)
  } else {
    const employeeId = req.nextUrl.searchParams.get('employee_id')
    if (employeeId) query = query.eq('employee_id', employeeId)
  }

  const status = req.nextUrl.searchParams.get('status')
  if (status) query = query.eq('status', status)

  // Asking for one objection by id. Applied AFTER the ownership pin above, so
  // for a non-admin it can only ever narrow their own rows — an id belonging to
  // a colleague returns an empty list, not a 403, because the pin means the row
  // was never in the query to begin with.
  const id = req.nextUrl.searchParams.get('id')
  if (id) query = query.eq('id', id)

  // Narrowing to ONE payroll run.
  //
  // The screens that show reported payroll issues are each about a single
  // payroll period — the results page IS that run, and Monthly Preview is one
  // selected month — so the list they ask for has to be the run's, not the
  // company's whole history. Without this, a period generated in August showed
  // July's objections underneath August's salaries.
  //
  // The scope is resolved through the objection's own foreign key
  // (payroll_result_id → payroll_results.payroll_period_id) rather than by
  // comparing the month text in subject_snapshot: the snapshot is a display
  // string, and a run is a row. Nothing here consults the calendar.
  //
  // Applied AFTER the ownership pin above, so like the id filter it can only
  // ever narrow rows the caller already had.
  const scoped = await payrollResultIdsForPeriod(caller.svc, req)
  if (scoped !== null) {
    // No such period, or a period holding no results, means no payroll issue
    // can belong to it. An empty answer, not an error.
    if (scoped.length === 0) return NextResponse.json({ objections: [] })
    query = query.in('payroll_result_id', scoped)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ objections: data ?? [] })
}

export async function POST(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()

  const body = await req.json().catch(() => ({}))
  const parsed = validateObjectionInput(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.message }, { status: 400 })

  const { reason, target } = parsed
  const svc = caller.svc

  // The snapshot is built here, from this caller's own record. A snapshot sent
  // by the browser would let an employee write any salary figure they liked
  // into a row an admin later reads as a statement of fact.
  let snapshot: string
  let periodLabelForResult = 'this period'
  let insert: Record<string, unknown>

  if (target.kind === 'attendance') {
    const { data: rec } = await svc
      .from('attendance_records')
      .select('attendance_date, check_in_at, check_out_at, status')
      .eq('user_id', caller.id)
      .eq('attendance_date', target.attendanceDate)
      .maybeSingle()

    // A day with no row is an absence, not a missing date — and is exactly the
    // kind of day worth objecting to, so it is allowed through.
    snapshot = attendanceSnapshot({
      attendance_date:  target.attendanceDate,
      check_in_at:      rec?.check_in_at ?? null,
      check_out_at:     rec?.check_out_at ?? null,
      effective_status: rec?.status ?? 'absent',
      clock:            istClockOf,
    })
    insert = { employee_id: caller.id, attendance_date: target.attendanceDate, reason, subject_snapshot: snapshot }
  } else {
    // The month and year live on payroll_periods, not on the result — the
    // result only carries the period id. Embedding is what keeps the snapshot
    // honest without a second round trip.
    const { data: result, error: lookupErr } = await svc
      .from('payroll_results')
      .select('id, employee_id, gross_salary, total_deductions, net_salary, period:payroll_period_id ( payroll_month, payroll_year )')
      .eq('id', target.payrollResultId)
      .maybeSingle()

    // A broken query is not a refusal. Conflating the two would report a
    // schema error to the employee as "Forbidden", which is both untrue and
    // impossible to debug from the screen.
    if (lookupErr) {
      return NextResponse.json({ error: lookupErr.message }, { status: 500 })
    }

    // Ownership is checked before anything is written. Same flat 403 whether
    // the result belongs to a colleague or does not exist, so the response
    // cannot be used to probe for other people's payroll rows.
    if (!result || result.employee_id !== caller.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const period = (Array.isArray(result.period) ? result.period[0] : result.period) as
      { payroll_month: number | null; payroll_year: number | null } | null | undefined

    periodLabelForResult = period?.payroll_month && period?.payroll_year
      ? `${String(period.payroll_month).padStart(2, '0')}/${period.payroll_year}`
      : 'this period'

    snapshot = payrollSnapshot({
      payroll_month:    period?.payroll_month ?? null,
      payroll_year:     period?.payroll_year  ?? null,
      gross_salary:     result.gross_salary,
      total_deductions: result.total_deductions,
      net_salary:       result.net_salary,
    })
    insert = { employee_id: caller.id, payroll_result_id: target.payrollResultId, reason, subject_snapshot: snapshot }
  }

  const { data, error } = await svc
    .from('employee_record_objections')
    .insert(insert)
    .select(OBJECTION_COLUMNS)
    .single()

  if (error) {
    // The partial unique indexes are the duplicate rule; surfacing them as a
    // plain sentence beats a Postgres constraint name in a toast.
    if (error.code === '23505') {
      return NextResponse.json(
        { error: 'You already have an open issue for this. An admin will review it.' },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Tell the admins. Awaited so a failure is logged rather than lost in an
  // unhandled rejection, but never allowed to fail the objection itself — the
  // employee's report is already saved, and a notification problem must not
  // read to them as "your issue was not submitted".
  await notifyAdminsOfObjection(svc, {
    employeeId: caller.id,
    kind:       target.kind,
    subject:    target.kind === 'attendance' ? target.attendanceDate : periodLabelForResult,
    objectionId: (data as unknown as { id: string }).id,
  })

  return NextResponse.json({ objection: data }, { status: 201 })
}

/**
 * Every payroll_result id belonging to the payroll run the caller asked for, or
 * null when they asked for no particular run.
 *
 * Two ways in, one meaning. `payroll_period_id` is the run itself, used by the
 * period results page which already holds it. `payroll_year` + `payroll_month`
 * is the same run named the way Monthly Preview knows it, resolved through the
 * UNIQUE (payroll_month, payroll_year) constraint on payroll_periods — so a
 * month can never resolve to two runs.
 *
 * An empty array means "this run exists but holds no results, or does not exist
 * at all" — either way nothing can be scoped to it, which is a real answer.
 */
async function payrollResultIdsForPeriod(
  svc: ServiceClient,
  req: NextRequest,
): Promise<string[] | null> {
  const params   = req.nextUrl.searchParams
  const periodId = params.get(PERIOD_ID_PARAM)
  const year     = params.get(PERIOD_YEAR_PARAM)
  const month    = params.get(PERIOD_MONTH_PARAM)

  let resolvedPeriodId = periodId

  if (!resolvedPeriodId) {
    if (!year || !month) return null

    const y = Number.parseInt(year,  10)
    const m = Number.parseInt(month, 10)
    if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return []

    const { data: period } = await svc
      .from('payroll_periods')
      .select('id')
      .eq('payroll_year',  y)
      .eq('payroll_month', m)
      .maybeSingle()

    if (!period) return []
    resolvedPeriodId = period.id as string
  }

  const { data: results } = await svc
    .from('payroll_results')
    .select('id')
    .eq('payroll_period_id', resolvedPeriodId)

  return (results ?? []).map((r: { id: string }) => r.id)
}

/**
 * One notification per admin, of the type getNotificationMeta() knows how to
 * route: an attendance issue to the correction log, a payroll issue to the
 * disputed payslip itself.
 *
 * `entity_id` carries the OBJECTION id, which is what makes the payroll route
 * resolvable — /payroll trades it for the result's period and employee through
 * the GET above, so the payslip route is derived from the objection's own
 * foreign key rather than assembled from anything a caller supplied.
 *
 * Admins only. Attendance and payroll management is an admin surface (see
 * SELF_SERVICE_MODULE_KEYS), so anyone else receiving this would be told about
 * a record they cannot open.
 *
 * REQUIRES 20260824000000_objection_notification_types.sql. Until that is
 * applied the insert fails the enum check and is logged here; the objection is
 * unaffected.
 */
async function notifyAdminsOfObjection(
  svc: ServiceClient,
  { employeeId, kind, subject, objectionId }: {
    employeeId: string
    kind: 'attendance' | 'payroll'
    subject: string
    objectionId: string
  },
): Promise<void> {
  try {
    const [{ data: employee }, { data: admins }] = await Promise.all([
      svc.from('users').select('full_name').eq('id', employeeId).maybeSingle(),
      svc.from('users').select('id').eq('role', 'admin').eq('is_active', true),
    ])

    if (!admins?.length) return

    const who   = employee?.full_name ?? 'An employee'
    const what  = kind === 'attendance' ? 'an Attendance issue' : 'a Payroll issue'
    const title = `${who} raised ${what} for ${subject}`

    const { error } = await svc.from('notifications').insert(
      admins.map((a: { id: string }) => ({
        user_id:   a.id,
        type:      kind === 'attendance' ? 'attendance_issue_raised' : 'payroll_issue_raised',
        title,
        body:      'Open the record to read their reason and resolve or reject it.',
        entity_id: objectionId,
      })),
    )

    if (error) {
      console.error(`[objections] notification not delivered (${kind}):`, error.message)
    }
  } catch (e) {
    console.error('[objections] notification failed:', e)
  }
}
