import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import {
  SCORE_RECORD_COLUMNS, buildOverview, chooseDefaultMonth, readScoreContext, shiftMonth,
  type ScoreContext, type ScoreEmployee, type ScoreRecord,
} from '@/lib/attendance/attendanceScoreboard'
import { monthRange } from '@/lib/attendance/monthCalendar'
import { isFutureMonth, istCurrentYearMonth } from '@/lib/attendance/monthAvailability'
import { onlyParticipating, participatesInPayroll } from '@/lib/payroll/participation'
import { PagedReadError, fetchAllRows, unwrapPagedRows } from '@/lib/supabasePaging'

// The attendance score of every employee for a month, ranked, by name. It compares
// people with each other, so it is admin-only, and it changes nothing. The rules
// are in src/lib/attendance/attendanceScore.ts.
//
// `year` and `month` are optional together. Without them the answer is the newest
// month with enough complete days to rank, which on the 1st of a month is not the
// month it has just become.
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth
  const svc = auth.svc

  const params = new URL(req.url).searchParams
  const yearParam = params.get('year')
  const monthParam = params.get('month')

  if ((yearParam === null) !== (monthParam === null)) {
    return NextResponse.json({ error: 'year and month go together' }, { status: 400 })
  }

  let asked: { year: number; month: number } | null = null
  if (yearParam !== null && monthParam !== null) {
    const year = Number(yearParam)
    const month = Number(monthParam)
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      return NextResponse.json({ error: 'Invalid year or month' }, { status: 400 })
    }
    if (isFutureMonth(year, month)) {
      return NextResponse.json({ error: 'That month has not started yet' }, { status: 400 })
    }
    asked = { year, month }
  }

  const { data: users, error: usersErr } = await onlyParticipating(
    svc.from('users')
      .select('id, full_name, employee_code, joining_date, exit_date, minop_user_id, is_deleted')
      .eq('is_active', true),
  ).order('full_name')

  if (usersErr) return NextResponse.json({ error: usersErr.message }, { status: 500 })

  const current = istCurrentYearMonth()
  const latest = asked ?? current
  // Seven months, so the month it opens on can fall back one and still have its
  // five months of trend behind it.
  const from = monthRange(shiftMonth(latest, -6).year, shiftMonth(latest, -6).month).from
  const to = monthRange(latest.year, latest.month).to

  // Paged, and refused rather than used in part: see src/lib/supabasePaging.ts. A
  // ranking built from two thirds of a month would name the wrong people.
  let records: ScoreRecord[]
  let context: ScoreContext
  try {
    records = unwrapPagedRows('attendance records', await fetchAllRows<ScoreRecord>(
      (pageFrom, pageTo) => svc
        .from('attendance_records')
        .select(SCORE_RECORD_COLUMNS)
        .gte('attendance_date', from)
        .lte('attendance_date', to)
        .order('id', { ascending: true })
        .range(pageFrom, pageTo)))
    context = await readScoreContext(svc, from, to)
  } catch (err) {
    const detail = err instanceof PagedReadError ? err.detail : String(err)
    return NextResponse.json({ error: detail }, { status: 500 })
  }

  // Another admin decides an admin's own request, so their own is not theirs to do.
  const { count: pendingRequests, error: pendingErr } = await svc
    .from('attendance_requests')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')
    .neq('employee_id', auth.id)

  if (pendingErr) return NextResponse.json({ error: pendingErr.message }, { status: 500 })

  const chosen = asked ?? chooseDefaultMonth(records, context.holidays)
  const moved = !asked && (chosen.year !== current.year || chosen.month !== current.month)

  return NextResponse.json(buildOverview({
    employees: ((users ?? []) as Array<ScoreEmployee & { is_deleted: boolean | null }>).filter(participatesInPayroll),
    records,
    context,
    year: chosen.year,
    month: chosen.month,
    pendingRequests: pendingRequests ?? 0,
    fellBackFrom: moved ? current : null,
  }))
}
