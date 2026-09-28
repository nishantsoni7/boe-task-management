// POST /api/payroll/attendance-correction
//
// Corrects the attendance considered for one employee on one date, then
// recalculates that employee's payroll for the period.
//
// Body
//   payroll_period_id  string   required
//   employee_id        string   required
//   attendance_date    string   required — YYYY-MM-DD
//   check_in_at        string?  ISO timestamp, or null for "no punch-in"
//   check_out_at       string?  ISO timestamp, or null for "no punch-out"
//   day_treatment      'auto' | 'full_day' | 'half_day' | 'absent'
//   waive_late_arrival / waive_early_checkout / waive_missing_punch  boolean
//   remark             string   required, non-blank
//
// The raw biometric row in attendance_records is never touched. The correction
// is a new row in attendance_day_corrections that supersedes any previous one
// for the same employee and date, and payroll is regenerated from raw
// attendance overlaid with it.
//
// Auth: admin only. Refused outright once the payroll period is locked.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { fetchPeriod } from '@/lib/payroll/store'
import { canCorrectAttendance, validateCorrectionInput } from '@/lib/payroll/correctionRules'
import { applyAttendanceCorrection } from '@/lib/payroll/attendanceCorrectionService'

export async function POST(req: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: { user: caller }, error: authErr } = await svc.auth.getUser(token)
  if (authErr || !caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: callerProfile } = await svc
    .from('users')
    .select('role')
    .eq('id', caller.id)
    .single()

  // ── Body ────────────────────────────────────────────────────────────────────
  let body: Record<string, unknown>
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const periodId   = typeof body.payroll_period_id === 'string' ? body.payroll_period_id : ''
  const employeeId = typeof body.employee_id       === 'string' ? body.employee_id       : ''
  if (!periodId || !employeeId)
    return NextResponse.json({ error: 'payroll_period_id and employee_id are required' }, { status: 400 })

  // ── Period, permission and lock ─────────────────────────────────────────────
  let period: Awaited<ReturnType<typeof fetchPeriod>>
  try { period = await fetchPeriod(svc, periodId) }
  catch { return NextResponse.json({ error: 'Payroll period not found' }, { status: 404 }) }

  const permission = canCorrectAttendance(callerProfile?.role, period.status)
  if (!permission.allowed) {
    return NextResponse.json(
      { error: permission.message },
      { status: permission.reason === 'not_authorised' ? 403 : 422 },
    )
  }

  const validation = validateCorrectionInput(body)
  if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 })

  // ── Apply: the shared, authoritative correction path ───────────────────────
  // The same function the Payroll review uses to apply a reviewed decision
  // (src/lib/payroll/attendanceCorrectionService.ts): lock refusal, before/after
  // runs, versioned correction, BOE Credits coverage, regeneration.
  const outcome = await applyAttendanceCorrection(svc, {
    periodId,
    employeeId,
    correction: validation.value,
    actorId: caller.id,
  })
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })

  return NextResponse.json({
    correction_id: outcome.correction_id,
    attendance_date: outcome.attendance_date,
    before: outcome.before,
    after:  outcome.after,
    net_salary: outcome.net_salary,
    total_deductions: outcome.total_deductions,
  })
}
