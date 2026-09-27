// Apply one attendance correction and recalculate that employee's payroll.
//
// THE ONE PATH THAT CHANGES WHAT PAYROLL CHARGES FOR A DAY. It was the body of
// POST /api/payroll/attendance-correction; it lives here so the Payroll review
// (src/app/api/attendance-requests/reconciliation) can apply a reviewed
// decision through exactly the same steps instead of a second implementation:
//
//   lock refusal → before/after engine runs → supersede + insert correction
//   (history kept) → BOE Credits coverage reconciled → result regenerated
//
// The raw biometric row in attendance_records is never touched. The caller is
// responsible for WHO may do this (admin) and for validating the input; this
// module refuses a locked period itself, so no caller can forget to.
//
// One deliberate change from the route it came from: recalculation now uses the
// settings pinned to the period (settingsForPeriod), the same rule full
// generation uses. The route passed nothing, so it recalculated a corrected
// employee under DEFAULT_PAYROLL_SETTINGS while everyone else in the month was
// calculated under the period's snapshot — and the next full regeneration would
// then move that employee's figures again. See ATTENDANCE_REQUESTS.md §5.

import { generatePayrollForEmployee } from './engine'
import { isSkip } from './types'
import type { EngineEmployee, EngineDay } from './types'
import {
  fetchPeriod,
  fetchEmployee,
  fetchAttendanceForPeriod,
  fetchHolidaysForPeriod,
  fetchPendingAdjustments,
  fetchCurrentCorrections,
  fetchActiveAttendanceRedemptions,
  createGenerationRow,
  writeEngineResult,
  markAdjustmentsApplied,
  finalizeGenerationRow,
} from './store'
import { toEngineCorrection, buildCorrectionAudit, type DaySnapshot, type ValidatedCorrection } from './correctionRules'
import { reconcileAttendanceCoverage } from './creditCoverage'
import { fetchActiveSettings, fetchPeriodSettingsContext, settingsForPeriod } from './settingsStore'
import { isPayrollMonthComplete, monthInProgressMessage } from './periodCompletion'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any

export type CorrectionApplied = {
  ok: true
  correction_id: string
  attendance_date: string
  before: DaySnapshot
  after: DaySnapshot
  net_salary: number
  total_deductions: number
}
export type CorrectionRefused = { ok: false; status: number; error: string }

export async function applyAttendanceCorrection(
  svc: Svc,
  input: { periodId: string; employeeId: string; correction: ValidatedCorrection; actorId: string; /** IST date; defaults to now. */ today?: string },
): Promise<CorrectionApplied | CorrectionRefused> {
  const { periodId, employeeId, correction, actorId } = input

  let period: Awaited<ReturnType<typeof fetchPeriod>>
  try { period = await fetchPeriod(svc, periodId) }
  catch { return { ok: false, status: 404, error: 'Payroll period not found' } }

  // A locked month is final here, whatever the caller checked.
  if ((period.status as string) === 'locked') {
    return { ok: false, status: 422, error: 'Payroll for this period is locked. Attendance can no longer be corrected.' }
  }

  // A correction recalculates and WRITES the month's result, so it obeys the
  // same month-end rule as generation.
  if (!isPayrollMonthComplete(period.payroll_year, period.payroll_month, input.today)) {
    return { ok: false, status: 422, error: monthInProgressMessage(period.payroll_year, period.payroll_month, 'corrected') }
  }

  // The date must belong to the period being corrected, or the recalculation
  // would write a result that does not contain the change.
  const [dYear, dMonth] = correction.attendance_date.split('-').map(Number)
  if (dYear !== period.payroll_year || dMonth !== period.payroll_month) {
    return { ok: false, status: 400, error: 'The attendance date is not inside this payroll period.' }
  }

  const employee = await fetchEmployee(svc, employeeId)
  if (!employee) return { ok: false, status: 404, error: 'Employee not found' }

  let attendance:  Awaited<ReturnType<typeof fetchAttendanceForPeriod>>
  let holidays:    Awaited<ReturnType<typeof fetchHolidaysForPeriod>>
  let adjustments: Awaited<ReturnType<typeof fetchPendingAdjustments>>
  let existing:    Awaited<ReturnType<typeof fetchCurrentCorrections>>
  let redemptions: Awaited<ReturnType<typeof fetchActiveAttendanceRedemptions>>
  let settings:    ReturnType<typeof settingsForPeriod>
  try {
    let active: Awaited<ReturnType<typeof fetchActiveSettings>>
    let periodCtx: Awaited<ReturnType<typeof fetchPeriodSettingsContext>>
    ;[attendance, holidays, adjustments, existing, redemptions, active, periodCtx] = await Promise.all([
      fetchAttendanceForPeriod(svc, employeeId, period.payroll_month, period.payroll_year),
      fetchHolidaysForPeriod(svc, period.payroll_month, period.payroll_year),
      fetchPendingAdjustments(svc, employeeId, periodId, period.payroll_month, period.payroll_year),
      fetchCurrentCorrections(svc, employeeId, period.payroll_month, period.payroll_year),
      // Days the employee covered with BOE Credits stay covered through a
      // correction; the recalculation below must not charge them again.
      fetchActiveAttendanceRedemptions(svc, employeeId, period.payroll_month, period.payroll_year),
      fetchActiveSettings(svc),
      fetchPeriodSettingsContext(svc, periodId),
    ])
    settings = settingsForPeriod(periodCtx, active.settings)
  } catch (e) {
    return { ok: false, status: 500, error: String(e) }
  }

  const run = (
    corrections: Parameters<typeof generatePayrollForEmployee>[5],
    coverage: Parameters<typeof generatePayrollForEmployee>[7] = redemptions,
  ) =>
    generatePayrollForEmployee(employee as EngineEmployee, period, attendance, holidays, adjustments, corrections, settings, coverage)

  const before = run(existing)
  if (isSkip(before)) {
    return { ok: false, status: 422, error: `Payroll cannot be calculated for this employee (${before.reason}).` }
  }
  const beforeSnapshot = snapshotDay(before.day_results, correction.attendance_date, before.net_salary)

  const nextCorrections = [
    ...existing.filter(c => c.attendance_date !== correction.attendance_date),
    toEngineCorrection(correction),
  ]
  const after = run(nextCorrections)
  if (isSkip(after)) {
    return { ok: false, status: 422, error: `Payroll cannot be calculated for this employee (${after.reason}).` }
  }
  const afterSnapshot = snapshotDay(after.day_results, correction.attendance_date, after.net_salary)

  const previous = existing.find(c => c.attendance_date === correction.attendance_date) ?? null

  // ── Write ─────────────────────────────────────────────────────────────────
  // Order is forced by the partial unique index on (user_id, attendance_date)
  // WHERE is_current: retire the previous version BEFORE inserting the new one.
  // Both writes are rolled back by hand on failure — there is no transaction
  // spanning them — so a failed save leaves the previous correction current
  // and payroll untouched.
  const audit = buildCorrectionAudit(beforeSnapshot, afterSnapshot)

  if (previous) {
    const { error: supersedeErr } = await svc
      .from('attendance_day_corrections')
      .update({ is_current: false, superseded_at: new Date().toISOString() })
      .eq('id', previous.id)
      .eq('is_current', true)
    if (supersedeErr) {
      return { ok: false, status: 500, error: `Failed to retire the previous correction: ${supersedeErr.message}` }
    }
  }

  const { data: inserted, error: insertErr } = await svc
    .from('attendance_day_corrections')
    .insert({
      user_id:                employeeId,
      attendance_date:        correction.attendance_date,
      corrected_check_in_at:  correction.corrected_check_in_at,
      corrected_check_out_at: correction.corrected_check_out_at,
      day_treatment:          correction.day_treatment,
      waive_late_arrival:     correction.waive_late_arrival,
      waive_early_checkout:   correction.waive_early_checkout,
      waive_missing_punch:    correction.waive_missing_punch,
      remark:                 correction.remark,
      payroll_period_id:      periodId,
      corrected_by:           actorId,
      ...audit,
    })
    .select('id')
    .single()

  if (insertErr || !inserted) {
    if (previous) await restorePrevious(svc, previous.id)
    const duplicate = (insertErr?.code === '23505')
    return {
      ok: false,
      status: duplicate ? 409 : 500,
      error: duplicate
        ? 'This date was corrected by someone else a moment ago. Reload and try again.'
        : `Failed to save the correction: ${insertErr?.message ?? 'unknown error'}`,
    }
  }

  const correctionId = (inserted as { id: string }).id

  if (previous) {
    const { error: linkErr } = await svc
      .from('attendance_day_corrections')
      .update({ superseded_by: correctionId })
      .eq('id', previous.id)
    if (linkErr) console.error('[payroll/attendance-correction] superseded_by link:', linkErr.message)
  }

  // ── BOE Credits coverage follows the corrected attendance ─────────────────
  let settled = after
  try {
    const reconciled = await reconcileAttendanceCoverage(svc, {
      employeeId,
      periodId,
      month: period.payroll_month,
      year:  period.payroll_year,
      actorId: actorId,
      run: coverage => run(nextCorrections, coverage),
    })
    if (!isSkip(reconciled.outcome)) settled = reconciled.outcome
    for (const f of reconciled.failures) {
      console.error('[payroll/attendance-correction] credit coverage:', f.action.action, f.error)
    }
  } catch (e) {
    await rollback(svc, correctionId, previous?.id)
    return {
      ok: false,
      status: 500,
      error: 'The correction was not saved: the BOE Credits coverage for this month could not be reconciled. ' +
        `Nothing was changed. (${String(e)})`,
    }
  }

  // ── Recalculate ───────────────────────────────────────────────────────────
  try {
    const generationId = await createGenerationRow(svc, periodId, actorId)
    const resultId     = await writeEngineResult(svc, generationId, settled)
    await markAdjustmentsApplied(svc, settled.applied_adjustment_ids, resultId, periodId)
    await finalizeGenerationRow(svc, generationId, {
      status: 'done',
      employee_count: 1,
      skipped_count: 0,
      failed_employee_ids: [],
    }).catch(err => console.error('[payroll/attendance-correction] finalizeGenerationRow:', err))
  } catch (e) {
    await rollback(svc, correctionId, previous?.id)
    return {
      ok: false,
      status: 500,
      error: 'The correction was not saved: payroll could not be recalculated. ' +
        `Nothing was changed. (${String(e)})`,
    }
  }

  return {
    ok: true,
    correction_id: correctionId,
    attendance_date: correction.attendance_date,
    before: beforeSnapshot,
    after:  afterSnapshot,
    net_salary: settled.net_salary,
    total_deductions: settled.total_deductions,
  }
}

function snapshotDay(days: EngineDay[], date: string, netSalary: number): DaySnapshot {
  const day = days.find(d => d.date === date)
  return {
    check_in_at:      day?.check_in_at  ?? null,
    check_out_at:     day?.check_out_at ?? null,
    classification:   day?.classification ?? null,
    deduction_amount: day?.total_deduction_amount ?? 0,
    net_salary:       netSalary,
  }
}

/**
 * Undo the correction write after a failed recalculation. Deleting the new row
 * is sound: it never took effect, so keeping it would misrepresent payroll as
 * corrected when it is not.
 */
async function rollback(svc: Svc, correctionId: string, previousId?: string): Promise<void> {
  try {
    await svc.from('attendance_day_corrections').delete().eq('id', correctionId)
    if (previousId) await restorePrevious(svc, previousId)
  } catch (e) {
    console.error('[payroll/attendance-correction] rollback failed:', e)
  }
}

async function restorePrevious(svc: Svc, previousId: string): Promise<void> {
  const { error } = await svc
    .from('attendance_day_corrections')
    .update({ is_current: true, superseded_at: null, superseded_by: null })
    .eq('id', previousId)
  if (error) console.error('[payroll/attendance-correction] restorePrevious failed:', error.message)
}
