// Month names for payroll period labels.
//
// A payroll period is stored as (payroll_month, payroll_year) and displayed as
// "August 2026" everywhere it appears. Shared so the dashboard, its dialogs and
// the confirmation copy inside them cannot disagree about the spelling.

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

/** "August 2026" for a 1-based month. */
export function periodLabel(month: number, year: number): string {
  return `${MONTHS[month - 1] ?? month} ${year}`
}
