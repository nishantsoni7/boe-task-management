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
import { fetchActiveSettings, settingsForPeriod, type PeriodSettingsContext } from './settingsStore'
import { isSkip } from '@/lib/payroll/types'
import type { EngineEmployee } from '@/lib/payroll/types'
import {
  fetchAttendanceForPeriod,
  fetchHolidaysForPeriod,
  fetchCurrentCorrections,
  fetchActiveAttendanceRedemptions,
  fetchActivePayrollCreditApplication,
  type StoredPayrollCreditApplication,
} from '@/lib/payroll/store'
import { toDeductionDays, toConsideredDays, isCorrectableDay } from '@/lib/payroll/resultTabs'
import { attendanceRedemptionEligibility, type AttendanceRedemptionCosts, type RedeemableDate } from '@/lib/boeCredits/attendanceRedemption'
import { fetchActiveCreditSettings, getCreditBalance } from '@/lib/boeCredits/service'
import { DEFAULT_BOE_CREDIT_SETTINGS } from '@/lib/boeCredits/settings'
import { istToday } from '@/lib/istDate'
import { toSignedAdjustment, type StoredAdjustment } from '@/lib/payroll/adjustments'
import {
  computeSettlement,
  adjustmentsReconcile,
  closingBalanceSentence,
  type SettlementCreditInput,
} from '@/lib/payroll/settlement'
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
 *
 * `credits` is the ACTIVE BOE Credits payroll application (Phase 1D) — the
 * third input to the arithmetic. It is carried into the block so the screen
 * can say "5 credits at ₹100" beside the figure it explains.
 */
export function buildSettlementBlock(
  result: SettlementResultFigures,
  settlementRow: SettlementRow | null,
  credits: SettlementCreditInput = null,
) {
  const figures = computeSettlement(
    {
      gross_salary:             result.gross_salary,
      total_deductions:         result.total_deductions,
      pending_adjustment_total: result.pending_adjustment_total,
      days_present:             result.days_present,
    },
    settlementRow,
    credits,
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
    // The credits behind the addition, as stored. Null when none is active.
    credits: credits
      ? {
          credits_used: credits.credits_used,
          credit_value: credits.credit_value_snapshot,
          amount:       credits.credit_amount_snapshot,
        }
      : null,
  }
}

/**
 * The employee's BOE Credits standing for THIS payroll month (Phase 1D):
 * what they hold, the current rate, whether they may apply, and what is
 * applied. Display only — apply_boe_credits_to_payroll() decides again.
 */
export type PayrollCreditsBlock = {
  /** The figure a new application may spend. */
  spendable_credits: number
  provisional_credits: number
  /** Rupees per credit for a NEW application, from the active settings. */
  credit_value: number
  /** False when the period is locked or has no generated result. */
  can_apply: boolean
  locked: boolean
  application: {
    id: string
    credits_used: number
    credit_value: number
    amount: number
    created_at: string
  } | null
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
    canRedeem = false,
  }: {
    periodId: string
    employeeId: string
    /** Whether this reader may correct an attendance day. Display only. */
    canEdit: boolean
    /** Why not, when they may not. Shown to admins; employees are not told. */
    editBlocked: string | null
    /**
     * Whether this reader is the EMPLOYEE, who may cover a day with BOE
     * Credits (Phase 1C) and apply credits to payroll (Phase 1D). Display
     * only, like canEdit: the routes re-decide before anything is written.
     */
    canRedeem?: boolean
  },
): Promise<ResultDetailOutcome> {
  const { data: period, error: periodErr } = await svc
    .from('payroll_periods')
    .select('id, payroll_month, payroll_year, status, locked_at, settings_snapshot')
    .eq('id', periodId)
    .single()

  if (periodErr || !period) return { ok: false, status: 404, error: 'Payroll period not found' }

  // Three independent reads, started together: the result, its settlement row,
  // and the active credit application — the three inputs of the settlement.
  const [
    { data: result, error: resultErr },
    settlementRead,
    creditApplication,
    creditSettings,
  ] = await Promise.all([
    svc
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
      .maybeSingle(),
    // Read, never written, on this path: opening a payslip must not create or
    // change a financial record. A month with no settlement row yet computes as
    // no carry-forward and no payment recorded, which is exactly what it means.
    // Degrades rather than failing the payslip: a payroll detail that 500s
    // because a settlement table is missing would take the deduction ledger
    // down with it.
    fetchSettlement(svc, periodId, employeeId).catch((e: unknown) => {
      console.error('[payroll/detail] settlement unavailable:', e)
      return null as SettlementRow | null
    }),
    fetchActivePayrollCreditApplication(svc, periodId, employeeId).catch((e: unknown) => {
      console.error('[payroll/detail] credit application unavailable:', e)
      return null as StoredPayrollCreditApplication | null
    }),
    // The active credit settings: the attendance prices the offer is quoted
    // at, and the rate a new payroll application would use. Never throws.
    fetchActiveCreditSettings(svc),
  ])

  if (resultErr) return { ok: false, status: 500, error: resultErr.message }
  if (!result)   return { ok: false, status: 404, error: 'Result not found' }

  const [{ data: lines, error: linesErr }, { data: adjustments, error: adjErr }] = await Promise.all([
    svc
      .from('payroll_deduction_lines')
      .select('id, line_date, deduction_type, hours_deducted, amount_deducted')
      .eq('payroll_result_id', result.id)
      .order('line_date', { ascending: true }),
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
    svc
      .from('payroll_pending_adjustments')
      .select('id, description, amount, adjustment_type, status')
      .eq('payroll_result_id', result.id)
      .neq('status', 'cancelled'),
  ])

  if (linesErr) return { ok: false, status: 500, error: linesErr.message }
  if (adjErr)   return { ok: false, status: 500, error: adjErr.message }

  type SignedAdjustment = { id: string; description: string; amount: number; status: string }

  const signedAdjustments: SignedAdjustment[] = (adjustments ?? []).map(
    (row: StoredAdjustment & { status: string }) => ({
      id:          row.id,
      description: row.description ?? '',
      amount:      toSignedAdjustment(row).amount,
      status:      row.status,
    }),
  )

  const settlementBlock = buildSettlementBlock(result, settlementRead, creditApplication)
  const figures = settlementBlock.figures

  // The itemised rows must add up to the total the engine applied. When they do
  // not, the two are being read differently and one of them is wrong — so say so
  // rather than render a breakdown that silently disagrees with its own total.
  const adjustmentsBalance = adjustmentsReconcile(
    signedAdjustments.map(a => a.amount),
    figures.other_adjustments,
  )

  const u = result.users as unknown as { full_name: string; employee_code: string | null } | null

  const [dayView, creditsBlock] = await Promise.all([
    buildDayView(svc, {
      employeeId,
      month: period.payroll_month,
      year:  period.payroll_year,
      storedTotalDeductions: result.total_deductions,
      period: { status: period.status, settings_snapshot: period.settings_snapshot },
      canRedeem,
      costs: creditSettings.settings,
    }),
    // The employee's own standing only: the admin's view carries the stored
    // application (above) and nothing about what the employee could still do.
    canRedeem
      ? buildCreditsBlock(svc, {
          employeeId,
          periodStatus: period.status,
          creditValue: creditSettings.settings.credit_value,
          application: creditApplication,
        })
      : Promise.resolve(null),
  ])

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
      can_redeem:   canRedeem && period.status !== 'locked',
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
      // The employee's BOE Credits standing for this month (Phase 1D). Null on
      // the admin's view.
      credits: creditsBlock,
      ...dayView,
    },
  }
}

// ─── The credits block ────────────────────────────────────────────────────────

async function buildCreditsBlock(
  svc: Svc,
  input: {
    employeeId: string
    periodStatus: 'draft' | 'generated' | 'locked'
    creditValue: number
    application: StoredPayrollCreditApplication | null
  },
): Promise<PayrollCreditsBlock | null> {
  try {
    const balance = await getCreditBalance(svc, input.employeeId)
    const locked = input.periodStatus === 'locked'
    return {
      spendable_credits:   balance.spendable_credits,
      provisional_credits: balance.provisional_credits,
      credit_value:        input.creditValue,
      can_apply:           !locked && input.periodStatus === 'generated',
      locked,
      application: input.application
        ? {
            id:           input.application.id,
            credits_used: input.application.credits_used,
            credit_value: input.application.credit_value_snapshot,
            amount:       input.application.credit_amount_snapshot,
            created_at:   input.application.created_at,
          }
        : null,
    }
  } catch (e) {
    // The payslip must not fail because the credits could not be read; the
    // section simply does not appear and the figures above stand on their own.
    console.error('[payroll/detail] credits block unavailable:', e)
    return null
  }
}

// ─── Day-level view ───────────────────────────────────────────────────────────

type DayViewInput = {
  employeeId: string
  month: number
  year: number
  storedTotalDeductions: number | null
  /** Decides which settings the day rows are computed under. */
  period: PeriodSettingsContext
  /** Whether to list the dates this reader could cover with BOE Credits. */
  canRedeem: boolean
  /** The active attendance prices, for the offer. */
  costs: AttendanceRedemptionCosts
}

async function buildDayView(
  svc: Svc,
  { employeeId, month, year, storedTotalDeductions, period, canRedeem, costs }: DayViewInput,
) {
  const empty = {
    deduction_days:  [],
    considered_days: [],
    corrections:     [],
    correctable_dates: [],
    redeemable_dates: [] as RedeemableDate[],
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
    const [attendance, holidays, corrections, redemptions, active] = await Promise.all([
      fetchAttendanceForPeriod(svc, employeeId, month, year),
      fetchHolidaysForPeriod(svc, month, year),
      fetchCurrentCorrections(svc, employeeId, month, year),
      fetchActiveAttendanceRedemptions(svc, employeeId, month, year),
      // The SAME settings the stored money was produced under.
      //
      // This run used to pass no settings at all, so the day rows were computed
      // with today's defaults while the stored totals came from the period's
      // snapshot. Any divergence between the two then read as "attendance changed
      // after generation" — the staleness test below compares exactly these
      // numbers — when it might equally have been a settings edit. Worse, on a
      // period whose snapshot differs from the defaults the rows could disagree
      // with the payslip permanently, with nothing to explain it.
      fetchActiveSettings(svc),
    ])

    const settings = settingsForPeriod(period, active.settings)

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
      settings,
      // The BOE Credits coverage layer: a covered day renders at ₹0 with the
      // credits spent, and the staleness test below sees a redemption the
      // stored money predates exactly as it sees an attendance change.
      redemptions,
    )

    if (isSkip(outcome)) return { ...empty, day_view_error: `Payroll skipped: ${outcome.reason}` }

    const rawByDate = new Map(attendance.map(a => [a.attendance_date, a]))

    // Which dates the EMPLOYEE could cover with credits, by the same rule the
    // redemption route applies before it writes, at the active price. Listed
    // only for the employee reader on an unlocked month; an empty list is the
    // answer otherwise.
    const today = istToday()
    const redeemableDates: RedeemableDate[] = canRedeem && period.status !== 'locked'
      ? outcome.day_results.flatMap(day => {
          const e = attendanceRedemptionEligibility(day, {
            periodStatus: period.status, today, periodMonth: month, periodYear: year, costs: costs ?? DEFAULT_BOE_CREDIT_SETTINGS,
          })
          return e.eligible
            ? [{ date: day.date, deduction_type: e.deduction_type, credits: e.credits, amount: e.amount }]
            : []
        })
      : []

    return {
      deduction_days:  toDeductionDays(outcome.day_results),
      considered_days: toConsideredDays(outcome.day_results),
      correctable_dates: outcome.day_results.filter(isCorrectableDay).map(d => d.date),
      redeemable_dates: redeemableDates,
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
