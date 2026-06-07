// Payroll generation — database I/O layer.
// All reads and writes for one generation run live here.
// The engine (engine.ts) stays pure; this module is the only place that touches Supabase.

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  EngineEmployee,
  EnginePeriod,
  EngineAttendanceRecord,
  EngineHoliday,
  EnginePendingAdjustment,
  EngineResult,
} from './types'

// Callers pass a service-role client in; we accept any schema parameterisation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = SupabaseClient<any, any, any>

// ─── Period ───────────────────────────────────────────────────────────────────

export async function fetchPeriod(svc: Svc, id: string): Promise<EnginePeriod> {
  const { data, error } = await svc
    .from('payroll_periods')
    .select('id, payroll_month, payroll_year, status')
    .eq('id', id)
    .single()
  if (error || !data) throw new Error(`fetchPeriod: ${error?.message ?? 'not found'}`)
  return data as EnginePeriod
}

// ─── Employees ────────────────────────────────────────────────────────────────

const EMPLOYEE_COLS = 'id, monthly_salary, payroll_active, joining_date, employment_type'

export async function fetchEmployee(svc: Svc, id: string): Promise<EngineEmployee | null> {
  const { data, error } = await svc
    .from('users')
    .select(EMPLOYEE_COLS)
    .eq('id', id)
    .single()
  if (error || !data) return null
  return data as EngineEmployee
}

export async function fetchAllPayrollActiveEmployees(svc: Svc): Promise<EngineEmployee[]> {
  const { data, error } = await svc
    .from('users')
    .select(EMPLOYEE_COLS)
    .eq('payroll_active', true)
    .or('is_deleted.eq.false,is_deleted.is.null')
  if (error) throw new Error(`fetchAllPayrollActiveEmployees: ${error.message}`)
  return (data ?? []) as EngineEmployee[]
}

// ─── Attendance ───────────────────────────────────────────────────────────────

export async function fetchAttendanceForPeriod(
  svc: Svc,
  employeeId: string,
  month: number,
  year: number,
): Promise<EngineAttendanceRecord[]> {
  const mm         = String(month).padStart(2, '0')
  const nextMonth  = month === 12 ? 1 : month + 1
  const nextYear   = month === 12 ? year + 1 : year
  const start      = `${year}-${mm}-01`
  const end        = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`

  const { data, error } = await svc
    .from('attendance_records')
    .select('id, attendance_date, check_in_at, check_out_at')
    .eq('user_id', employeeId)
    .gte('attendance_date', start)
    .lt('attendance_date', end)

  if (error) throw new Error(`fetchAttendanceForPeriod: ${error.message}`)
  return (data ?? []) as EngineAttendanceRecord[]
}

// ─── Holidays ─────────────────────────────────────────────────────────────────

export async function fetchHolidaysForPeriod(
  svc: Svc,
  month: number,
  year: number,
): Promise<EngineHoliday[]> {
  const mm        = String(month).padStart(2, '0')
  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear  = month === 12 ? year + 1 : year
  const start     = `${year}-${mm}-01`
  const end       = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`

  const { data, error } = await svc
    .from('payroll_holidays')
    .select('holiday_date')
    .gte('holiday_date', start)
    .lt('holiday_date', end)

  if (error) throw new Error(`fetchHolidaysForPeriod: ${error.message}`)
  return (data ?? []) as EngineHoliday[]
}

// ─── Pending adjustments ──────────────────────────────────────────────────────

export async function fetchPendingAdjustments(
  svc: Svc,
  employeeId: string,
  periodId: string,
): Promise<EnginePendingAdjustment[]> {
  const { data, error } = await svc
    .from('payroll_pending_adjustments')
    .select('id, amount, description')
    .eq('employee_id', employeeId)
    .eq('status', 'pending')
    .or(`applied_in_period_id.eq.${periodId},applied_in_period_id.is.null`)

  if (error) throw new Error(`fetchPendingAdjustments: ${error.message}`)
  return (data ?? []) as EnginePendingAdjustment[]
}

// ─── payroll_generation row ───────────────────────────────────────────────────

export async function createGenerationRow(
  svc: Svc,
  periodId: string,
  triggeredBy: string,
): Promise<string> {
  const { data, error } = await svc
    .from('payroll_generation')
    .insert({ payroll_period_id: periodId, triggered_by: triggeredBy })
    .select('id')
    .single()
  if (error || !data) throw new Error(`createGenerationRow: ${error?.message ?? 'insert failed'}`)
  return (data as { id: string }).id
}

export type GenerationCounts = {
  status: 'done' | 'failed'
  employee_count: number
  skipped_count: number
  failed_employee_ids: string[]
  error_message?: string
}

export async function finalizeGenerationRow(
  svc: Svc,
  generationId: string,
  counts: GenerationCounts,
): Promise<void> {
  const { error } = await svc
    .from('payroll_generation')
    .update({
      status:              counts.status,
      employee_count:      counts.employee_count,
      skipped_count:       counts.skipped_count,
      failed_employee_ids: counts.failed_employee_ids,
      error_message:       counts.error_message ?? null,
      completed_at:        new Date().toISOString(),
    })
    .eq('id', generationId)
  if (error) throw new Error(`finalizeGenerationRow: ${error.message}`)
}

// ─── payroll_results + deduction_lines ────────────────────────────────────────

/**
 * Upsert the payroll_results row, replace its deduction lines, and return the row id.
 * On regeneration the old lines are deleted and replaced so the ledger stays clean.
 */
export async function writeEngineResult(
  svc: Svc,
  generationId: string,
  r: EngineResult,
): Promise<string> {
  // Upsert the summary row
  const { data: row, error: upsertErr } = await svc
    .from('payroll_results')
    .upsert(
      {
        payroll_period_id:         r.payroll_period_id,
        employee_id:               r.employee_id,
        monthly_salary:            r.monthly_salary,
        working_days_in_month:     r.working_days_in_month,
        days_present:              r.days_present,
        days_absent:               r.days_absent,
        days_on_leave:             r.days_on_leave,
        paid_leave_available:      r.paid_leave_available,
        paid_leave_used:           r.paid_leave_used,
        half_day_count:            r.half_day_count,
        late_deduction_hours:      r.late_deduction_hours,
        short_hours_deduction:     r.short_hours_deduction,
        missing_punch_hours:       r.missing_punch_hours,
        leave_absorbed_deductions: r.leave_absorbed_deductions,
        gross_salary:              r.gross_salary,
        total_deductions:          r.total_deductions,
        pending_adjustment_total:  r.pending_adjustment_total,
        net_salary:                r.net_salary,
        generated_at:              r.generated_at,
        payroll_generation_id:     generationId,
        status:                    'draft',
        updated_at:                new Date().toISOString(),
      },
      { onConflict: 'payroll_period_id,employee_id' },
    )
    .select('id')
    .single()

  if (upsertErr || !row) {
    throw new Error(`writeEngineResult upsert: ${upsertErr?.message ?? 'no row returned'}`)
  }

  const resultId = (row as { id: string }).id

  // Replace deduction lines (ON DELETE CASCADE applies only when the parent row is
  // deleted; since we're upserting we must clean up the old lines manually)
  const { error: delErr } = await svc
    .from('payroll_deduction_lines')
    .delete()
    .eq('payroll_result_id', resultId)
  if (delErr) throw new Error(`writeEngineResult delete lines: ${delErr.message}`)

  if (r.deduction_lines.length > 0) {
    const lines = r.deduction_lines.map(l => ({
      payroll_result_id: resultId,
      line_date:         l.line_date,
      deduction_type:    l.deduction_type,
      hours_deducted:    l.hours_deducted,
      amount_deducted:   l.amount_deducted,
    }))
    const { error: insErr } = await svc.from('payroll_deduction_lines').insert(lines)
    if (insErr) throw new Error(`writeEngineResult insert lines: ${insErr.message}`)
  }

  return resultId
}

// ─── Period status ────────────────────────────────────────────────────────────

export type PeriodStatus = 'draft' | 'generated' | 'locked'

export async function setPeriodStatus(
  svc: Svc,
  periodId: string,
  status: PeriodStatus,
): Promise<void> {
  const { error } = await svc
    .from('payroll_periods')
    .update({ status })
    .eq('id', periodId)
  if (error) throw new Error(`setPeriodStatus: ${error.message}`)
}

export async function markAdjustmentsApplied(
  svc: Svc,
  adjustmentIds: string[],
  resultId: string,
): Promise<void> {
  if (adjustmentIds.length === 0) return
  const { error } = await svc
    .from('payroll_pending_adjustments')
    .update({ status: 'applied', payroll_result_id: resultId })
    .in('id', adjustmentIds)
  if (error) throw new Error(`markAdjustmentsApplied: ${error.message}`)
}
