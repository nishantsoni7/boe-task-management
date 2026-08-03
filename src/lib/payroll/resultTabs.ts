// Payroll Result Detail — what belongs in which tab.
//
// One rule, applied once, so the two tabs cannot both claim a date or both
// disown it: a date sits in Deductions when it actually reduced the salary,
// and in Days Considered otherwise. "Actually reduced" means a deduction line
// with money on it — a line whose amount was absorbed by paid leave costs the
// employee nothing and would be misleading under a red heading.
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

/** True when the date cost the employee money. */
export function isDeductionDay(day: EngineDay): boolean {
  return day.total_deduction_amount > 0
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
    lines: day.deduction_lines.filter(l => l.amount_deducted > 0),
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
