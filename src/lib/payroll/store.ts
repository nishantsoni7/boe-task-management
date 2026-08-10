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
import type { AttendanceDayCorrection } from '../attendance/corrections'
import { parseStoredDirectionSource } from '../attendance/punchDirection'
import { toSignedAdjustments, type StoredAdjustment } from './adjustments'
import { onlyParticipating, partitionByParticipation } from './participation'

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
  const { data, error } = await onlyParticipating(
    svc.from('users').select(EMPLOYEE_COLS),
  ).or('is_deleted.eq.false,is_deleted.is.null')
  if (error) throw new Error(`fetchAllPayrollActiveEmployees: ${error.message}`)
  return (data ?? []) as EngineEmployee[]
}

/**
 * The named employees, split into those payroll may process and those it may not.
 *
 * Generation has two entry paths and only one of them was filtered. Running for
 * the whole company goes through fetchAllPayrollActiveEmployees above, which has
 * always honoured the flag; running for a NAMED list — which is what every
 * regeneration after an attendance correction does — fetched each row by id with
 * no participation predicate at all. An excluded member reached the engine and
 * was stopped only by its `employee_inactive` guard.
 *
 * That guard is a backstop, not the boundary. Relying on it means any future
 * caller that assembles employees without going through the engine inherits the
 * hole, so the restriction is stated here, at the data-fetch layer, for both
 * paths. The excluded rows are returned rather than dropped so the caller can
 * say WHY an explicitly named employee produced nothing.
 */
export async function fetchEmployeesForGeneration(
  svc: Svc,
  employeeIds: string[],
): Promise<{ included: EngineEmployee[]; excludedIds: string[] }> {
  if (employeeIds.length === 0) return { included: [], excludedIds: [] }

  const { data, error } = await svc
    .from('users')
    .select(EMPLOYEE_COLS)
    .in('id', employeeIds)
  if (error) throw new Error(`fetchEmployeesForGeneration: ${error.message}`)

  const { included, excluded } = partitionByParticipation((data ?? []) as EngineEmployee[])
  return { included, excludedIds: excluded.map(e => e.id) }
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
    .select('id, attendance_date, check_in_at, check_out_at, punch_direction_source')
    .eq('user_id', employeeId)
    .gte('attendance_date', start)
    .lt('attendance_date', end)

  if (error) throw new Error(`fetchAttendanceForPeriod: ${error.message}`)
  return (data ?? []).map(toEngineAttendanceRecord)
}

/**
 * A stored attendance row, narrowed for the engine.
 *
 * The column is `text` with a CHECK, so Supabase types it `string | null` and
 * the CHECK constrains the database rather than this program. The value is
 * therefore PARSED, not asserted: anything the engine would not recognise
 * becomes null and resolves to 'inferred', which is the reading that cannot
 * over-charge. No raw database text reaches the calculation.
 *
 * Mapping through one function rather than casting the row is what makes that
 * true of every payroll read — see the identically-shaped read in
 * /api/payroll/monthly-review, which calls this too.
 */
export function toEngineAttendanceRecord(row: {
  id: string
  attendance_date: string
  check_in_at: string | null
  check_out_at: string | null
  punch_direction_source?: unknown
}): EngineAttendanceRecord {
  return {
    id:               row.id,
    attendance_date:  row.attendance_date,
    check_in_at:      row.check_in_at,
    check_out_at:     row.check_out_at,
    direction_source: parseStoredDirectionSource(row.punch_direction_source),
  }
}

// ─── Attendance corrections (manual override layer) ───────────────────────────

export type StoredCorrection = AttendanceDayCorrection & {
  id: string
  remark: string
  corrected_by: string
  corrected_at: string
}

/**
 * The active corrections for one employee-month.
 *
 * Only `is_current` rows are returned: superseded versions stay in the table as
 * history and must never reach the calculation.
 */
export async function fetchCurrentCorrections(
  svc: Svc,
  employeeId: string,
  month: number,
  year: number,
): Promise<StoredCorrection[]> {
  const mm        = String(month).padStart(2, '0')
  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear  = month === 12 ? year + 1 : year
  const start     = `${year}-${mm}-01`
  const end       = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`

  const { data, error } = await svc
    .from('attendance_day_corrections')
    .select('id, attendance_date, corrected_check_in_at, corrected_check_out_at, day_treatment, waive_late_arrival, waive_early_checkout, waive_missing_punch, remark, corrected_by, corrected_at')
    .eq('user_id', employeeId)
    .eq('is_current', true)
    .gte('attendance_date', start)
    .lt('attendance_date', end)

  if (error) throw new Error(`fetchCurrentCorrections: ${error.message}`)
  return (data ?? []) as StoredCorrection[]
}

/**
 * The active corrections for EVERY employee in one month, grouped by employee.
 *
 * The whole-company preview (/api/payroll/monthly-review) needs the same
 * override layer generation uses, and fetching it per employee would be one
 * round trip each. Same `is_current` filter and same column list as
 * fetchCurrentCorrections above, so the two cannot resolve a day differently.
 *
 * Read unpaged on purpose: this is one month of manually corrected days for the
 * whole company — tens of rows, orders of magnitude below the 1000-row PostgREST
 * ceiling, and the same shape as the attendance read the caller already does for
 * the same window. If BOE ever corrects more than a thousand days in one month,
 * this and that read both need src/lib/supabasePaging.ts.
 */
export async function fetchCurrentCorrectionsByEmployee(
  svc: Svc,
  month: number,
  year: number,
): Promise<Map<string, StoredCorrection[]>> {
  const mm        = String(month).padStart(2, '0')
  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear  = month === 12 ? year + 1 : year
  const start     = `${year}-${mm}-01`
  const end       = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`

  const { data, error } = await svc
    .from('attendance_day_corrections')
    .select('user_id, id, attendance_date, corrected_check_in_at, corrected_check_out_at, day_treatment, waive_late_arrival, waive_early_checkout, waive_missing_punch, remark, corrected_by, corrected_at')
    .eq('is_current', true)
    .gte('attendance_date', start)
    .lt('attendance_date', end)

  if (error) throw new Error(`fetchCurrentCorrectionsByEmployee: ${error.message}`)

  const byEmployee = new Map<string, StoredCorrection[]>()
  for (const row of (data ?? []) as (StoredCorrection & { user_id: string })[]) {
    const list = byEmployee.get(row.user_id)
    if (list) list.push(row)
    else byEmployee.set(row.user_id, [row])
  }
  return byEmployee
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

/**
 * Pending manual adjustments for one employee in one period.
 *
 * Two things here are deliberate and were both wrong before:
 *
 *  * `adjustment_type` is selected and the row is converted through
 *    `toSignedAdjustment`. Since migration 20260636 the stored `amount` is
 *    always positive and the direction lives in `adjustment_type`, so reading
 *    `amount` raw made every manual deduction increase net salary.
 *
 *  * The period scope. `/api/payroll/adjustments` records the month it belongs
 *    to in `payroll_year`/`payroll_month` and never sets `applied_in_period_id`,
 *    so matching "applied_in_period_id is null" alone pulled an employee's
 *    adjustments from *every* month into *every* payroll run. A row is in scope
 *    when it is explicitly scheduled into this period, or when it is unscheduled
 *    and stamped with this period's month.
 *
 * Adjustments this period has ALREADY consumed are included too. Generation
 * marks them 'applied', and a 'pending'-only read meant the second run for a
 * period silently dropped them: the employee's manual deduction vanished from
 * net salary. Because every correction triggers a recalculation, that turned
 * from a rare regeneration quirk into something that fired on each save. A row
 * applied by THIS period is still owed by this period, so it is re-read; a row
 * applied by a different period is not.
 */
export async function fetchPendingAdjustments(
  svc: Svc,
  employeeId: string,
  periodId: string,
  month: number,
  year: number,
): Promise<EnginePendingAdjustment[]> {
  const { data, error } = await svc
    .from('payroll_pending_adjustments')
    .select('id, adjustment_type, adjustment_category, amount, description')
    .eq('employee_id', employeeId)
    .or(
      `and(status.eq.pending,applied_in_period_id.eq.${periodId}),` +
      `and(status.eq.pending,applied_in_period_id.is.null,payroll_year.eq.${year},payroll_month.eq.${month}),` +
      `and(status.eq.applied,applied_in_period_id.eq.${periodId})`,
    )

  if (error) throw new Error(`fetchPendingAdjustments: ${error.message}`)
  return toSignedAdjustments((data ?? []) as StoredAdjustment[])
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

/**
 * Record which period and result consumed these adjustments.
 *
 * `applied_in_period_id` is stamped so a re-run of the SAME period can find its
 * own applied rows again (see fetchPendingAdjustments). Without it an applied
 * adjustment became invisible to every later run and dropped out of net salary.
 */
export async function markAdjustmentsApplied(
  svc: Svc,
  adjustmentIds: string[],
  resultId: string,
  periodId: string,
): Promise<void> {
  if (adjustmentIds.length === 0) return
  const { error } = await svc
    .from('payroll_pending_adjustments')
    .update({ status: 'applied', payroll_result_id: resultId, applied_in_period_id: periodId })
    .in('id', adjustmentIds)
  if (error) throw new Error(`markAdjustmentsApplied: ${error.message}`)
}
