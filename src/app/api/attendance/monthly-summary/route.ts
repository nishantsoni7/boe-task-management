import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { monthRange, workingDatesInMonth } from '@/lib/attendance/monthCalendar'

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

  // Fetch all active employees
  const { data: employees, error: empErr } = await svc
    .from('users')
    .select('id, full_name, employee_code')
    .eq('is_active', true)
    .order('full_name')

  if (empErr) return NextResponse.json({ error: empErr.message }, { status: 500 })

  // Fetch all attendance records for the month
  const { data: records, error: recErr } = await svc
    .from('attendance_records')
    .select('user_id, attendance_date, check_in_at, check_out_at, status')
    .gte('attendance_date', from)
    .lte('attendance_date', to)

  if (recErr) return NextResponse.json({ error: recErr.message }, { status: 500 })

  // Fetch public holidays for the month
  const { data: holidays, error: holErr } = await svc
    .from('payroll_holidays')
    .select('holiday_date')
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
  const workingDates = workingDatesInMonth(year, month, {
    holidays: (holidays ?? []).map(h => h.holiday_date),
  })

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

  return NextResponse.json({ year, month, summaries })
}
