// BOE Credits coverage lifecycle (Phase 1C): credits stay spent only while
// there is a chargeable deduction for that employee and date.
//
// A redemption is bought against the deduction the payslip showed at the
// time. Attendance moves afterwards — an admin corrects the day, a re-import
// changes the punches, paid leave absorbs the day — and the deduction the
// credits paid for can stop existing, or change size. Every path that
// re-runs the engine WITH WRITE INTENT (the attendance-correction route and
// payroll generation) reconciles the employee's active coverage against the
// engine's settled lines before it writes:
//
//   * a redeemed day that is no longer a chargeable Absent or Half Day
//     (Present, company-paid, ₹0, or a half-day coverage on a day that became
//     a full absence) → the redemption is REVERSED and the credits restored;
//   * a day redeemed as Absent that became a Half Day → the 2-credit row is
//     reversed and a fresh 1-credit redemption is posted, so the employee is
//     charged what the day now costs and stays covered.
//
// Both go through the database's two functions, so the original row, its
// reversal and any re-priced row all stay in the employee's history; no
// ledger amount is ever edited and no balance is adjusted by hand.
//
// The planner is pure and tested on its own; the executor runs the plan and
// re-runs the engine so the caller writes a result that matches the ledger.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { EngineOutcome, EngineResult, PendingDeductionLine } from './types'
import { isSkip } from './types'
import { fetchActiveAttendanceRedemptions, type StoredAttendanceRedemption } from './store'
import {
  ATTENDANCE_REDEMPTION_COST,
  REDEEMABLE_DEDUCTION_LABELS,
  isRedeemableDeductionType,
  type AttendanceCreditRedemption,
  type RedeemableDeductionType,
} from '../boeCredits/attendanceRedemption'
import { redeemAttendanceDay, reverseAttendanceRedemption } from '../boeCredits/service'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = SupabaseClient<any, any, any>

export type CoverageAction =
  | { action: 'reverse'; redemption: StoredAttendanceRedemption; reason: string }
  | { action: 'reprice'; redemption: StoredAttendanceRedemption; new_type: RedeemableDeductionType; reason: string }

function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

/**
 * What must happen to each active redemption so that the ledger agrees with
 * the engine's settled lines.
 *
 * `lines` are the FINAL deduction lines of a run that was given exactly
 * `active` as its coverage, so a covered day carries a line marked
 * `waived_by: 'boe_credits'`; a redeemed day with no such line is one the
 * engine could not apply the coverage to.
 */
export function planCoverageReconciliation(
  active: readonly StoredAttendanceRedemption[],
  lines: readonly PendingDeductionLine[],
): CoverageAction[] {
  const actions: CoverageAction[] = []
  for (const r of active) {
    const dayLine = lines.find(l => l.line_date === r.attendance_date && isRedeemableDeductionType(l.deduction_type))
    const when = dayLabel(r.attendance_date)
    const bought = REDEEMABLE_DEDUCTION_LABELS[r.deduction_type]

    if (dayLine && dayLine.waived_by === 'boe_credits') {
      // Covered. The only thing that can still be wrong is the price: an
      // absent-day redemption now covering a half day.
      const nowType = dayLine.deduction_type as RedeemableDeductionType
      if (ATTENDANCE_REDEMPTION_COST[nowType] !== r.credits) {
        actions.push({
          action: 'reprice', redemption: r, new_type: nowType,
          reason: `Attendance changed: ${when} is now a ${REDEEMABLE_DEDUCTION_LABELS[nowType]}, not ${bought} — re-priced from ${r.credits} to ${ATTENDANCE_REDEMPTION_COST[nowType]}`,
        })
      }
      continue
    }

    if (!dayLine) {
      actions.push({ action: 'reverse', redemption: r, reason: `Attendance changed: ${when} no longer carries a salary deduction — credits restored` })
    } else if (dayLine.waived_by != null || dayLine.amount_deducted <= 0) {
      actions.push({ action: 'reverse', redemption: r, reason: `Attendance changed: ${when} is now covered by paid leave — credits restored` })
    } else {
      // A chargeable line the coverage did not apply to: a half-day
      // redemption on a day that became a full absence. Restore the credits;
      // the employee may cover the full day again at its own price.
      actions.push({
        action: 'reverse', redemption: r,
        reason: `Attendance changed: ${when} is now ${REDEEMABLE_DEDUCTION_LABELS[dayLine.deduction_type as RedeemableDeductionType]}, not ${bought} — credits restored`,
      })
    }
  }
  return actions
}

export type CoverageReconciliation = {
  /** The active coverage after the plan ran — what the caller must write against. */
  redemptions: StoredAttendanceRedemption[]
  /** The engine's outcome over that coverage. */
  outcome: EngineOutcome
  /** What was done, in order. */
  actions: CoverageAction[]
  /** Actions that failed, with the failure; the caller decides what to say. */
  failures: { action: CoverageAction; error: string }[]
}

/**
 * Reconcile one employee-month's coverage against the engine, then re-run
 * the engine over what is left.
 *
 * `run` is the caller's engine invocation with everything but the coverage
 * already bound (period, attendance, holidays, adjustments, corrections,
 * settings), so the reconciliation sees exactly the calculation the caller
 * is about to write. `actorId` is the administrator whose correction or
 * regeneration this is — every reversal needs an active admin and a reason,
 * as the foundation requires of reversals.
 *
 * Each action is its own database transaction. A failure is recorded and the
 * rest proceed; the coverage is re-read afterwards, so the caller always
 * writes against what the ledger actually holds. If the engine skips (no
 * salary, excluded employee) nothing is touched.
 */
export async function reconcileAttendanceCoverage(
  svc: Svc,
  input: {
    employeeId: string
    periodId: string
    month: number
    year: number
    actorId: string
    run: (coverage: AttendanceCreditRedemption[]) => EngineOutcome
  },
): Promise<CoverageReconciliation> {
  const { employeeId, periodId, month, year, actorId, run } = input

  const active = await fetchActiveAttendanceRedemptions(svc, employeeId, month, year)
  const first = run(active)
  if (active.length === 0 || isSkip(first)) {
    return { redemptions: active, outcome: first, actions: [], failures: [] }
  }

  const actions = planCoverageReconciliation(active, (first as EngineResult).deduction_lines)
  if (actions.length === 0) {
    return { redemptions: active, outcome: first, actions, failures: [] }
  }

  const failures: CoverageReconciliation['failures'] = []
  for (const a of actions) {
    try {
      await reverseAttendanceRedemption(svc, { redemptionId: a.redemption.id, actorId, reason: a.reason })
      if (a.action === 'reprice') {
        await redeemAttendanceDay(svc, {
          employeeId,
          payrollPeriodId: periodId,
          attendanceDate:  a.redemption.attendance_date,
          deductionType:   a.new_type,
          actorId,
        })
      }
    } catch (e) {
      failures.push({ action: a, error: String(e) })
      console.error('[payroll/creditCoverage] reconciliation action failed:', a.action, a.redemption.id, e)
    }
  }

  const remaining = await fetchActiveAttendanceRedemptions(svc, employeeId, month, year)
  return { redemptions: remaining, outcome: run(remaining), actions, failures }
}
