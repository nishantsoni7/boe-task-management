// Whether attendance has been uploaded for a month at all — a plain existence
// check, kept separate from src/lib/attendance/monthAvailability.ts on purpose.
//
// monthAvailability.ts stays pure (no Supabase import) because its rules are
// tested without a database. This file is the one place that actually asks
// the table "is there anything here", for a caller that needs a yes/no over
// I/O — today, the payroll-period creation rule: a period must not be
// creatable for a month nobody has uploaded attendance for yet.
//
// Deliberately NOT built from attendanceCoverageThrough(): that function folds
// in "cap at today" logic for the current month, which answers a different
// question ("how far may this month be CLASSIFIED") than the one this file
// answers ("does this month have ANY row at all").

import { monthRange } from './monthCalendar'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any

/**
 * True when `attendance_records` holds at least one row anywhere in the
 * month — company-wide, same as every other "has this month been imported"
 * check in the codebase (see monthAvailability.ts's header for why that must
 * stay company-wide rather than per-employee).
 */
export async function attendanceExistsForMonth(
  svc: Svc,
  year: number,
  month: number,
): Promise<boolean> {
  const { from, to } = monthRange(year, month)
  const { count, error } = await svc
    .from('attendance_records')
    .select('id', { count: 'exact', head: true })
    .gte('attendance_date', from)
    .lte('attendance_date', to)

  if (error) throw new Error(`attendanceExistsForMonth: ${error.message}`)
  return (count ?? 0) > 0
}

/**
 * The same check for several months at once, one lightweight COUNT per month
 * run in parallel — the pattern already used by collectDeletionFacts in
 * src/app/api/payroll/delete/route.ts for period-level settlement counts.
 * Returns a Set of `"YYYY-MM"` keys for the months that have at least one row.
 */
export async function monthsWithAttendance(
  svc: Svc,
  months: readonly { year: number; month: number }[],
): Promise<Set<string>> {
  const key = (ym: { year: number; month: number }) => `${ym.year}-${String(ym.month).padStart(2, '0')}`
  const results = await Promise.all(
    months.map(async ym => ({ ym, exists: await attendanceExistsForMonth(svc, ym.year, ym.month) })),
  )
  return new Set(results.filter(r => r.exists).map(r => key(r.ym)))
}
