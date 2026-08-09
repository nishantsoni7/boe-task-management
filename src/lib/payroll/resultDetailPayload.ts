// The Payroll Result Detail payload, built once for both readers.
//
// An admin reviewing a payslip and the employee whose payslip it is are looking
// at the same document, so they are served from the same builder. What differs
// is not the content but the authority to act on it: the caller decides
// `canEdit`, and the route above decides WHO may ask for WHOSE result.
//
// This module never authorises anything. It takes an employee id that its
// caller has already established the right to read — /api/payroll/results/detail
// requires an admin, /api/payroll/my-result substitutes the caller's own id and
// cannot be pointed at anyone else. Passing an unchecked id here would be a bug
// in the route, and no check in this file would save it.
//
// Nothing here computes money for display. The stored result holds the totals
// and the deduction ledger; only the day CLASSIFICATIONS are recomputed, from
// the same engine and the same inputs the generation used, because the result
// row does not store them. `stale` reports the one case where the two can
// disagree rather than quietly showing a day view the money no longer matches.

import { generatePayrollForEmployee } from '@/lib/payroll/engine'
import { isSkip } from '@/lib/payroll/types'
import type { EngineEmployee } from '@/lib/payroll/types'
import {
  fetchAttendanceForPeriod,
  fetchHolidaysForPeriod,
  fetchCurrentCorrections,
} from '@/lib/payroll/store'
import { toDeductionDays, toConsideredDays, isCorrectableDay } from '@/lib/payroll/resultTabs'
import { toSignedAdjustment, type StoredAdjustment } from '@/lib/payroll/adjustments'
import { computeSettlement, adjustmentsReconcile, closingBalanceSentence } from '@/lib/payroll/settlement'
import { fetchSettlement, type SettlementRow } from '@/lib/payroll/settlementStore'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any

/** The four stored figures the settlement arithmetic needs from payroll_results. */
export type SettlementResultFigures = {
  gross_salary: number | null
  total_deductions: number | null
  pending_adjustment_total: number | null
  days_present: number | null
}

/**
 * The part of the `settlement` block that a settlement WRITE can change.
 *
 * Extracted so PATCH /api/payroll/settlement can answer with the confirmed
 * figures itself and the page does not have to re-fetch the whole payslip to
 * learn what it already caused. Both callers build it here, so the number shown
 * after saving and the number shown after a reload are the same number by
 * construction — a second, parallel implementation in the route is exactly how
 * those two would drift.
 *
 * `adjustments_balance` is deliberately NOT part of this. It reconciles the
 * itemised adjustment rows against the engine's applied total, and a
 * carry-forward or payment write touches neither, so it belongs to the payload
 * and stays put across a save.
 */
export function buildSettlementBlock(
  result: SettlementResultFigures,
  settlementRow: SettlementRow | null,
) {
  const figures = computeSettlement(
    {
      gross_salary:             result.gross_salary,
      total_deductions:         result.total_deductions,
      pending_adjustment_total: result.pending_adjustment_total,
      days_present:             result.days_present,
    },
    settlementRow,
  )

  return {
    figures,
    sentence: closingBalanceSentence(figures),
    carry_forward: settlementRow
      ? {
          proposed:         Number(settlementRow.proposed_carry_forward),
          is_manual:        settlementRow.carry_forward_is_manual,
          remark:           settlementRow.carry_forward_remark,
          source_period_id: settlementRow.carry_forward_source_period_id,
          set_at:           settlementRow.carry_forward_set_at,
        }
      : null,
    // Present only once a payment has actually been recorded. A settlement row
    // can exist with amount_paid NULL — created by generation to hold the
    // carry-forward — and that is not a payment.
    payment: settlementRow && settlementRow.amount_paid != null
      ? {
          payment_date: settlementRow.payment_date,
          remark:       settlementRow.payment_remark,
          recorded_at:  settlementRow.payment_recorded_at,
        }
      : null,
  }
}

export type ResultDetailFailure = { ok: false; status: number; error: string }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ResultDetailSuccess = { ok: true; payload: Record<string, any> }
export type ResultDetailOutcome = ResultDetailSuccess | ResultDetailFailure

export async function buildResultDetailPayload(
  svc: Svc,
  {
    periodId,
    employeeId,
    canEdit,
    editBlocked,
  }: {
    periodId: string
    employeeId: string
    /** Whether this reader may correct an attendance day. Display only. */
    canEdit: boolean
    /** Why not, when they may not. Shown to admins; employees are not told. */
    editBlocked: string | null
  },
): Promise<ResultDetailOutcome> {
  const { data: period, error: periodErr } = await svc
    .from('payroll_periods')
    .select('id, payroll_month, payroll_year, status, locked_at')
    .eq('id', periodId)
    .single()

  if (periodErr || !period) return { ok: false, status: 404, error: 'Payroll period not found' }

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
      employee_reviewed_at,
      users!payroll_results_employee_id_fkey (
        full_name,
        employee_code
      )
    `)
    .eq('payroll_period_id', periodId)
    .eq('employee_id', employeeId)
    .maybeSingle()

  if (resultErr) return { ok: false, status: 500, error: resultErr.message }
  if (!result)   return { ok: false, status: 404, error: 'Result not found' }

  const { data: lines, error: linesErr } = await svc
    .from('payroll_deduction_lines')
    .select('id, line_date, deduction_type, hours_deducted, amount_deducted')
    .eq('payroll_result_id', result.id)
    .order('line_date', { ascending: true })

  if (linesErr) return { ok: false, status: 500, error: linesErr.message }

  // `adjustment_type` is selected and the rows are converted to SIGNED amounts.
  //
  // It was not, and that was a live defect: since migration 20260636 the stored
  // `amount` is always POSITIVE with the direction in `adjustment_type`, so
  // reading `amount` raw made every manual deduction render with a "+". An
  // employee with a ₹500 advance recovery saw "+₹500" in the itemised list while
  // the Adjustments total correctly showed −₹500. Same class of bug that
  // toSignedAdjustment was written to kill, in the one path that never used it.
  //
  // Voided rows are excluded — a cancelled adjustment was never applied to this
  // payroll and must not appear as though it were.
  const { data: adjustments, error: adjErr } = await svc
    .from('payroll_pending_adjustments')
    .select('id, description, amount, adjustment_type, status')
    .eq('payroll_result_id', result.id)
    .neq('status', 'cancelled')

  if (adjErr) return { ok: false, status: 500, error: adjErr.message }

  type SignedAdjustment = { id: string; description: string; amount: number; status: string }

  const signedAdjustments: SignedAdjustment[] = (adjustments ?? []).map(
    (row: StoredAdjustment & { status: string }) => ({
      id:          row.id,
      description: row.description ?? '',
      amount:      toSignedAdjustment(row).amount,
      status:      row.status,
    }),
  )

  // ── Settlement ────────────────────────────────────────────────────────────
  // Read, never written, on this path: opening a payslip must not create or
  // change a financial record. A month with no settlement row yet computes as
  // no carry-forward and no payment recorded, which is exactly what it means.
  let settlementRow: SettlementRow | null = null
  try {
    settlementRow = await fetchSettlement(svc, periodId, employeeId)
  } catch (e) {
    // Degrades rather than failing the payslip: the settlement tables arrive in
    // migration 20260826000000, and a payroll detail that 500s because it has
    // not been applied yet would take the deduction ledger down with it.
    console.error('[payroll/detail] settlement unavailable:', e)
  }

  const settlementBlock = buildSettlementBlock(result, settlementRow)
  const figures = settlementBlock.figures

  // The itemised rows must add up to the total the engine applied. When they do
  // not, the two are being read differently and one of them is wrong — so say so
  // rather than render a breakdown that silently disagrees with its own total.
  const adjustmentsBalance = adjustmentsReconcile(
    signedAdjustments.map(a => a.amount),
    figures.other_adjustments,
  )

  const u = result.users as unknown as { full_name: string; employee_code: string | null } | null

  const dayView = await buildDayView(svc, {
    employeeId,
    month: period.payroll_month,
    year:  period.payroll_year,
    storedTotalDeductions: result.total_deductions,
  })

  return {
    ok: true,
    payload: {
      period: {
        id:            period.id,
        payroll_month: period.payroll_month,
        payroll_year:  period.payroll_year,
        status:        period.status,
        locked_at:     period.locked_at ?? null,
      },
      can_edit:     canEdit,
      edit_blocked: editBlocked,
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
        employee_reviewed_at:     result.employee_reviewed_at ?? null,
        deduction_lines:          lines ?? [],
        adjustments:              signedAdjustments,
      },
      // Everything the Adjustments & Settlement section shows, computed once,
      // server-side, from the stored records. The UI formats these and adds no
      // arithmetic of its own — which is what stops a displayed figure from
      // drifting away from the data model.
      settlement: {
        ...settlementBlock,
        adjustments_balance: adjustmentsBalance,
      },
      ...dayView,
    },
  }
}

// ─── Day-level view ───────────────────────────────────────────────────────────

type DayViewInput = {
  employeeId: string
  month: number
  year: number
  storedTotalDeductions: number | null
}

async function buildDayView(
  svc: Svc,
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
