// GET  /api/attendance-requests/reconciliation?year=&month=      admin: the month's attendance review
// POST /api/attendance-requests/reconciliation                   admin: record an excuse / salary treatment
//
// READ-ONLY WITH RESPECT TO PAY. The GET assembles requests, decisions, actual
// attendance (raw overlaid with current corrections), BOE Credit redemptions
// and the stored payroll DRAFT's deduction lines, and hands them to
// buildReconciliation — which never computes money. The POST records the
// reviewer's decision in attendance_day_reviews and nothing else: the only path
// that changes what payroll charges for a day is still the attendance
// correction (/api/payroll/attendance-correction), so a decision here can never
// deduct, or waive, the same minutes a second time.
//
// A fixed number of bulk reads per request, whatever the head-count — never one
// round trip per employee or per row.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse, type ServiceClient } from '@/lib/security/attendancePayrollApiAuth'
import { REQUEST_COLUMNS, type AttendanceRequestRow } from '@/lib/attendance/requests'
import {
  buildReconciliation,
  validateReviewInput,
  type ReconAttendance,
  type ReconCorrection,
  type ReconDraftLine,
  type ReconEmployee,
  type ReconReview,
  type ReconRedemption,
} from '@/lib/attendance/requestReconciliation'
import { fetchHolidaysForPeriod, fetchActiveAttendanceRedemptionsByEmployee } from '@/lib/payroll/store'
import { fetchActiveSettings, settingsForPeriod } from '@/lib/payroll/settingsStore'
import { onlyParticipating } from '@/lib/payroll/participation'
import { periodLockStateByMonth, isLocked } from '@/lib/payroll/lockGuard'
import { fetchAllRows, unwrapPagedRows } from '@/lib/supabasePaging'
import { istToday } from '@/lib/istDate'

type RawAttendance = Omit<ReconAttendance, 'employee_id'> & { user_id: string }

function monthWindow(year: number, month: number) {
  const mm = String(month).padStart(2, '0')
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${String(last).padStart(2, '0')}` }
}

function parseMonth(y: unknown, m: unknown): { year: number; month: number } | null {
  const year = Number(y), month = Number(m)
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 || year < 2020 || year > 2100) return null
  return { year, month }
}

async function loadReconciliation(svc: ServiceClient, year: number, month: number, onlyEmployee?: string) {
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
      .select('id, employee_id, attendance_date, event_key, excused, excuse_reason, pay_decision, decision_reason, attendance_fingerprint, reviewed_by, reviewed_at')
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
  const settings = period
    ? settingsForPeriod(period as Parameters<typeof settingsForPeriod>[0], active.settings)
    : active.settings

  // The generated draft's lines, if the month has been generated.
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
  const today = istToday()
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

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth

  const ym = parseMonth(req.nextUrl.searchParams.get('year'), req.nextUrl.searchParams.get('month'))
  if (!ym) return NextResponse.json({ error: 'year and month are required' }, { status: 400 })

  try {
    const loaded = await loadReconciliation(auth.svc, ym.year, ym.month)
    // Reviewer names for decisions, one read.
    const reviewerIds = new Set<string>()
    for (const e of loaded.result.employees) for (const ev of e.events) {
      if (ev.decision) reviewerIds.add(ev.decision.reviewed_by)
      if (ev.request?.decided_by) reviewerIds.add(ev.request.decided_by)
    }
    let names: Record<string, string> = {}
    if (reviewerIds.size > 0) {
      const { data } = await auth.svc.from('users').select('id, full_name').in('id', [...reviewerIds])
      names = Object.fromEntries(((data ?? []) as { id: string; full_name: string | null }[]).map(u => [u.id, u.full_name ?? 'Admin']))
    }
    return NextResponse.json({ ...loaded, reviewer_names: names })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth

  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const v = validateReviewInput(body)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
  const input = v.value

  const [year, month] = input.attendance_date.split('-').map(Number)

  // A locked month is closed. Corrections after lock go through the existing
  // unlock / adjustment path, never through a review note.
  const lock = await periodLockStateByMonth(auth.svc, month, year)
  if (isLocked(lock)) {
    return NextResponse.json(
      { error: 'This payroll month is locked. Use the existing unlock or adjustment path to change it.' },
      { status: 422 },
    )
  }

  // The fingerprint is computed HERE from the live data, never accepted from
  // the browser, so "decided against this attendance" is a server fact.
  let loaded: Awaited<ReturnType<typeof loadReconciliation>>
  try { loaded = await loadReconciliation(auth.svc, year, month, input.employee_id) }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 }) }

  const event = loaded.result.employees
    .find(e => e.employee.id === input.employee_id)?.events
    .find(ev => ev.date === input.attendance_date && ev.event_key === input.event_key)
  if (!event) {
    return NextResponse.json({ error: 'That event is no longer on the record. Reload the review.' }, { status: 404 })
  }

  const { data, error } = await auth.svc.from('attendance_day_reviews').insert({
    employee_id: input.employee_id,
    attendance_date: input.attendance_date,
    event_key: input.event_key,
    excused: input.excused,
    excuse_reason: input.excuse_reason,
    pay_decision: input.pay_decision,
    decision_reason: input.decision_reason,
    attendance_fingerprint: event.fingerprint,
    reviewed_by: auth.id,
  }).select('id, reviewed_at').single()

  if (error) {
    const status = error.code === '23505' ? 409 : 500
    return NextResponse.json({ error: status === 409 ? 'Someone else saved a decision a moment ago. Reload.' : error.message }, { status })
  }
  return NextResponse.json({ review: data }, { status: 201 })
}
