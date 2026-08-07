// GET /api/payroll/results/detail?period_id=...&employee_id=...
// Returns one employee payroll result with deduction lines and adjustments,
// plus the day-level view both result tabs are built from.
// Payroll module access required — admin, or a member named in Control Center →
// Module Visibility → Custom. Correcting attendance stays admin-only, and
// `can_edit` below reports that separately.

import { NextRequest, NextResponse } from 'next/server'
import { requireModuleAccess, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { generatePayrollForEmployee } from '@/lib/payroll/engine'
import { isSkip } from '@/lib/payroll/types'
import type { EngineEmployee } from '@/lib/payroll/types'
import {
  fetchAttendanceForPeriod,
  fetchHolidaysForPeriod,
  fetchCurrentCorrections,
} from '@/lib/payroll/store'
import { toDeductionDays, toConsideredDays, isCorrectableDay } from '@/lib/payroll/resultTabs'
import { canCorrectAttendance } from '@/lib/payroll/correctionRules'

export async function GET(req: NextRequest) {
  const periodId   = req.nextUrl.searchParams.get('period_id')
  const employeeId = req.nextUrl.searchParams.get('employee_id')
  if (!periodId || !employeeId)
    return NextResponse.json({ error: 'period_id and employee_id are required' }, { status: 400 })

  const auth = await requireModuleAccess(req, 'payroll')
  if (isResponse(auth)) return auth
  const svc = auth.svc

  // Period — needed for the lock state and to run the day-level view
  const { data: period, error: periodErr } = await svc
    .from('payroll_periods')
    .select('id, payroll_month, payroll_year, status, locked_at')
    .eq('id', periodId)
    .single()

  if (periodErr || !period) return NextResponse.json({ error: 'Payroll period not found' }, { status: 404 })

  // Fetch the payroll result row
  const { data: result, error: resultErr } = await svc
    .from('payroll_results')
    .select(`
      id,
      employee_id,
      monthly_salary,
      working_days_in_month,
      days_present,
      days_absent,
      half_day_count,
      gross_salary,
      total_deductions,
      pending_adjustment_total,
      net_salary,
      status,
      generated_at,
      users!payroll_results_employee_id_fkey (
        full_name,
        employee_code
      )
    `)
    .eq('payroll_period_id', periodId)
    .eq('employee_id', employeeId)
    .single()

  if (resultErr) return NextResponse.json({ error: resultErr.message }, { status: 500 })
  if (!result)   return NextResponse.json({ error: 'Result not found' }, { status: 404 })

  // Fetch deduction lines
  const { data: lines, error: linesErr } = await svc
    .from('payroll_deduction_lines')
    .select('id, line_date, deduction_type, hours_deducted, amount_deducted')
    .eq('payroll_result_id', result.id)
    .order('line_date', { ascending: true })

  if (linesErr) return NextResponse.json({ error: linesErr.message }, { status: 500 })

  // Fetch applied adjustments linked to this result
  const { data: adjustments, error: adjErr } = await svc
    .from('payroll_pending_adjustments')
    .select('id, description, amount, status')
    .eq('payroll_result_id', result.id)

  if (adjErr) return NextResponse.json({ error: adjErr.message }, { status: 500 })

  const u = result.users as unknown as { full_name: string; employee_code: string | null } | null

  // ── Day-level view ──────────────────────────────────────────────────────────
  // The stored result holds the totals and the deduction ledger; it does not
  // hold what each date was classified as. That is recomputed here from the same
  // inputs and the same engine the generation used. `stale` reports the one case
  // where the two can disagree — attendance changed after the last generation —
  // instead of quietly showing a day view that the money no longer matches.
  const dayView = await buildDayView(svc, {
    employeeId,
    month: period.payroll_month,
    year:  period.payroll_year,
    storedTotalDeductions: result.total_deductions,
  })

  const permission = canCorrectAttendance(auth.role, period.status)

  return NextResponse.json({
    period: {
      id:            period.id,
      payroll_month: period.payroll_month,
      payroll_year:  period.payroll_year,
      status:        period.status,
      locked_at:     period.locked_at ?? null,
    },
    can_edit:     permission.allowed,
    edit_blocked: permission.allowed ? null : permission.message,
    result: {
      id:                       result.id,
      employee_id:              result.employee_id,
      employee_name:            u?.full_name ?? 'Unknown',
      employee_code:            u?.employee_code ?? null,
      monthly_salary:           result.monthly_salary,
      working_days_in_month:    result.working_days_in_month,
      days_present:             result.days_present,
      days_absent:              result.days_absent,
      half_day_count:           result.half_day_count,
      gross_salary:             result.gross_salary,
      total_deductions:         result.total_deductions,
      pending_adjustment_total: result.pending_adjustment_total,
      net_salary:               result.net_salary,
      status:                   result.status,
      generated_at:             result.generated_at,
      deduction_lines:          lines ?? [],
      adjustments:              adjustments ?? [],
    },
    ...dayView,
  })
}

// ─── Day-level view ───────────────────────────────────────────────────────────

type DayViewInput = {
  employeeId: string
  month: number
  year: number
  storedTotalDeductions: number | null
}

async function buildDayView(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svc: any,
  { employeeId, month, year, storedTotalDeductions }: DayViewInput,
) {
  const empty = {
    deduction_days:  [],
    considered_days: [],
    corrections:     [],
    correctable_dates: [],
    stale: false,
    day_view_error: null as string | null,
  }

  const { data: emp } = await svc
    .from('users')
    .select('id, monthly_salary, payroll_active, joining_date, employment_type')
    .eq('id', employeeId)
    .single()

  if (!emp) return { ...empty, day_view_error: 'Employee not found.' }

  try {
    const [attendance, holidays, corrections] = await Promise.all([
      fetchAttendanceForPeriod(svc, employeeId, month, year),
      fetchHolidaysForPeriod(svc, month, year),
      fetchCurrentCorrections(svc, employeeId, month, year),
    ])

    const outcome = generatePayrollForEmployee(
      emp as EngineEmployee,
      // Always 'draft' here: the engine refuses to calculate a locked period,
      // and a locked payroll still has to show its day breakdown. Nothing in
      // this path writes, so running it costs the lock nothing.
      { id: 'day-view', payroll_month: month, payroll_year: year, status: 'draft' },
      attendance,
      holidays,
      // Adjustments do not affect classification or deduction lines, and this
      // view never reports money the stored result does not already hold.
      [],
      corrections,
    )

    if (isSkip(outcome)) return { ...empty, day_view_error: `Payroll skipped: ${outcome.reason}` }

    const rawByDate = new Map(attendance.map(a => [a.attendance_date, a]))

    return {
      deduction_days:  toDeductionDays(outcome.day_results),
      considered_days: toConsideredDays(outcome.day_results),
      correctable_dates: outcome.day_results.filter(isCorrectableDay).map(d => d.date),
      corrections: corrections.map(c => ({
        attendance_date: c.attendance_date,
        remark:          c.remark,
        day_treatment:   c.day_treatment,
        corrected_at:    c.corrected_at,
        corrected_check_in_at:  c.corrected_check_in_at,
        corrected_check_out_at: c.corrected_check_out_at,
        waive_late_arrival:   c.waive_late_arrival,
        waive_early_checkout: c.waive_early_checkout,
        waive_missing_punch:  c.waive_missing_punch,
        raw_check_in_at:  rawByDate.get(c.attendance_date)?.check_in_at  ?? null,
        raw_check_out_at: rawByDate.get(c.attendance_date)?.check_out_at ?? null,
      })),
      // Deduction totals are compared, not net salary: this run deliberately
      // omits adjustments, which net salary includes. A mismatch means
      // attendance moved after the last generation and the stored money is out
      // of date — worth saying so rather than showing a day view that silently
      // disagrees with the totals above it.
      stale: storedTotalDeductions != null
        && !sameMoney(Number(storedTotalDeductions), outcome.total_deductions),
      day_view_error: null,
    }
  } catch (e) {
    return { ...empty, day_view_error: String(e) }
  }
}

function sameMoney(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005
}
