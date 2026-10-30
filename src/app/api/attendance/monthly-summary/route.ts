import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { monthRange, workingDatesInMonth } from '@/lib/attendance/monthCalendar'
import { attendanceCoverageThrough, isMachineMonth, machineLatestDate, withinCoverage } from '@/lib/attendance/monthAvailability'
import {
  SCORE_RECORD_COLUMNS, buildScoreIndex, fullDayHolidayDates, readScoreContext, scoreDay,
  type ScoreContext, type ScoreRecord,
} from '@/lib/attendance/attendanceScoreboard'
import { emptyTally } from '@/lib/attendance/attendanceScore'
import { onlyParticipating } from '@/lib/payroll/participation'
import { PagedReadError, fetchAllRows, unwrapPagedRows } from '@/lib/supabasePaging'

function hoursWorked(checkIn: string | null, checkOut: string | null): number {
  if (!checkIn || !checkOut) return 0
  const diff = new Date(checkOut).getTime() - new Date(checkIn).getTime()
  return diff > 0 ? Math.round((diff / 36e5) * 100) / 100 : 0
}

// Whole-company attendance summary: every active employee's present, absent,
// late, half-day and missing-punch counts for a month, by name. There is no
// per-employee form of this route and no way to scope it to one person, so it
// is admin-only. It previously required nothing beyond a valid session.
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth
  const svc = auth.svc

  const { searchParams } = new URL(req.url)
  const yearParam  = searchParams.get('year')
  const monthParam = searchParams.get('month')

  if (!yearParam || !monthParam) {
    return NextResponse.json({ error: 'year and month are required' }, { status: 400 })
  }

  const year  = parseInt(yearParam,  10)
  const month = parseInt(monthParam, 10)
  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: 'Invalid year or month' }, { status: 400 })
  }

  const { from, to } = monthRange(year, month)

  // Every employee attendance tracks — active AND taking part in Attendance &
  // Payroll. The second half is what stops an excluded member (a dummy account,
  // a family member, anyone deliberately untracked) from accruing an absence for
  // every working day of the month and inflating the warning counts on this
  // screen. See src/lib/payroll/participation.ts.
  const { data: employees, error: empErr } = await onlyParticipating(
    svc.from('users')
      .select('id, full_name, employee_code, joining_date, exit_date')
      .eq('is_active', true),
  ).order('full_name')

  if (empErr) return NextResponse.json({ error: empErr.message }, { status: 500 })

  // ── PAGED, BECAUSE POSTGREST TRUNCATES SILENTLY ──
  //
  // A month of attendance is (employees x days) rows: fifty people over thirty-one
  // days is over 1,500, and PostgREST caps a response at 1000 with no error and
  // no warning (src/lib/supabasePaging.ts). A plain select here returns a
  // plausible-looking array that is missing a third of the month, and every
  // figure derived from it is quietly wrong.
  //
  // unwrapPagedRows REFUSES a failed or capped read rather than computing from
  // part of one. For attendance that is the only acceptable behaviour: a summary
  // built from two thirds of a month is worse than no summary, because it looks
  // like an answer.
  let records: ScoreRecord[]
  // Corrections, approved requests, holidays and the rules in force. Each day below
  // is read by the payroll engine, not from the stored status, which can only ever
  // say present or checked_in: see src/lib/attendance/attendanceScoreboard.ts.
  let context: ScoreContext
  try {
    records = unwrapPagedRows('attendance records', await fetchAllRows<ScoreRecord>(
      (pageFrom, pageTo) => svc
        .from('attendance_records')
        .select(SCORE_RECORD_COLUMNS)
        .gte('attendance_date', from)
        .lte('attendance_date', to)
        // A unique tiebreak: range() maps to LIMIT/OFFSET, which promises
        // nothing about row order unless the ordering is deterministic.
        .order('id', { ascending: true })
        .range(pageFrom, pageTo)))
    context = await readScoreContext(svc, from, to)
  } catch (err) {
    const detail = err instanceof PagedReadError ? err.detail : String(err)
    return NextResponse.json({ error: detail }, { status: 500 })
  }

  // The month's working days come from the CALENDAR, not from the records.
  //
  // This used to be "every date some employee was scanned on", which meant a
  // working day nobody punched simply did not exist: it was never counted as an
  // absence, and it silently shrank `total_records` — the denominator behind
  // every attendance figure on this screen. A month with no import yet reported
  // zero days rather than a month nobody has been marked present for. Same
  // calendar the payroll engine builds, so the two screens agree about what the
  // month was made of.
  //
  // Cut at the coverage date for the same reason /employee-monthly-detail does:
  // a working day nobody has uploaded yet is not an absence. Without this an
  // admin opening the current month on the 8th would read every remaining day of
  // it as absent for every employee — and would then be looking at a different
  // month from the one the employee sees on /my-attendance. The latest date is
  // taken from the rows already fetched above, so this costs no extra query.
  const latestInMonth = (records ?? []).reduce<string | null>(
    (max, r) => (!max || r.attendance_date > max ? r.attendance_date : max),
    null,
  )
  const latestImported = isMachineMonth(year, month) ? machineLatestDate(latestInMonth) : latestInMonth
  const coverageThrough = attendanceCoverageThrough(year, month, latestImported)

  const index = buildScoreIndex(records, context)
  const holidays = fullDayHolidayDates(context.holidays)

  // Build per-employee summary
  type EmployeeSummary = {
    employee_id:   string
    employee_name: string
    employee_code: string | null
    present:       number
    half_day:      number
    absent:        number
    leave:         number
    late:          number
    missing_punch: number
    total_records: number
    hours_worked:  number
  }

  const summaries: EmployeeSummary[] = (employees ?? []).map(emp => {
    const workingDates = withinCoverage(
      workingDatesInMonth(year, month, {
        holidays,
        joiningDate: emp.joining_date ?? null,
        exitDate:    emp.exit_date ?? null,
      }),
      coverageThrough,
    )

    const tally = emptyTally()
    let hours = 0

    for (const date of workingDates) {
      const day = scoreDay(index, emp.id, date)
      tally[day.kind]++
      hours += hoursWorked(day.checkInAt, day.checkOutAt)
    }

    return {
      employee_id:   emp.id,
      employee_name: emp.full_name,
      employee_code: emp.employee_code,
      // A late, left-early or one-punch day is still a day present.
      present:       tally.ok + tally.late + tally.early + tally.miss,
      half_day:      tally.half,
      absent:        tally.absent,
      leave:         tally.leave,
      late:          tally.late,
      missing_punch: tally.miss,
      // Approved leave is left out, so it does not lower the attendance figure.
      total_records: workingDates.length - tally.leave,
      hours_worked:  Math.round(hours * 100) / 100,
    }
  })

  return NextResponse.json({
    year,
    month,
    month_imported: latestImported !== null,
    coverage_through: coverageThrough,
    summaries,
  })
}
