import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { monthRange, workingDatesInMonth } from '@/lib/attendance/monthCalendar'
import { attendanceCoverageThrough, withinCoverage } from '@/lib/attendance/monthAvailability'
import { onlyParticipating } from '@/lib/payroll/participation'
import { PagedReadError, fetchAllRows, unwrapPagedRows } from '@/lib/supabasePaging'

/** One attendance row, as the monthly summary reads it. */
type AttendanceRow = {
  user_id: string
  attendance_date: string
  check_in_at: string | null
  check_out_at: string | null
  status: string | null
}


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
      .select('id, full_name, employee_code')
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
  let records: AttendanceRow[]
  try {
    records = unwrapPagedRows('attendance records', await fetchAllRows<AttendanceRow>(
      (pageFrom, pageTo) => svc
        .from('attendance_records')
        .select('user_id, attendance_date, check_in_at, check_out_at, status')
        .gte('attendance_date', from)
        .lte('attendance_date', to)
        // A unique tiebreak: range() maps to LIMIT/OFFSET, which promises
        // nothing about row order unless the ordering is deterministic.
        .order('id', { ascending: true })
        .range(pageFrom, pageTo)))
  } catch (err) {
    const detail = err instanceof PagedReadError ? err.detail : String(err)
    return NextResponse.json({ error: detail }, { status: 500 })
  }

  // Fetch public holidays for the month. Only a FULL-DAY holiday excludes
  // the date from this screen's calendar — a half-day holiday still owes a
  // normal working half, and this raw-status screen has no way to evaluate
  // just that half (see src/lib/payroll/halfDayHoliday.ts, which the real
  // payroll engine uses instead), so the date is left as an ordinary working
  // day here rather than wrongly dropped.
  const { data: holidays, error: holErr } = await svc
    .from('payroll_holidays')
    .select('holiday_date')
    .eq('holiday_type', 'full_day')
    .gte('holiday_date', from)
    .lte('holiday_date', to)

  if (holErr) return NextResponse.json({ error: holErr.message }, { status: 500 })

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
  const latestImported = (records ?? []).reduce<string | null>(
    (max, r) => (!max || r.attendance_date > max ? r.attendance_date : max),
    null,
  )
  const coverageThrough = attendanceCoverageThrough(year, month, latestImported)

  const workingDates = withinCoverage(
    workingDatesInMonth(year, month, {
      holidays: (holidays ?? []).map(h => h.holiday_date),
    }),
    coverageThrough,
  )

  // Index each employee's records by date for O(1) lookup
  const byEmployeeByDate = new Map<string, Map<string, typeof records[number]>>()
  for (const rec of records ?? []) {
    if (!byEmployeeByDate.has(rec.user_id)) byEmployeeByDate.set(rec.user_id, new Map())
    byEmployeeByDate.get(rec.user_id)!.set(rec.attendance_date, rec)
  }

  // Build per-employee summary
  type EmployeeSummary = {
    employee_id:   string
    employee_name: string
    employee_code: string | null
    present:       number
    half_day:      number
    absent:        number
    late:          number
    missing_punch: number
    total_records: number
    hours_worked:  number
  }

  const summaries: EmployeeSummary[] = (employees ?? []).map(emp => {
    const recByDate = byEmployeeByDate.get(emp.id) ?? new Map()

    let present = 0, half_day = 0, late = 0, missing_punch = 0, absent = 0, hours = 0

    for (const date of workingDates) {
      const r = recByDate.get(date)

      // No record for this working day = absent
      if (!r) {
        absent++
        continue
      }

      hours += hoursWorked(r.check_in_at, r.check_out_at)
      const hasPunchIn  = !!r.check_in_at
      const hasPunchOut = !!r.check_out_at

      // One punch only = missing punch: counts as present AND flagged separately
      if (hasPunchIn !== hasPunchOut || r.status === 'missing_punch') {
        missing_punch++
        present++
        continue
      }

      const status = r.status ?? ''
      if (status === 'half_day') {
        half_day++
      } else if (status === 'late') {
        late++
        present++ // late but present
      } else if (status === 'present' || status === 'checked_in') {
        present++
      } else if (status === 'absent') {
        absent++
      } else if (hasPunchIn && hasPunchOut) {
        // both punches, unknown status → treat as present
        present++
      }
    }

    return {
      employee_id:   emp.id,
      employee_name: emp.full_name,
      employee_code: emp.employee_code,
      present,
      half_day,
      absent,
      late,
      missing_punch,
      total_records: workingDates.length, // denominator = total working days this month
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
