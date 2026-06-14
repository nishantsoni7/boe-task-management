// GET /api/payroll/monthly-review/detail?year=&month=&employee_id=
//
// Runs the payroll engine in preview mode for one employee and returns
// day-level classification results alongside the monthly summary.
// Admin only.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { generatePayrollForEmployee } from '@/lib/payroll/engine'
import { fetchAttendanceForPeriod, fetchHolidaysForPeriod } from '@/lib/payroll/store'
import { isSkip } from '@/lib/payroll/types'
import type { EngineEmployee } from '@/lib/payroll/types'

type EmployeeRow = EngineEmployee & {
  full_name: string
  employee_code: string | null
}

export async function GET(req: NextRequest) {
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
  if (callerProfile?.role !== 'admin')
    return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

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

  let attendance: Awaited<ReturnType<typeof fetchAttendanceForPeriod>>
  let holidays:   Awaited<ReturnType<typeof fetchHolidaysForPeriod>>
  try {
    ;[attendance, holidays] = await Promise.all([
      fetchAttendanceForPeriod(svc, employee.id, month, year),
      fetchHolidaysForPeriod(svc, month, year),
    ])
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  const outcome = generatePayrollForEmployee(employee, previewPeriod, attendance, holidays, [])

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
      net_salary:                outcome.net_salary,
    },
    deduction_lines: outcome.deduction_lines,
  })
}
