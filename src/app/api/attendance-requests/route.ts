// GET  /api/attendance-requests          own requests (employee) · the queue (admin, ?scope=queue)
// POST /api/attendance-requests          submit a request, or a correction of your own
//
// Service-role, like every attendance/payroll route, so the identity check here
// IS the boundary. The employee is always the caller — there is no employee id
// in the body to aim at somebody else. RLS in 20270130000000 says the same for
// any client reaching PostgREST directly, and grants no write at all.
//
// A request is a record of permission. Nothing here reads or writes attendance
// punches, corrections, payroll results or adjustments.

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller, UNAUTHORIZED, FORBIDDEN } from '@/lib/security/attendancePayrollApiAuth'
import {
  REQUEST_COLUMNS,
  validateRequestInput,
  shiftStartUtc,
  isInformedBeforeShift,
  informedForCorrection,
  findConflict,
  conflictMessage,
  canEmployeeCorrect,
  type AttendanceRequestRow,
} from '@/lib/attendance/requests'
import { currentShiftWindow, notifyAdminsOfRequest, requestDbError } from '@/lib/attendance/requestsServer'
import { istToday } from '@/lib/istDate'

const WITH_DECIDER = `${REQUEST_COLUMNS}, decider:users!attendance_requests_decided_by_fkey ( full_name )`

export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()

  const scope = req.nextUrl.searchParams.get('scope')

  if (scope !== 'queue') {
    // Own requests only, whatever the query string says.
    const { data, error } = await caller.svc
      .from('attendance_requests')
      .select(WITH_DECIDER)
      .eq('employee_id', caller.id)
      .order('submitted_at', { ascending: false })
      .limit(100)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ requests: data ?? [] })
  }

  if (!caller.isAdmin) return FORBIDDEN()

  // ── Admin queue ────────────────────────────────────────────────────────────
  const status = req.nextUrl.searchParams.get('status') ?? 'pending'
  let query = caller.svc
    .from('attendance_requests')
    .select(`${WITH_DECIDER}, employee:users!attendance_requests_employee_id_fkey ( full_name, employee_code, is_active )`)
    .order('submitted_at', { ascending: status === 'pending' })
    .limit(200)
  if (status !== 'all') query = query.eq('status', status)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const rows = (data ?? []) as unknown as (AttendanceRequestRow & { employee_id: string })[]

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
  return NextResponse.json({ requests: rows, punches, shift })
}

export async function POST(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()

  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

  const { data: me } = await caller.svc.from('users').select('full_name, is_active').eq('id', caller.id).maybeSingle()
  if (!me?.is_active) return NextResponse.json({ error: 'Your account is not active.' }, { status: 403 })

  const shift = await currentShiftWindow(caller.svc)
  const now = new Date().toISOString()
  const validation = validateRequestInput(body, istToday(), shift)
  if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 })
  const input = validation.value

  // ── Correction of an existing request (own only) ─────────────────────────
  const replacesId = typeof body.replaces_request_id === 'string' && body.replaces_request_id ? body.replaces_request_id : null
  let original: AttendanceRequestRow | null = null
  if (replacesId) {
    const { data } = await caller.svc.from('attendance_requests').select(REQUEST_COLUMNS)
      .eq('id', replacesId).eq('employee_id', caller.id).maybeSingle()
    // Same answer whether it is a colleague's request or nobody's.
    if (!data) return NextResponse.json({ error: 'Request not found.' }, { status: 404 })
    original = data as unknown as AttendanceRequestRow
    if (!canEmployeeCorrect(original, now))
      return NextResponse.json({ error: 'This request can no longer be corrected. Ask an admin.' }, { status: 409 })
  }

  // ── Duplicates and overlaps against the employee's own live requests ─────
  const { data: existing, error: exErr } = await caller.svc
    .from('attendance_requests')
    .select('id, request_type, start_date, end_date, departure_time, return_time, status')
    .eq('employee_id', caller.id)
    .in('status', ['pending', 'approved'])
    .lte('start_date', input.end_date)
    .gte('end_date', input.start_date)
  if (exErr) return NextResponse.json({ error: exErr.message }, { status: 500 })
  const conflict = findConflict(input, (existing ?? []) as unknown as AttendanceRequestRow[], replacesId)
  if (conflict) return NextResponse.json({ error: conflictMessage(conflict as AttendanceRequestRow), conflict_id: conflict.id }, { status: 409 })

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

  if (error || !data) {
    const mapped = requestDbError(error?.message ?? 'unknown error')
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }
  const row = data as unknown as AttendanceRequestRow

  await notifyAdminsOfRequest(caller.svc, row, me.full_name ?? null, !!replacesId)

  return NextResponse.json({ request: row }, { status: 201 })
}
