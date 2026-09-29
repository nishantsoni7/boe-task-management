// Has this payroll month ended? — the one rule every payroll WRITE checks.
//
// The engine has no notion of "today": every non-Sunday, non-holiday date in
// the month is a working day, and a working day with no punch is an ABSENCE.
// Run on 27 September, a September payroll therefore charged 28, 29 and 30
// September as full-day absences — days that had not happened yet — and
// nothing stopped that draft from being locked. (Reproduced in
// src/lib/payroll/periodCompletion.test.ts and in the local click-through.)
//
// The rule: a payroll month can be generated, recalculated through an
// attendance correction, or locked only once it has ENDED in India time — from
// 00:00 IST on the first day of the next month. Before that, Payroll Monthly
// Preview shows the month so far (it trims days that have not occurred).
//
// BOE has no final-settlement or early-close path in payroll today
// (users.exit_date is not read by the engine), so there is deliberately no
// bypass here. A month that has already ended is unaffected: every completed
// and historical period behaves exactly as before.

import { istToday } from '@/lib/istDate'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** Last calendar date of the month, YYYY-MM-DD. */
export function payrollMonthLastDay(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`
}

/** First date payroll for the month may be generated or locked, YYYY-MM-DD. */
export function payrollMonthOpensOn(year: number, month: number): string {
  const y = month === 12 ? year + 1 : year
  const m = month === 12 ? 1 : month + 1
  return `${y}-${String(m).padStart(2, '0')}-01`
}

/** True once the month has ended in IST (`today` is an IST date). */
export function isPayrollMonthComplete(year: number, month: number, today: string = istToday()): boolean {
  return today > payrollMonthLastDay(year, month)
}

export const MONTH_IN_PROGRESS_CODE = 'payroll_month_in_progress'

export function monthInProgressMessage(year: number, month: number, action: 'generated' | 'locked' | 'corrected'): string {
  const opens = payrollMonthOpensOn(year, month)
  const [, om, od] = opens.split('-').map(Number)
  return `${MONTHS[month - 1]} ${year} has not ended yet, so its payroll cannot be ${action}: ` +
    `days that have not happened would be charged as absences. It can be ${action} from ${od} ${MONTHS[om - 1].slice(0, 3)} (IST). ` +
    'Use Payroll Monthly Preview to see the month so far.'
}

/**
 * For a read-only view of an in-progress month: the last date that has fully
 * happened (yesterday, IST). Undefined for a month that has ended — the engine
 * then uses the whole month, exactly as before.
 */
export function calendarThroughFor(year: number, month: number, today: string = istToday()): string | undefined {
  if (isPayrollMonthComplete(year, month, today)) return undefined
  const d = new Date(`${today}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}
