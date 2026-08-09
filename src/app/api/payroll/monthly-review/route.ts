// GET /api/payroll/monthly-review?year=&month=
//
// Runs the payroll engine in preview mode for all payroll-active employees for
// the given month, without requiring a payroll_period to exist.
// Returns per-employee summary rows.
// Payroll module access required — admin, or a member named in Control Center →
// Module Visibility → Custom. Same decision the launcher and PayrollGuard use.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { generatePayrollForEmployee } from '@/lib/payroll/engine'
import {
  fetchHolidaysForPeriod,
  fetchCurrentCorrectionsByEmployee,
  toEngineAttendanceRecord,
} from '@/lib/payroll/store'
import { onlyParticipating } from '@/lib/payroll/participation'
import { isSkip } from '@/lib/payroll/types'
import type { EngineEmployee, EngineAttendanceRecord, EnginePendingAdjustment } from '@/lib/payroll/types'

type EmployeeRow = EngineEmployee & {
  full_name: string
  employee_code: string | null
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth
  const svc = auth.svc

  const yearParam  = req.nextUrl.searchParams.get('year')
  const monthParam = req.nextUrl.searchParams.get('month')
  if (!yearParam || !monthParam)
    return NextResponse.json({ error: 'year and month are required' }, { status: 400 })

  const year  = parseInt(yearParam,  10)
  const month = parseInt(monthParam, 10)
  if (isNaN(year) || isNaN(month) || month < 1 || month > 12)
    return NextResponse.json({ error: 'Invalid year or month' }, { status: 400 })

  // Fetch all participating employees with display fields.
  //
  // Through the SHARED participation helper, not a hand-written
  // `.eq('payroll_active', true)`. This preview and the real run must answer
  // "who is in payroll this month" the same way — a preview that lists somebody
  // generation will refuse, or omits somebody it will pay, is worse than no
  // preview. See src/lib/payroll/participation.ts and
  // fetchAllPayrollActiveEmployees in the store, which this now mirrors exactly.
  const { data: employees, error: empErr } = await onlyParticipating(
    svc
      .from('users')
      .select('id, full_name, employee_code, monthly_salary, payroll_active, joining_date, employment_type'),
  )
    .or('is_deleted.eq.false,is_deleted.is.null')
    .order('full_name')

  if (empErr) return NextResponse.json({ error: empErr.message }, { status: 500 })
  if (!employees || employees.length === 0)
    return NextResponse.json({ year, month, results: [] })

  // Fetch all attendance records for the month in one query
  const mm        = String(month).padStart(2, '0')
  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear  = month === 12 ? year + 1 : year
  const start     = `${year}-${mm}-01`
  const end       = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`

  // punch_direction_source is selected here for the same reason generation
  // selects it: without it every stored day reaches the engine as a guess, and
  // this preview would disagree with the run it is previewing.
  const { data: allRecords, error: recErr } = await svc
    .from('attendance_records')
    .select('id, user_id, attendance_date, check_in_at, check_out_at, punch_direction_source')
    .gte('attendance_date', start)
    .lt('attendance_date', end)

  if (recErr) return NextResponse.json({ error: recErr.message }, { status: 500 })

  // Group records by employee, mapped through the SAME narrowing generation
  // uses so an unrecognised stored value fails to 'inferred' on both paths.
  const byEmployee = new Map<string, EngineAttendanceRecord[]>()
  for (const r of allRecords ?? []) {
    if (!byEmployee.has(r.user_id)) byEmployee.set(r.user_id, [])
    byEmployee.get(r.user_id)!.push(toEngineAttendanceRecord(r))
  }

  // Fetch holidays, adjustments and the manual correction layer for the month.
  //
  // The corrections are the fix for a real divergence: this preview ran the
  // engine on RAW biometric punches while generation runs it on raw punches
  // overlaid with approved corrections. An admin who corrected a date then
  // compared the two screens saw different money with nothing to explain it, and
  // the preview was the wrong one.
  let holidays: Awaited<ReturnType<typeof fetchHolidaysForPeriod>>
  let correctionsByEmployee: Awaited<ReturnType<typeof fetchCurrentCorrectionsByEmployee>>
  let allAdjustments: { employee_id: string; adjustment_type: string; amount: number; id: string; description: string }[] = []
  try {
    const [hols, corrs, adjResult] = await Promise.all([
      fetchHolidaysForPeriod(svc, month, year),
      fetchCurrentCorrectionsByEmployee(svc, month, year),
      svc
        .from('payroll_pending_adjustments')
        .select('id, employee_id, adjustment_type, amount, description')
        .eq('payroll_year',  year)
        .eq('payroll_month', month)
        .eq('status', 'pending'),
    ])
    holidays              = hols
    correctionsByEmployee = corrs
    allAdjustments        = adjResult.data ?? []
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  // Group adjustments by employee
  const adjByEmployee = new Map<string, EnginePendingAdjustment[]>()
  for (const adj of allAdjustments) {
    if (!adjByEmployee.has(adj.employee_id)) adjByEmployee.set(adj.employee_id, [])
    adjByEmployee.get(adj.employee_id)!.push({
      id:          adj.id,
      amount:      adj.adjustment_type === 'deduction' ? -adj.amount : adj.amount,
      description: adj.description,
    })
  }

  // Dummy period for preview — no DB row required
  const previewPeriod = {
    id: 'preview',
    payroll_month: month,
    payroll_year: year,
    status: 'draft' as const,
  }

  // Run engine for each employee
  const results = (employees as EmployeeRow[]).map(emp => {
    const attendance   = byEmployee.get(emp.id)   ?? []
    const adjustments  = adjByEmployee.get(emp.id) ?? []
    const corrections  = correctionsByEmployee.get(emp.id) ?? []
    // Same six arguments generation passes. The corrections argument used to be
    // omitted, which silently made this a preview of a different calculation.
    const outcome = generatePayrollForEmployee(emp, previewPeriod, attendance, holidays, adjustments, corrections)

    if (isSkip(outcome)) {
      return {
        employee_id:   emp.id,
        employee_name: emp.full_name,
        employee_code: emp.employee_code,
        skipped:       true,
        skip_reason:   outcome.reason,
      }
    }

    return {
      employee_id:               emp.id,
      employee_name:             emp.full_name,
      employee_code:             emp.employee_code,
      skipped:                   false,
      monthly_salary:            outcome.monthly_salary,
      gross_salary:              outcome.gross_salary,
      working_days_in_month:     outcome.working_days_in_month,
      days_present:              outcome.days_present,
      days_absent:               outcome.days_absent,
      half_day_count:            outcome.half_day_count,
      paid_leave_available:      outcome.paid_leave_available,
      paid_leave_used:           outcome.paid_leave_used,
      leave_absorbed_deductions: outcome.leave_absorbed_deductions,
      late_deduction_hours:      outcome.late_deduction_hours,
      missing_punch_hours:       outcome.missing_punch_hours,
      total_deductions:          outcome.total_deductions,
      adjustment_total:          outcome.pending_adjustment_total,
      net_salary:                outcome.net_salary,
    }
  })

  return NextResponse.json({ year, month, results })
}
