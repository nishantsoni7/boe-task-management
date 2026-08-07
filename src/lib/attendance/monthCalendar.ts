// The working days of a month — generated from the calendar, not from the data.
//
// The bug this replaces
// ---------------------
// /api/attendance/monthly-summary and /api/attendance/employee-monthly-detail
// both built their month like this:
//
//   for (const rec of records) if (!isSunday(...)) workingDates.add(rec.attendance_date)
//
// i.e. "a working day is a day somebody was scanned on". Three consequences,
// all silent:
//
//   * A working day nobody punched on — the office shut, the machine file had a
//     gap, everyone was out — did not exist. It was not shown as absent; it was
//     not shown at all.
//   * `total_records`, the denominator behind every attendance percentage, was
//     that same count, so the month quietly got shorter and the percentages
//     quietly got better.
//   * A month with no import yet renders as zero days rather than as a month
//     nobody has been marked present for.
//
// The payroll engine has always done this correctly — buildWorkingDayCalendar()
// in src/lib/payroll/engine.ts walks the calendar and removes Sundays, company
// holidays and pre-joining dates. This module states the same calendar for the
// attendance screens, so the two cannot disagree about what a month was made of.
//
// Dates are plain YYYY-MM-DD strings throughout. No Date arithmetic crosses a
// timezone here: the day-of-week check builds the date in UTC, and for a
// date-only value the weekday is the same in IST and UTC.

import { WEEKLY_OFF_DAY } from './scheduleRules'

export type MonthCalendarOptions = {
  /** Company holidays, YYYY-MM-DD. Excluded like Sundays: paid, not worked. */
  holidays?: readonly string[]
  /** Dates before this are not the employee's to be absent on. */
  joiningDate?: string | null
  /** Dates on or after this are past the employee's last day. */
  exitDate?: string | null
}

/** Every calendar date in the month, in order. */
export function monthDates(year: number, month: number): string[] {
  // Date.UTC(y, m, 0) is the last day of month `m` when `m` is 1-based.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const mm = String(month).padStart(2, '0')
  const out: string[] = []
  for (let d = 1; d <= daysInMonth; d++) out.push(`${year}-${mm}-${String(d).padStart(2, '0')}`)
  return out
}

/** The inclusive first and last date of the month, as YYYY-MM-DD. */
export function monthRange(year: number, month: number): { from: string; to: string } {
  const dates = monthDates(year, month)
  return { from: dates[0], to: dates[dates.length - 1] }
}

/** True for the weekly off. Built in UTC — a date-only value has one weekday. */
export function isWeeklyOff(date: string): boolean {
  return new Date(`${date}T00:00:00Z`).getUTCDay() === WEEKLY_OFF_DAY
}

/**
 * The dates in the month an employee was expected to be at work.
 *
 * ISO dates sort and compare lexicographically, which is what makes the
 * joining/exit bounds a plain string comparison.
 */
export function workingDatesInMonth(
  year: number,
  month: number,
  { holidays = [], joiningDate = null, exitDate = null }: MonthCalendarOptions = {},
): string[] {
  const holidaySet = new Set(holidays)
  return monthDates(year, month).filter(date => {
    if (isWeeklyOff(date)) return false
    if (holidaySet.has(date)) return false
    if (joiningDate && date < joiningDate) return false
    if (exitDate && date >= exitDate) return false
    return true
  })
}

export type NonWorkingReason = 'weekly_off' | 'holiday' | 'pre_joining' | 'post_exit'

/**
 * Why a date is not a working day, or null when it is one.
 *
 * Same precedence the payroll engine applies, so a Sunday that is also a
 * holiday reads as a Sunday in both places.
 */
export function nonWorkingReason(
  date: string,
  { holidays = [], joiningDate = null, exitDate = null }: MonthCalendarOptions = {},
): NonWorkingReason | null {
  if (isWeeklyOff(date)) return 'weekly_off'
  if (holidays.includes(date)) return 'holiday'
  if (joiningDate && date < joiningDate) return 'pre_joining'
  if (exitDate && date >= exitDate) return 'post_exit'
  return null
}
