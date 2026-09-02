// Payroll Result Detail — what belongs in which tab.
//
// One rule, applied once, so the two tabs cannot both claim a date or both
// disown it: a date sits in Deductions when a payroll rule fired on it, and in
// Days Considered when it was counted as paid or present.
//
// The bug this rule replaces
// --------------------------
// "Deductions" used to mean `total_deduction_amount > 0`. That looked right and
// was not: when the month's paid leave absorbed an absent day, the engine set
// that line's amount to 0, so the date failed this test — and `full_absent` is
// not in PAID_CLASSIFICATIONS either, so it failed the Days Considered test too.
// The date fell out of BOTH tabs and simply disappeared from the payroll detail.
// It was reproducible across employees and months (21 July 2026 for one
// employee, 29 July for four others, 16 June, 14 May …) and it hid exactly the
// thing an employee most needs to see: the day the company paid for them.
//
// So a date now also belongs in Deductions when a rule charged for it and paid
// leave cancelled the charge. Those lines carry `waived_by: 'paid_leave'` and
// ₹0, and they add nothing to any total.
//
// The tabs are a view over the engine's day-level output; nothing here
// recalculates anything.

import type { EngineDay, DayClassification, PendingDeductionLine } from './types'

/** Statuses that are paid or otherwise positively counted for the month. */
const PAID_CLASSIFICATIONS = new Set<DayClassification>([
  'full_present',
  'present_with_shortfall',
  'short_present',
  'missing_punch',   // still a present day; only the punch is missing
  'half_day',        // half the day is paid, so it is counted here as well
  'weekly_off',
  'holiday',
])

export type DeductionDay = {
  date: string
  classification: DayClassification
  lines: PendingDeductionLine[]
  total_amount: number
  is_corrected: boolean
  check_in_at: string | null
  check_out_at: string | null
}

export type ConsideredDay = {
  date: string
  classification: DayClassification
  effective_hours_worked: number
  /** 1, 0.5 or 0 — what the date is worth as a payable day. */
  payable_day_value: number
  is_corrected: boolean
  check_in_at: string | null
  check_out_at: string | null
}

/** True when a line on this date was covered by the month's paid leave. */
export function isCompanyPaidLine(line: PendingDeductionLine): boolean {
  return line.waived_by === 'paid_leave'
}

/** True when a line on this date was covered with BOE Credits (Phase 1C). */
export function isCreditCoveredLine(line: PendingDeductionLine): boolean {
  return line.waived_by === 'boe_credits'
}

/** True when a rule charged for the line and something cancelled the charge. */
export function isWaivedLine(line: PendingDeductionLine): boolean {
  return isCompanyPaidLine(line) || isCreditCoveredLine(line)
}

/**
 * True when a payroll rule fired on this date — whether the employee paid for
 * it, the company did, or the employee's credits did.
 */
export function isDeductionDay(day: EngineDay): boolean {
  return day.total_deduction_amount > 0 || day.deduction_lines.some(isWaivedLine)
}

/**
 * True when the date was counted as paid or present.
 *
 * A date can be both: a half day is half paid and half deducted, and a late
 * arrival is a full present day that still carries an hourly cut. That overlap
 * is deliberate — management asked to see what was deducted AND what was
 * counted, and hiding a deducted day from Days Considered would understate the
 * days the employee actually worked.
 */
export function isConsideredDay(day: EngineDay): boolean {
  if (day.classification === 'pre_joining') return false
  return PAID_CLASSIFICATIONS.has(day.classification)
}

export function payableDayValue(classification: DayClassification): number {
  switch (classification) {
    case 'full_present':
    case 'present_with_shortfall':
    case 'short_present':
    case 'missing_punch':
      return 1
    case 'half_day':
      return 0.5
    // A weekly off or a company holiday is paid but is not a worked day, so it
    // adds nothing to the payable-day count.
    default:
      return 0
  }
}

export function toDeductionDays(days: EngineDay[]): DeductionDay[] {
  return days.filter(isDeductionDay).map(day => ({
    date: day.date,
    classification: day.classification,
    // A ₹0 line survives only when a stated waiver is the reason it is ₹0 —
    // paid leave or BOE Credits. Any other zero-amount line is noise on an
    // audit table.
    lines: day.deduction_lines.filter(l => l.amount_deducted > 0 || isWaivedLine(l)),
    total_amount: day.total_deduction_amount,
    is_corrected: day.is_corrected,
    check_in_at: day.check_in_at,
    check_out_at: day.check_out_at,
  }))
}

export function toConsideredDays(days: EngineDay[]): ConsideredDay[] {
  return days.filter(isConsideredDay).map(day => ({
    date: day.date,
    classification: day.classification,
    effective_hours_worked: day.effective_hours_worked,
    payable_day_value: payableDayValue(day.classification),
    is_corrected: day.is_corrected,
    check_in_at: day.check_in_at,
    check_out_at: day.check_out_at,
  }))
}

/**
 * Dates an admin may open the correction modal on.
 *
 * Weekly offs, holidays and pre-joining dates are excluded from payroll
 * entirely, so there is nothing on them for a correction to change.
 */
export function isCorrectableDay(day: EngineDay): boolean {
  return (
    day.classification !== 'weekly_off' &&
    day.classification !== 'holiday' &&
    day.classification !== 'pre_joining'
  )
}
