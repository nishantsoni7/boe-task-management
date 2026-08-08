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

/** IST is UTC+05:30, and the whole product reasons about attendance in IST. */
const IST_OFFSET_MINUTES = 5 * 60 + 30

export type YearMonth = { year: number; month: number }

/** The year and month it is *right now* in IST. */
export function istCurrentYearMonth(now: Date = new Date()): YearMonth {
  const ist = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000)
  return { year: ist.getUTCFullYear(), month: ist.getUTCMonth() + 1 }
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
