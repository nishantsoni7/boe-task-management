/**
 * Month-based quick ranges for list date filters ("Last month", "Last 3 months"…).
 *
 * Months are whole IST calendar months, the unit payroll and Finance close on.
 * "This month" runs to today; every other preset ends on the last day of LAST
 * month, so "Last 3 months" never includes a month still in progress.
 *
 * Pure and client-safe: the caller owns the `from` / `to` fields and calls
 * `resolveMonthRange` when a preset is picked. Nothing is stored, so a hand-typed
 * range that happens to equal a preset simply reads as that preset
 * (`matchMonthRange`).
 */

import { istToday, istMonthStart, istMonthEnd, istMonthStartOffset } from './istDate'

export type MonthRangeKey =
  | 'this_month' | 'last_month' | 'last_to_last_month' | 'last_3_months' | 'last_6_months'

export const MONTH_RANGE_PRESETS: readonly { key: MonthRangeKey; label: string }[] = [
  { key: 'this_month',         label: 'This month' },
  { key: 'last_month',         label: 'Last month' },
  { key: 'last_to_last_month', label: 'Last to last month' },
  { key: 'last_3_months',      label: 'Last 3 months' },
  { key: 'last_6_months',      label: 'Last 6 months' },
]

/** The inclusive YYYY-MM-DD range a preset stands for, as of `today` (IST). */
export function resolveMonthRange(key: MonthRangeKey, today: string = istToday()): { from: string; to: string } {
  const lastMonthStart = istMonthStartOffset(today, 1)
  const lastMonthEnd   = istMonthEnd(lastMonthStart)
  switch (key) {
    case 'this_month':         return { from: istMonthStart(today), to: today }
    case 'last_month':         return { from: lastMonthStart, to: lastMonthEnd }
    case 'last_to_last_month': {
      const start = istMonthStartOffset(today, 2)
      return { from: start, to: istMonthEnd(start) }
    }
    case 'last_3_months':      return { from: istMonthStartOffset(today, 3), to: lastMonthEnd }
    case 'last_6_months':      return { from: istMonthStartOffset(today, 6), to: lastMonthEnd }
  }
}

/** The preset whose range is exactly `from`–`to`, or null (blank, one-sided or hand-picked dates). */
export function matchMonthRange(from: string, to: string, today: string = istToday()): MonthRangeKey | null {
  if (!from || !to) return null
  for (const { key } of MONTH_RANGE_PRESETS) {
    const r = resolveMonthRange(key, today)
    if (r.from === from && r.to === to) return key
  }
  return null
}
