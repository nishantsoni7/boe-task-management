// Salary settlement — what BOE owes for a month, and what it actually paid.
//
// WHY THIS IS A SEPARATE LAYER FROM THE ENGINE
// -------------------------------------------
// The engine answers "what did this month earn". Settlement answers "what is
// still outstanding". Keeping them apart is what lets an admin record a payment
// without rerunning attendance: nothing in this file is an engine input, and
// nothing here can move a deduction, a gross salary or a day classification.
//
// THE DOUBLE-COUNTING TRAP, AND HOW THIS AVOIDS IT
// ------------------------------------------------
// `payroll_results.net_salary` ALREADY includes Other Adjustments — engine.ts
// computes `max(0, gross − deductions + net_adjustment)`. So the obvious
// formula, `net_salary + carry_forward`, counts every manual adjustment twice
// the moment a carry-forward exists. It is not a subtle failure either: an
// employee with a +₹800 reimbursement would see it in Salary After Attendance
// AND again in Net Adjustments.
//
// This module therefore builds from the stored PRIMITIVES and never from
// net_salary:
//
//   salary_after_attendance = gross_salary − total_deductions
//   net_adjustments         = carry_forward + other_adjustments
//   boe_credit_addition     = the ACTIVE payroll credit application's rupee
//                             snapshot (Phase 1D), or 0
//   salary_payable          = salary_after_attendance + net_adjustments
//                             + boe_credit_addition
//   closing_balance         = salary_payable − amount_paid
//
// `other_adjustments` is `pending_adjustment_total`, the signed total the engine
// itself applied. Carry-forward is NEVER stored as a payroll_pending_adjustments
// row, so it can never leak into that total. Each figure is used exactly once,
// by construction rather than by care.
//
// THE BOE CREDIT ADDITION (Phase 1D)
// ----------------------------------
// An employee may turn spendable BOE Credits into rupees for a payroll month:
// credits × the credit value at that moment, both SNAPSHOTTED on
// boe_credit_payroll_applications. It is a Settlement line, deliberately:
// it does not touch gross salary, attendance, any deduction or net_salary,
// and it is not capped by any of them — an employee with no deduction at all
// may still add ₹500 to a ₹30,000 month and be owed ₹30,500. It is read from
// the stored snapshot, so a later settings change or a payroll regeneration
// never re-prices it.
//
// TWO DELIBERATE DIVERGENCES FROM net_salary
// ------------------------------------------
// The engine clamps twice, and settlement honours neither clamp:
//
//  1. `Math.max(0, …)`. A recovery larger than the month's pay leaves net_salary
//     at ₹0 while the employee genuinely owes BOE the difference. Settlement
//     needs that negative number — it is what "already paid in advance" means —
//     so Salary Payable is computed pre-clamp and may go below zero.
//
//  2. `days_present === 0 → net_salary = 0`. The floor is an ATTENDANCE rule, so
//     it is applied to Salary After Attendance, where it belongs. It stops
//     there: a +₹2,000 balance owed from June does not evaporate because the
//     employee was absent for the whole of July. (Confirmed as the intended
//     business meaning before this was written.)
//
// net_salary itself is not recalculated, not rewritten, and keeps its column.
// It simply stops being the final figure the UI presents.

// ─── Inputs ───────────────────────────────────────────────────────────────────

/**
 * The parts of a stored payroll_results row settlement reads.
 *
 * Nullable throughout because the columns are nullable until a period is
 * generated. `days_present` is here only to apply the absence floor.
 */
export type SettlementResultInput = {
  gross_salary: number | null
  total_deductions: number | null
  /** The signed total the ENGINE applied. Not recomputed from the rows. */
  pending_adjustment_total: number | null
  days_present: number | null
}

/** The stored settlement row, or nothing if one has not been created yet. */
export type SettlementRecordInput = {
  carry_forward_amount: number | null
  /** NULL means "not recorded yet" — deliberately different from 0. */
  amount_paid: number | null
} | null

/**
 * The ACTIVE BOE Credits payroll application for the month, or nothing.
 *
 * Only the rupee snapshot is money; the credits and the rate are carried so a
 * screen can say "5 credits at ₹100" beside the figure without re-deriving it.
 */
export type SettlementCreditInput = {
  credits_used: number
  credit_value_snapshot: number
  credit_amount_snapshot: number
} | null

// ─── Output ───────────────────────────────────────────────────────────────────

/**
 * Whether anybody has stated what was paid for this month.
 *
 * NOT the same question as "was anything paid". A recorded ₹0 is a decision;
 * an unrecorded month is an absence of one, and the two must never render alike.
 */
export type PaymentStatus = 'recorded' | 'not_recorded'

export type SettlementFigures = {
  gross_salary: number
  attendance_deductions: number
  /** gross − deductions, floored at 0 for a month with no attendance at all. */
  salary_after_attendance: number
  carry_forward: number
  /** The engine-applied total of manual additions and recoveries. */
  other_adjustments: number
  /** carry_forward + other_adjustments. */
  net_adjustments: number
  /** The rupee snapshot of the active BOE Credits application. 0 when none. */
  boe_credit_addition: number
  /** May be negative: a recovery can exceed the month's pay. */
  salary_payable: number
  /** Null until a payment has been recorded. */
  amount_paid: number | null
  /**
   * salary_payable − amount_paid. Positive = BOE owes.
   *
   * NULL when no payment has been recorded, and that is the whole point: there
   * is no closing balance yet, because nobody has said what was paid. Treating
   * the absent value as ₹0 — `COALESCE(amount_paid, 0)`, which this used to do —
   * manufactures a debt for the full Salary Payable on every month an admin has
   * simply not filled in yet, and then carries that invented debt into the next
   * month. Unknown is not zero.
   */
  closing_balance: number | null
  payment_status: PaymentStatus
}

/**
 * A stored figure, used as stored.
 *
 * NOT rounded here, deliberately. Since the whole-rupee rule every figure the
 * engine writes is already a whole rupee, so settlement inherits whole rupees
 * for free and its arithmetic stays exact.
 *
 * A row generated BEFORE that rule still carries paise, and it must keep them.
 * Rounding on read would restate a historical payslip an employee has already
 * been paid against — and it would do so inconsistently, because the stored
 * deduction LINES of that month are unrounded too, so a rounded total would stop
 * matching the column printed above it. An old month is self-consistent in its
 * own terms; the new rule applies to new generation and to an intentional
 * recalculation, not to reading history.
 */
function num(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Every figure the settlement view shows, from stored records only.
 *
 * Pure and total: a missing settlement row means no carry-forward and no
 * payment, and a missing credit application means no addition — which is the
 * correct reading of a month nobody has settled yet rather than a reason to
 * fail.
 */
export function computeSettlement(
  result: SettlementResultInput,
  settlement: SettlementRecordInput,
  credits: SettlementCreditInput = null,
): SettlementFigures {
  const gross      = num(result.gross_salary)
  const deductions = num(result.total_deductions)

  // The absence floor, applied where the rule belongs — to the attendance-derived
  // figure, not to the whole settlement. Without it a month of ~27 working days
  // charged at salary÷26 per day produces a NEGATIVE salary after attendance,
  // which is an artefact of the divisor rather than a debt the employee owes.
  const attendanceSalary = num(result.days_present) === 0 ? 0 : gross - deductions

  const otherAdjustments = num(result.pending_adjustment_total)
  const carryForward     = num(settlement?.carry_forward_amount)
  const netAdjustments   = carryForward + otherAdjustments

  // The stored snapshot, never credits × today's rate.
  const creditAddition = credits ? Math.max(0, num(credits.credit_amount_snapshot)) : 0

  // No Math.max here, on purpose. See the header.
  const salaryPayable = attendanceSalary + netAdjustments + creditAddition

  const amountPaid = settlement && settlement.amount_paid != null ? settlement.amount_paid : null

  // No payment recorded means no closing balance — not a balance of the whole
  // Salary Payable. A recorded ₹0, by contrast, IS a statement, and produces a
  // real balance for the full amount.
  const closingBalance = amountPaid == null ? null : salaryPayable - amountPaid

  return {
    gross_salary:            gross,
    attendance_deductions:   deductions,
    salary_after_attendance: attendanceSalary,
    carry_forward:           carryForward,
    other_adjustments:       otherAdjustments,
    net_adjustments:         netAdjustments,
    boe_credit_addition:     creditAddition,
    salary_payable:          salaryPayable,
    amount_paid:             amountPaid,
    closing_balance:         closingBalance,
    payment_status:          amountPaid == null ? 'not_recorded' : 'recorded',
  }
}

// ─── Carry forward ────────────────────────────────────────────────────────────

/**
 * What the next month should propose, given the prior month's closing balance.
 *
 * Two rules in one small function:
 *
 *   * A settled month's closing balance carries forward unchanged. The identity
 *     is trivial, but it is named so the direction of the sign is asserted in
 *     one place — getting it backwards turns every debt into an advance.
 *
 *   * A month whose payment was never recorded (`null`) carries NOTHING. It has
 *     no confirmed closing balance, so there is nothing to bring forward. The
 *     alternative — treating the unrecorded month as though ₹0 had been paid —
 *     would invent a debt for the entire Salary Payable and push it into the
 *     next month, where it would look like a considered figure. An unresolved
 *     prior settlement is surfaced to the admin instead of being guessed at.
 */
export function proposedCarryForwardFrom(closingBalance: number | null): number {
  return closingBalance ?? 0
}

/** Money comparison. Two figures are the same when they round to the same paisa. */
export function sameMoney(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005
}

// ─── Presentation ─────────────────────────────────────────────────────────────

/**
 * A signed money string with an explicit sign, e.g. "+₹2,000.00" / "−₹500.00".
 *
 * The sign is always printed for signed figures, so direction never depends on
 * colour — the requirement is that the text carries the meaning on its own.
 * U+2212 MINUS SIGN, not a hyphen: it aligns with digits in tabular figures.
 */
export function fmtSigned(amount: number): string {
  const magnitude = Math.abs(amount).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  if (sameMoney(amount, 0)) return `₹${magnitude}`
  return `${amount > 0 ? '+' : '−'}₹${magnitude}`
}

/** An unsigned money string, for figures that have no direction. */
export function fmtMoney(amount: number | null): string {
  if (amount == null) return '—'
  return '₹' + Math.abs(amount).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export type ClosingBalanceMeaning = 'owed_to_employee' | 'paid_in_advance' | 'settled' | 'unrecorded'

export function closingBalanceMeaning(figures: SettlementFigures): ClosingBalanceMeaning {
  if (figures.closing_balance == null) return 'unrecorded'
  if (sameMoney(figures.closing_balance, 0)) return 'settled'
  return figures.closing_balance > 0 ? 'owed_to_employee' : 'paid_in_advance'
}

/** What the settlement line reads when there is no balance to state. */
export const PAYMENT_NOT_RECORDED_LABEL = 'Not recorded'
export const SETTLEMENT_STATUS_NOT_RECORDED = 'Payment not recorded'

/**
 * The closing balance in a sentence, for the employee.
 *
 * Written for somebody with no payroll knowledge: it says who owes whom and what
 * happens next, never "closing balance" or "carry forward" on their own.
 */
export function closingBalanceSentence(figures: SettlementFigures): string {
  const amount = fmtMoney(figures.closing_balance)
  switch (closingBalanceMeaning(figures)) {
    case 'unrecorded':
      // Deliberately states no figure. Naming an amount here — even as "pending"
      // — would be the same invented debt the null closing balance exists to
      // prevent, just written in prose.
      return 'The payment for this month has not been recorded yet, so there is no closing balance.'
    case 'settled':
      return 'This month’s salary is fully settled.'
    case 'owed_to_employee':
      return `${amount} is currently pending from BOE.`
    case 'paid_in_advance':
      return `${amount} has already been paid in advance and will be adjusted against future salary.`
  }
}

// ─── Reconciliation ───────────────────────────────────────────────────────────

/**
 * Whether the itemised adjustments add up to the total the engine applied.
 *
 * This is the guard against the failure this whole module is shaped to avoid:
 * a list of adjustments that does not sum to `pending_adjustment_total` means
 * the two are being read differently, and one of them is wrong. It caught a real
 * defect — /api/payroll/results/detail selected the adjustment rows WITHOUT
 * `adjustment_type`, so every deduction rendered with a "+" while the total
 * correctly subtracted it.
 *
 * Callers pass already-signed amounts (see toSignedAdjustment in ./adjustments).
 */
export function adjustmentsReconcile(
  signedAmounts: number[],
  engineTotal: number,
): boolean {
  const sum = signedAmounts.reduce((total, amount) => total + amount, 0)
  return sameMoney(sum, engineTotal)
}
