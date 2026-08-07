// GET /api/payroll/monthly-review/detail?year=&month=&employee_id=
//
// Runs the payroll engine in preview mode for one employee and returns
// day-level classification results alongside the monthly summary.
// Payroll module access required — admin, or a member named in Control Center →
// Module Visibility → Custom. Same decision the launcher and PayrollGuard use.

import { NextRequest, NextResponse } from 'next/server'
import { requireModuleAccess, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { generatePayrollForEmployee } from '@/lib/payroll/engine'
import { fetchAttendanceForPeriod, fetchHolidaysForPeriod, fetchCurrentCorrections } from '@/lib/payroll/store'
import { toSignedAdjustments, type StoredAdjustment } from '@/lib/payroll/adjustments'
import { isSkip } from '@/lib/payroll/types'
import type { EngineEmployee, EnginePendingAdjustment } from '@/lib/payroll/types'

type EmployeeRow = EngineEmployee & {
  full_name: string
  employee_code: string | null
}

export async function GET(req: NextRequest) {
  const auth = await requireModuleAccess(req, 'payroll')
  if (isResponse(auth)) return auth
  const svc = auth.svc

  const yearParam       = req.nextUrl.searchParams.get('year')
  const monthParam      = req.nextUrl.searchParams.get('month')
  const employeeIdParam = req.nextUrl.searchParams.get('employee_id')

  if (!yearParam || !monthParam || !employeeIdParam)
    return NextResponse.json({ error: 'year, month, and employee_id are required' }, { status: 400 })

  const year  = parseInt(yearParam,  10)
  const month = parseInt(monthParam, 10)
  if (isNaN(year) || isNaN(month) || month < 1 || month > 12)
    return NextResponse.json({ error: 'Invalid year or month' }, { status: 400 })

  // Fetch the employee
  const { data: emp, error: empErr } = await svc
    .from('users')
    .select('id, full_name, employee_code, monthly_salary, payroll_active, joining_date, employment_type')
    .eq('id', employeeIdParam)
    .single()

  if (empErr || !emp)
    return NextResponse.json({ error: 'Employee not found' }, { status: 404 })

  const employee = emp as EmployeeRow

  const previewPeriod = {
    id: 'preview',
    payroll_month: month,
    payroll_year: year,
    status: 'draft' as const,
  }

  let attendance:   Awaited<ReturnType<typeof fetchAttendanceForPeriod>>
  let holidays:     Awaited<ReturnType<typeof fetchHolidaysForPeriod>>
  let corrections:  Awaited<ReturnType<typeof fetchCurrentCorrections>> = []
  let adjustments:  EnginePendingAdjustment[] = []
  try {
    const [att, hols, corr, adjResult] = await Promise.all([
      fetchAttendanceForPeriod(svc, employee.id, month, year),
      fetchHolidaysForPeriod(svc, month, year),
      fetchCurrentCorrections(svc, employee.id, month, year),
      svc
        .from('payroll_pending_adjustments')
        .select('id, adjustment_type, amount, description')
        .eq('employee_id',   employee.id)
        .eq('payroll_year',  year)
        .eq('payroll_month', month)
        .eq('status', 'pending')
        .order('created_at', { ascending: false }),
    ])
    attendance  = att
    holidays    = hols
    corrections = corr
    // Same conversion the generation path uses, so a preview and the payroll it
    // previews cannot read an adjustment differently.
    adjustments = toSignedAdjustments((adjResult.data ?? []) as StoredAdjustment[])
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  // The preview must show the same figures the generated payroll will, so it
  // applies the same manual corrections.
  const outcome = generatePayrollForEmployee(employee, previewPeriod, attendance, holidays, adjustments, corrections)

  if (isSkip(outcome)) {
    return NextResponse.json({
      employee: {
        id:            employee.id,
        full_name:     employee.full_name,
        employee_code: employee.employee_code,
        monthly_salary: employee.monthly_salary,
      },
      skipped:     true,
      skip_reason: outcome.reason,
    })
  }

  return NextResponse.json({
    employee: {
      id:             employee.id,
      full_name:      employee.full_name,
      employee_code:  employee.employee_code,
      monthly_salary: employee.monthly_salary,
    },
    skipped: false,
    summary: {
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
      short_hours_deduction:     outcome.short_hours_deduction,
      missing_punch_hours:       outcome.missing_punch_hours,
      total_deductions:          outcome.total_deductions,
      adjustment_total:          outcome.pending_adjustment_total,
      net_salary:                outcome.net_salary,
    },
    deduction_lines: (() => {
      // Effective punches, not raw ones: a corrected day must read the way
      // payroll counted it.
      const dayByDate = new Map(outcome.day_results.map(d => [d.date, d]))
      return outcome.deduction_lines.map(line => ({
        ...line,
        check_in_at:  dayByDate.get(line.line_date)?.check_in_at  ?? null,
        check_out_at: dayByDate.get(line.line_date)?.check_out_at ?? null,
      }))
    })(),
    adjustments: adjustments.map(a => ({
      id:              a.id,
      adjustment_type: a.amount >= 0 ? 'addition' : 'deduction',
      amount:          Math.abs(a.amount),
      description:     a.description,
    })),
  })
}
