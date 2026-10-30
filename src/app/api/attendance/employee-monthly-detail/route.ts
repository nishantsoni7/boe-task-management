import { NextRequest, NextResponse } from 'next/server'
import { requireSelfOrAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { monthRange, workingDatesInMonth } from '@/lib/attendance/monthCalendar'
import { loadMonthRequests } from '@/lib/attendance/requestsServer'
import {
  isFutureMonth,
  attendanceCoverageThrough,
  isMachineMonth,
  istToday,
  machineLatestDate,
  withinCoverage,
} from '@/lib/attendance/monthAvailability'
import {
  SCORE_RECORD_COLUMNS, buildScoreIndex, fullDayHolidayDates, readScoreContext, scoreDay,
  type ScoreContext, type ScoreRecord,
} from '@/lib/attendance/attendanceScoreboard'
import { istMinutesOfDay } from '@/lib/istDate'

// Hours between two ISO timestamps, rounded to 2 decimal places. Returns null if either is missing.
function hoursWorked(checkIn: string | null, checkOut: string | null): number | null {
  if (!checkIn || !checkOut) return null
  const diff = new Date(checkOut).getTime() - new Date(checkIn).getTime()
  if (diff <= 0) return null
  return Math.round((diff / 36e5) * 100) / 100
}

// Service-role route. `employee_id` was previously trusted as given, so any
// authenticated caller could read any employee's month of punches, lateness and
// penalties. The id is now authorised against the bearer token first.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const requested  = searchParams.get('employee_id')
  const yearParam  = searchParams.get('year')
  const monthParam = searchParams.get('month')

  if (!requested || !yearParam || !monthParam) {
    return NextResponse.json({ error: 'employee_id, year, and month are required' }, { status: 400 })
  }

  const auth = await requireSelfOrAdmin(req, requested)
  if (isResponse(auth)) return auth
  const { caller, employeeId } = auth
  const svc = caller.svc

  const year  = parseInt(yearParam,  10)
  const month = parseInt(monthParam, 10)
  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: 'Invalid year or month' }, { status: 400 })
  }

  // A future month holds no attendance by definition. Answered rather than
  // guessed at, so a stale bookmark or a hand-edited URL cannot produce a
  // calendar full of absences for days that have not happened.
  if (isFutureMonth(year, month)) {
    return NextResponse.json({ error: 'That month has not started yet' }, { status: 400 })
  }

  const { from, to } = monthRange(year, month)

  // This employee's attendance requests for the month. Read for the same
  // employeeId the token authorised, and returned in EVERY answer below —
  // including a month whose attendance has not been imported — because a
  // request and its decision exist whether or not the punches have arrived.
  // A failed read is reported, never turned into "no requests".
  const monthRequests = await loadMonthRequests(svc, employeeId, from, to)
  const requestsPart = { requests: monthRequests.requests, requests_error: monthRequests.error }

  // HOW FAR has the machine export for this month actually got, for ANYONE?
  //
  // The newest attendance_date in the month company-wide. It answers both
  // questions at once — "has anything been imported" (a row exists) and "how
  // much" (which date) — which is why it replaced a bare `count`. A count only
  // says the month was touched, and "August was touched" was being read as
  // "August is complete", so a single punch on the 5th licensed absences
  // through the 31st.
  //
  // Company-wide on purpose. Scoping this to the caller would make "I was
  // absent all month" indistinguishable from "nobody has uploaded the sheet",
  // and the first of those is a real fact that must keep showing. It is also
  // the only honest coverage signal available: the importer writes a row only
  // for a day with a punch (see api/attendance/import), so there is no
  // per-date "processed" marker to read — the furthest day anyone in the
  // company was scanned on is how far the file reached.
  //
  // A month the machine supplies stops at yesterday at the latest: see
  // machineLatestDate for why today cannot be read yet.
  const { data: latestRows, error: importErr } = await svc
    .from('attendance_records')
    .select('attendance_date')
    .gte('attendance_date', from)
    .lte('attendance_date', to)
    .order('attendance_date', { ascending: false })
    .limit(1)

  if (importErr) {
    return NextResponse.json({ error: importErr.message }, { status: 500 })
  }

  const companyLatest = latestRows?.[0]?.attendance_date ?? null
  const machineMonth  = isMachineMonth(year, month)
  const latestImported = machineMonth ? machineLatestDate(companyLatest) : companyLatest
  const monthImported   = latestImported !== null
  const coverageThrough = attendanceCoverageThrough(year, month, latestImported)

  // Nothing imported: say so, and return no rows. Building the calendar here
  // would assert an absence for every working day of a month nobody has
  // processed yet.
  if (!monthImported) {
    const { data: emp } = await svc
      .from('users')
      .select('id, full_name, employee_code, office_timing')
      .eq('id', employeeId)
      .single()

    return NextResponse.json({
      employee: emp ?? null,
      year,
      month,
      month_imported: false,
      coverage_through: null,
      records: [],
      ...requestsPart,
    })
  }

  const [empRes, recRes, corrRes] = await Promise.all([
    svc.from('users')
      .select('id, full_name, employee_code, office_timing, joining_date, exit_date')
      .eq('id', employeeId)
      .single(),
    svc.from('attendance_records')
      .select(`${SCORE_RECORD_COLUMNS}, status`)
      .eq('user_id', employeeId)
      .gte('attendance_date', from)
      .lte('attendance_date', to)
      .order('attendance_date', { ascending: true }),
    // Which of this employee's days an admin has corrected. Read-only, and
    // scoped to the same employeeId the token authorised — an employee is being
    // shown that their own record was edited, not who else's was.
    svc.from('attendance_correction_log')
      .select('attendance_date')
      .eq('user_id', employeeId)
      .gte('attendance_date', from)
      .lte('attendance_date', to),
  ])

  if (empRes.error)      return NextResponse.json({ error: empRes.error.message },      { status: 500 })
  if (recRes.error)      return NextResponse.json({ error: recRes.error.message },      { status: 500 })
  if (!empRes.data)      return NextResponse.json({ error: 'Employee not found' },      { status: 404 })

  // Corrections, approved requests, holidays and the rules in force, so each day
  // below reads as payroll reads it. Scoped to the same employeeId as everything
  // else here.
  let context: ScoreContext
  try {
    context = await readScoreContext(svc, from, to, employeeId)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }

  // The month's working days come from the CALENDAR — every date except
  // Sundays, company holidays and dates outside this employee's employment.
  //
  // It used to be "every date SOMEBODY was scanned on", which quietly dropped
  // any working day with no punches anywhere in the company, and dropped the
  // whole month before an import. A date with no punches is an absence and has
  // to be shown as one; it is not an absence of a date. Same calendar
  // buildWorkingDayCalendar() gives the payroll engine.
  //
  // …and then cut at the coverage date. The calendar knows what a working day
  // is; it does not know which of them anyone has processed. For a finished
  // month that cut is the month end and nothing changes. For the CURRENT month
  // it stops at the last imported day, so the days after it are absent from the
  // response rather than present in it as absences.
  const workingDates = withinCoverage(
    workingDatesInMonth(year, month, {
      holidays:    fullDayHolidayDates(context.holidays),
      joiningDate: empRes.data.joining_date ?? null,
      exitDate:    empRes.data.exit_date ?? null,
    }),
    coverageThrough,
  )

  // Index this employee's records by date
  const correctedDates = new Set((corrRes.data ?? []).map(c => c.attendance_date))

  const rows = (recRes.data ?? []) as unknown as Array<ScoreRecord & { status: string }>
  const recByDate = new Map(rows.map(r => [r.attendance_date, r]))
  const index = buildScoreIndex(rows, context)

  // Build full day list: existing records + synthetic absent rows for missing working days
  const records = workingDates.map(date => {
    const r = recByDate.get(date)
    // What payroll reads this day as. Late is the payroll rule: past the grace
    // period, counted from the company start, and not on a day already waived,
    // approved, or short enough to be a half day.
    const day = scoreDay(index, employeeId, date)

    // No record for this working day → absent
    if (!r) {
      return {
        id:               `absent-${date}`,
        attendance_date:  date,
        check_in_at:      null,
        check_out_at:     null,
        status:           'absent',
        effective_status: 'absent',
        hours_worked:     null,
        late_minutes:     null,
        is_late:          false,
        is_missing_punch: false,
        penalty:          null,
        is_corrected:     correctedDates.has(date),
        day_kind:         day.kind,
      }
    }

    const hasPunchIn  = !!r.check_in_at
    const hasPunchOut = !!r.check_out_at
    const is_missing_punch =
      r.status === 'missing_punch' ||
      ((r.status === 'present' || r.status === 'checked_in' || r.status === 'half_day') &&
        (hasPunchIn !== hasPunchOut))
    const is_late = day.kind === 'late' && day.checkInAt !== null
    const late_minutes = is_late ? istMinutesOfDay(day.checkInAt!) - context.settings.scheduled_in_minutes : null
    return {
      id:               r.id,
      attendance_date:  r.attendance_date,
      check_in_at:      r.check_in_at,
      check_out_at:     r.check_out_at,
      status:           r.status,
      effective_status: is_missing_punch ? 'missing_punch' : r.status,
      hours_worked:     hoursWorked(r.check_in_at, r.check_out_at),
      late_minutes,
      is_late,
      is_missing_punch,
      penalty:          is_missing_punch ? '2h' : null,
      is_corrected:     correctedDates.has(r.attendance_date),
      day_kind:         day.kind,
    }
  })

  // Today in a machine month is still going, so it is not one of the records.
  // It is handed over separately, as what has been punched so far.
  const todayRow = machineMonth ? recByDate.get(istToday()) : undefined

  return NextResponse.json({
    employee: {
      id:            empRes.data.id,
      full_name:     empRes.data.full_name,
      employee_code: empRes.data.employee_code,
      office_timing: empRes.data.office_timing,
    },
    year,
    month,
    month_imported: true,
    // The last date this answer speaks for. The screen names it so a month that
    // stops on the 5th reads as "uploaded this far" rather than as a gap.
    coverage_through: coverageThrough,
    records,
    today_so_far: todayRow ? { check_in_at: todayRow.check_in_at, check_out_at: todayRow.check_out_at } : null,
    ...requestsPart,
  })
}
