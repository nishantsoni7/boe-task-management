// Turning one deduction line into three sentences an employee can check.
//
// The contract, and the reason this is a module and not JSX
// ---------------------------------------------------------
// Every number below comes from `line.explain`, which the payroll engine fills
// in as it charges the line. Nothing here multiplies, divides, rounds or
// re-derives anything — if this file did any arithmetic there would be two
// implementations of every payroll rule, and the one on screen would be the one
// nobody tests. What this file does is choose words and format values.
//
// The three questions a row has to answer, in order:
//   What happened?   → the punches, and what the day was classified as
//   Which rule?      → `rule`
//   How did that make this amount? → `calculation`, then `amount`
//
// A date with two reasons produces two of these, plus a total. Grouping by date
// is deliberate and is preserved — see the Deductions tab.

import { formatMinutesOfDay } from '../istDate'
import type { DeductionExplanation } from './types'
import {
  SCHEDULED_IN_MINUTES,
  GRACE_END_MINUTES,
  MISSING_PUNCH_HOURS,
  PER_DAY_DIVISOR,
  PER_HOUR_DIVISOR,
} from './rules'

/**
 * The subset of a deduction line this module needs.
 *
 * `deduction_type` is a plain string, not the engine's DeductionType union: the
 * lines arrive over HTTP from /api/payroll/results/detail, where they are
 * whatever JSON said they were. An unrecognised type falls through to a
 * generic sentence rather than to a type error at the boundary.
 */
export type ExplainableLine = {
  deduction_type: string
  hours_deducted: number
  amount_deducted: number
  waived_by?: string
  explain?: DeductionExplanation
}

/** One "label → value" row inside the Calculation block. */
export type CalculationRow = {
  label: string
  value: string
  /** The line that IS the answer, as opposed to the workings above it. */
  strong?: boolean
}

export type ExplainedDeduction = {
  /** Stable within a date — a date never carries the same type twice. */
  key: string
  title: string
  /** Which payroll rule fired, in one line. */
  rule: string
  /** How the rule produced the amount. */
  calculation: CalculationRow[]
  /** What the employee actually pays. Zero when the company covered it. */
  amount: number
  /** True when the month's paid leave cancelled the charge. */
  companyPaid: boolean
  /** Present only when companyPaid — what the rule would have cost. */
  grossAmount?: number
}

// ─── Formatting ───────────────────────────────────────────────────────────────

export function money(n: number): string {
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** 1.5 → "1h 30m"; 2 → "2h"; 0.5 → "30m". */
export function duration(hours: number): string {
  const total = Math.round(hours * 60)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

/** 45 → "45 min"; 90 → "1h 30m". */
function minutes(mins: number): string {
  return mins < 60 ? `${mins} min` : duration(mins / 60)
}

/** IST minutes past midnight → "10:45 AM". */
export function clockLabel(minutesOfDay: number): string {
  const [hh, mm] = formatMinutesOfDay(minutesOfDay).split(':').map(Number)
  const suffix = hh >= 12 ? 'PM' : 'AM'
  const h12 = hh % 12 === 0 ? 12 : hh % 12
  return `${h12}:${String(mm).padStart(2, '0')} ${suffix}`
}

export const DEDUCTION_TITLES: Record<string, string> = {
  late_arrival:      'Late Arrival',
  early_checkout:    'Early Departure',
  missing_punch_in:  'Missing Punch-In',
  missing_punch_out: 'Missing Punch-Out',
  absent:            'Absent',
  half_day:          'Half Day',
  short_hours:       'Short Hours',
}

/** The row heading. A covered item is named for the rule that covered it. */
export function deductionTitle(line: ExplainableLine): string {
  if (line.waived_by === 'paid_leave') return 'Paid Leave · Company Paid'
  return DEDUCTION_TITLES[line.deduction_type] ?? line.deduction_type
}

// ─── The rule sentence ────────────────────────────────────────────────────────

function ruleSentence(line: ExplainableLine, e: DeductionExplanation | undefined): string {
  switch (line.deduction_type) {
    case 'late_arrival': {
      if (!e?.minutes_beyond || e.actual_minutes == null) {
        return `Arrived after the grace period. Charged ${duration(line.hours_deducted)}.`
      }
      const grace = (e.grace_end_minutes ?? GRACE_END_MINUTES) - (e.scheduled_minutes ?? SCHEDULED_IN_MINUTES)
      return `${minutes(e.minutes_beyond)} past ${clockLabel(e.scheduled_minutes ?? SCHEDULED_IN_MINUTES)}. `
        + `The first ${grace} minutes are free; the rest rounds up to ${duration(line.hours_deducted)}.`
    }
    case 'early_checkout': {
      if (!e?.minutes_beyond || e.actual_minutes == null) {
        return `Left before the end of the working day. Charged ${duration(line.hours_deducted)}.`
      }
      return `${minutes(e.minutes_beyond)} before ${clockLabel(e.scheduled_minutes!)}. `
        + `Rounded up to ${duration(line.hours_deducted)}.`
    }
    case 'missing_punch_in':
      return `The machine recorded a punch-out but no punch-in. A missing punch is a flat ${MISSING_PUNCH_HOURS} hours.`
    case 'missing_punch_out':
      return `The machine recorded a punch-in but no punch-out. A missing punch is a flat ${MISSING_PUNCH_HOURS} hours.`
    case 'absent':
      return 'No attendance was recorded for this working day, so it is deducted as a full day.'
    case 'half_day':
      return 'Hours worked fell in the half-day band, so half the day is deducted.'
    case 'short_hours':
      return `Hours short of a full working day. Charged ${duration(line.hours_deducted)}.`
    default:
      return `Charged ${duration(line.hours_deducted)}.`
  }
}

// ─── The calculation block ────────────────────────────────────────────────────

function rateLabel(e: DeductionExplanation): string {
  switch (e.rate_basis) {
    case 'per_hour': return `Hourly rate (monthly ÷ ${PER_DAY_DIVISOR} ÷ ${PER_HOUR_DIVISOR})`
    case 'per_day':  return `Daily rate (monthly ÷ ${PER_DAY_DIVISOR})`
    case 'half_day': return `Half of the daily rate`
  }
}

function unitsLabel(e: DeductionExplanation): string {
  return e.unit === 'hours' ? duration(e.units) : `${e.units} day${e.units === 1 ? '' : 's'}`
}

function calculationRows(line: ExplainableLine, e: DeductionExplanation | undefined): CalculationRow[] {
  // No metadata: an older engine result, or a line type that carries none. Say
  // what is known rather than inventing the workings.
  if (!e) {
    return [{ label: 'Deduction', value: money(line.amount_deducted), strong: true }]
  }

  const rows: CalculationRow[] = [
    { label: rateLabel(e), value: money(e.rate) },
    { label: `× ${unitsLabel(e)}`, value: money(e.gross_amount) },
  ]

  if (line.waived_by === 'paid_leave') {
    rows.push({ label: 'Company-paid allowance', value: `− ${money(e.gross_amount)}` })
  }

  rows.push({ label: 'Deduction', value: money(line.amount_deducted), strong: true })
  return rows
}

// ─── Entry points ─────────────────────────────────────────────────────────────

export function explainLine(line: ExplainableLine, index = 0): ExplainedDeduction {
  const e = line.explain
  const companyPaid = line.waived_by === 'paid_leave'

  const rule = companyPaid
    ? 'The first paid leave earned this month is covered by BOE. '
      + `${ruleSentence(line, e)} That cost is charged to the company, not to this salary.`
    : ruleSentence(line, e)

  return {
    key: `${line.deduction_type}-${index}`,
    title: deductionTitle(line),
    rule,
    calculation: calculationRows(line, e),
    amount: line.amount_deducted,
    companyPaid,
    grossAmount: companyPaid ? e?.gross_amount : undefined,
  }
}

export function explainDay(lines: ExplainableLine[]): ExplainedDeduction[] {
  return lines.map(explainLine)
}

/**
 * What the date cost in total.
 *
 * Summed from the same lines the popup lists, so the figure at the bottom of
 * the popup and the figure on the row it opened from cannot disagree. Covered
 * lines contribute 0 by virtue of their amount, not by being skipped.
 */
export function dayDeductionTotal(lines: ExplainableLine[]): number {
  return lines.reduce((sum, l) => sum + l.amount_deducted, 0)
}

/** The one-line note under a company-paid row. */
export const COMPANY_PAID_NOTE = '1st paid leave covered by company'
