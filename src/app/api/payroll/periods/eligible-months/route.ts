// GET /api/payroll/periods/eligible-months
//
// Which months a NEW payroll period may actually be created for, and why the
// current month is missing when it is. Backs the Create Payroll picker so it
// never offers a month the POST /api/payroll/periods create endpoint would
// refuse — the same three rules apply here, read-only: not a future month,
// attendance already uploaded, no payroll period for it yet.
//
// Deliberately its OWN route rather than a field bolted onto GET
// /api/payroll/periods: that route already does a full paged scan of
// payroll_results and attendance_records to compute per-period headcounts and
// staleness — real work a month picker does not need. This route only reads
// the bare (id, month, year) of existing periods plus a handful of cheap
// per-month attendance existence counts.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { istCurrentYearMonth, isFutureMonth, type YearMonth } from '@/lib/attendance/monthAvailability'
import { monthsWithAttendance } from '@/lib/attendance/attendanceExists'
import { periodLabel } from '@/lib/payroll/months'

/**
 * How far back the picker looks for a month that could still need a new
 * period. Bounded on purpose: an admin creating a payroll period for a month
 * more than a year behind is not the normal flow this picker serves, and a
 * wider window means more per-month existence queries for no realistic gain.
 */
const MONTHS_BACK = 11

function candidateMonths(current: YearMonth): YearMonth[] {
  const out: YearMonth[] = []
  let { year, month } = current
  for (let i = 0; i <= MONTHS_BACK; i++) {
    out.push({ year, month })
    month -= 1
    if (month < 1) { month = 12; year -= 1 }
  }
  return out
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth
  const svc = auth.svc

  const current = istCurrentYearMonth()
  const candidates = candidateMonths(current)

  const { data: existingPeriods, error: periodsErr } = await svc
    .from('payroll_periods')
    .select('payroll_month, payroll_year')
  if (periodsErr) return NextResponse.json({ error: periodsErr.message }, { status: 500 })

  const hasPeriod = new Set(
    (existingPeriods ?? []).map((p: { payroll_month: number; payroll_year: number }) =>
      `${p.payroll_year}-${String(p.payroll_month).padStart(2, '0')}`),
  )
  const key = (ym: YearMonth) => `${ym.year}-${String(ym.month).padStart(2, '0')}`

  // Only months with neither a future date nor an existing period need an
  // attendance check at all — no point paying for a query whose answer
  // cannot change the outcome.
  const needsAttendanceCheck = candidates.filter(
    ym => !isFutureMonth(ym.year, ym.month) && !hasPeriod.has(key(ym)),
  )

  let withAttendance: Set<string>
  try {
    withAttendance = await monthsWithAttendance(svc, needsAttendanceCheck)
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  const eligible = needsAttendanceCheck
    .filter(ym => withAttendance.has(key(ym)))
    .map(ym => ({ year: ym.year, month: ym.month, label: periodLabel(ym.month, ym.year) }))
    // Newest first — the month an admin is most likely to want is the one
    // right before the one they already have.
    .sort((a, b) => (b.year - a.year) || (b.month - a.month))

  // The current month specifically, named as a reason when it is the one
  // held back — "the picker just doesn't show it" is not an explanation.
  const currentIsEligible = eligible.some(m => m.year === current.year && m.month === current.month)
  const currentHasPeriod  = hasPeriod.has(key(current))
  const currentMonthUnavailable = !currentIsEligible && !currentHasPeriod
    ? { year: current.year, month: current.month, label: periodLabel(current.month, current.year) }
    : null

  return NextResponse.json({ eligible, current_month_unavailable: currentMonthUnavailable })
}
