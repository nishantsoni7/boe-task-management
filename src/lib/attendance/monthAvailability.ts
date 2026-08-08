// Which attendance months exist to look at, and whether a month has actually
// been imported yet.
//
// THE DISTINCTION THIS FILE EXISTS FOR
// ------------------------------------
// buildWorkingDayCalendar() derives a month's working days from the calendar
// rather than from the records, which is what stopped days going missing (the
// 21 July case). But a calendar knows nothing about whether anyone has uploaded
// the machine export yet, so for a month with no import it will happily produce
// a full set of working days and every one of them reads as an absence.
//
// That is a false statement about a person's attendance, and it is worse than
// showing nothing: an employee opening the current month on the 3rd would see
// themselves marked absent for days that have not been processed, and for days
// that have not happened.
//
// So there are two different "no data" answers and they must not be conflated:
//
//   MONTH NOT IMPORTED  → we have nothing to say. Say that.
//   MONTH IMPORTED      → the calendar decides the working days, and a working
//                         day with no punch is a real absence.
//
// The import marker is deliberately COMPANY-WIDE. "This employee has no rows"
// cannot mean "not imported" — an employee who was absent all month genuinely
// has no rows, and treating that as missing data would hide real absences.
//
// THREE STATES, NOT TWO
// ---------------------
// "Imported" is not a property of a month; it is a property of a DATE. Treating
// it as a month-level flag is what let the first version of this file still
// invent absences: one punch anywhere in August marked the whole of August
// imported, and the calendar then produced working days for the 6th through the
// 31st — days nobody had uploaded, and days that had not happened.
//
// So the questions are separate and answered separately:
//
//   MONTH HAS STARTED    isFutureMonth() — a future month is refused outright.
//   MONTH WAS IMPORTED   is there any company row in it at all.
//   DATE WAS PROCESSED   is it within attendanceCoverageThrough() below.
//
// Only the third one licenses the sentence "this employee was absent".

import { monthRange } from './monthCalendar'

/** IST is UTC+05:30, and the whole product reasons about attendance in IST. */
const IST_OFFSET_MINUTES = 5 * 60 + 30

export type YearMonth = { year: number; month: number }

/** The year and month it is *right now* in IST. */
export function istCurrentYearMonth(now: Date = new Date()): YearMonth {
  const ist = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000)
  return { year: ist.getUTCFullYear(), month: ist.getUTCMonth() + 1 }
}

/** Today's date in IST as YYYY-MM-DD — the same vocabulary attendance_date uses. */
export function istToday(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000)
  return ist.toISOString().slice(0, 10)
}

/**
 * Is this month later than the current IST month?
 *
 * A future month can hold no attendance by definition, so asking for one is
 * always a mistake — either a stale bookmark or a hand-edited URL — and is
 * answered rather than guessed at.
 */
export function isFutureMonth(year: number, month: number, now: Date = new Date()): boolean {
  const current = istCurrentYearMonth(now)
  return year > current.year || (year === current.year && month > current.month)
}

/**
 * The last date of a month attendance may be CLASSIFIED for, or null when none
 * of it may be.
 *
 * `latestImportedDate` is the newest attendance_date the company has anywhere in
 * that month — i.e. how far the machine export has actually got. It is read
 * company-wide for the same reason the import marker is: one employee's absence
 * is not evidence that a date is unprocessed.
 *
 *   nothing imported   → null. Say "not uploaded"; assert nothing.
 *   future month       → null. It cannot hold attendance.
 *   historical month   → the whole month. A finished month's export covers it,
 *                        and a working day with no punch in it is a real
 *                        absence — this is the 21 July case, and it must keep
 *                        working.
 *   current month      → the EARLIER of the latest imported date and today.
 *
 * The current-month rule is the point of this function. On 8 August with the
 * import run through the 5th, the 6th and 7th are working days that simply have
 * not been processed, and the 9th onwards have not happened. Neither is an
 * absence, and the calendar cannot tell the difference on its own. Capping at
 * today as well as at the import is belt-and-braces: a machine file containing a
 * stray future date must still never produce a future absence.
 */
export function attendanceCoverageThrough(
  year: number,
  month: number,
  latestImportedDate: string | null,
  now: Date = new Date(),
): string | null {
  if (!latestImportedDate) return null
  if (isFutureMonth(year, month, now)) return null

  const current = istCurrentYearMonth(now)
  if (year !== current.year || month !== current.month) return monthRange(year, month).to

  const today = istToday(now)
  return latestImportedDate < today ? latestImportedDate : today
}

/**
 * The dates of a month that may be classified, given that cut-off.
 *
 * A date past the cut-off is DROPPED rather than returned with some "unknown"
 * status: a row on the screen is a statement about that day, and there is no
 * true statement to make about a day nobody has processed. ISO dates compare
 * lexicographically, which is what makes this a string comparison.
 */
export function withinCoverage(dates: readonly string[], coverageThrough: string | null): string[] {
  if (!coverageThrough) return []
  return dates.filter(d => d <= coverageThrough)
}

/**
 * The months an employee may choose, newest first.
 *
 * Bounded at both ends: never past the current IST month, and never further
 * back than `yearsBack` years, so the picker cannot offer a year the company
 * did not exist for.
 */
export function selectableMonths(now: Date = new Date(), yearsBack = 2): YearMonth[] {
  const current = istCurrentYearMonth(now)
  const out: YearMonth[] = []
  for (let y = current.year; y >= current.year - yearsBack; y--) {
    const startMonth = y === current.year ? current.month : 12
    for (let m = startMonth; m >= 1; m--) out.push({ year: y, month: m })
  }
  return out
}

/** The months of one year that are selectable, given the current IST month. */
export function selectableMonthsInYear(year: number, now: Date = new Date()): number[] {
  const current = istCurrentYearMonth(now)
  if (year > current.year) return []
  const last = year === current.year ? current.month : 12
  return Array.from({ length: last }, (_, i) => i + 1)
}

/** The years the picker offers, newest first. */
export function selectableYears(now: Date = new Date(), yearsBack = 2): number[] {
  const current = istCurrentYearMonth(now)
  return Array.from({ length: yearsBack + 1 }, (_, i) => current.year - i)
}

export const MONTH_NOT_IMPORTED_TITLE = 'Attendance data not uploaded yet'

/** The empty state, in the employee's terms. Names the month so it is specific. */
export function monthNotImportedMessage(monthLabel: string): string {
  return `Attendance for ${monthLabel} has not been uploaded by Admin.`
}

/**
 * The partly-uploaded notice for the current month.
 *
 * Said explicitly because the alternative is a table that just stops, which
 * reads as "the rest of the month is missing from my record" — the same anxiety
 * a row of false absences causes, for the opposite reason.
 */
export function coverageNoticeMessage(dateLabel: string): string {
  return `Attendance has been uploaded up to ${dateLabel}. Later days of this month have not ` +
    `been processed yet, so they are not shown — and none of them count as an absence.`
}
