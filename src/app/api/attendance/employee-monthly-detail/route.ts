import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

function monthRange(year: number, month: number): { from: string; to: string } {
  const from = `${year}-${String(month).padStart(2, '0')}-01`
  const lastDay = new Date(year, month, 0).getDate()
  const to = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  return { from, to }
}

// Hours between two ISO timestamps, rounded to 2 decimal places. Returns null if either is missing.
function hoursWorked(checkIn: string | null, checkOut: string | null): number | null {
  if (!checkIn || !checkOut) return null
  const diff = new Date(checkOut).getTime() - new Date(checkIn).getTime()
  if (diff <= 0) return null
  return Math.round((diff / 36e5) * 100) / 100
}

// attendance_date is YYYY-MM-DD; parse as local midnight to get the correct day-of-week
function isSunday(dateStr: string): boolean {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).getDay() === 0
}

// Parse office_timing text (e.g. "9:00 AM", "09:30", "9 AM") → minutes from midnight, or null.
// "General Shift" and "Sales Shift" start at 10:00 AM per BOE business rules.
function parseShiftStartMinutes(officeTiming: string | null): number | null {
  if (!officeTiming) return null
  const normalized = officeTiming.trim()
  if (/general\s*shift|sales\s*shift/i.test(normalized)) return 600 // 10:00 AM
  const ampm = normalized.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i)
  if (ampm) {
    let h = parseInt(ampm[1], 10)
    const m = parseInt(ampm[2] ?? '0', 10)
    if (ampm[3].toUpperCase() === 'AM' && h === 12) h = 0
    if (ampm[3].toUpperCase() === 'PM' && h !== 12) h += 12
    return h * 60 + m
  }
  const h24 = normalized.match(/(\d{1,2}):(\d{2})/)
  if (h24) return parseInt(h24[1], 10) * 60 + parseInt(h24[2], 10)
  return null
}

// Minutes past midnight in IST from a UTC timestamp (fingerprint machine times stored as UTC+0 after IST-330 conversion).
function checkInISTMinutes(utcIso: string): number {
  const d = new Date(utcIso)
  return ((d.getUTCHours() * 60 + d.getUTCMinutes()) + 330) % 1440
}

// Returns how many minutes late, or null if on-time / no data.
function calcLateMinutes(checkIn: string | null, shiftStartMins: number | null): number | null {
  if (!checkIn || shiftStartMins === null) return null
  const diff = checkInISTMinutes(checkIn) - shiftStartMins
  return diff > 0 ? diff : null
}

export async function GET(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: { user }, error: authErr } = await svc.auth.getUser(token)
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const employeeId = searchParams.get('employee_id')
  const yearParam  = searchParams.get('year')
  const monthParam = searchParams.get('month')

  if (!employeeId || !yearParam || !monthParam) {
    return NextResponse.json({ error: 'employee_id, year, and month are required' }, { status: 400 })
  }

  const year  = parseInt(yearParam,  10)
  const month = parseInt(monthParam, 10)
  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: 'Invalid year or month' }, { status: 400 })
  }

  const { from, to } = monthRange(year, month)

  const [empRes, recRes, allDatesRes, holRes] = await Promise.all([
    svc.from('users')
      .select('id, full_name, employee_code, office_timing')
      .eq('id', employeeId)
      .single(),
    svc.from('attendance_records')
      .select('id, attendance_date, check_in_at, check_out_at, status')
      .eq('user_id', employeeId)
      .gte('attendance_date', from)
      .lte('attendance_date', to)
      .order('attendance_date', { ascending: true }),
    // Working dates = all dates any employee has a record; used to identify absent days
    svc.from('attendance_records')
      .select('attendance_date')
      .gte('attendance_date', from)
      .lte('attendance_date', to),
    // Public holidays for the month
    svc.from('payroll_holidays')
      .select('holiday_date')
      .gte('holiday_date', from)
      .lte('holiday_date', to),
  ])

  if (empRes.error)      return NextResponse.json({ error: empRes.error.message },      { status: 500 })
  if (recRes.error)      return NextResponse.json({ error: recRes.error.message },      { status: 500 })
  if (allDatesRes.error) return NextResponse.json({ error: allDatesRes.error.message }, { status: 500 })
  if (holRes.error)      return NextResponse.json({ error: holRes.error.message },      { status: 500 })
  if (!empRes.data)      return NextResponse.json({ error: 'Employee not found' },      { status: 404 })

  const shiftStartMins = parseShiftStartMinutes(empRes.data.office_timing)

  const holidayDates = new Set((holRes.data ?? []).map(h => h.holiday_date))

  // Working dates = all dates any employee was scanned this month, excluding Sundays and holidays
  const workingDates = new Set<string>()
  for (const row of allDatesRes.data ?? []) {
    if (!isSunday(row.attendance_date) && !holidayDates.has(row.attendance_date)) {
      workingDates.add(row.attendance_date)
    }
  }

  // Index this employee's records by date
  const recByDate = new Map<string, typeof recRes.data[number]>()
  for (const r of recRes.data ?? []) recByDate.set(r.attendance_date, r)

  // Build full day list: existing records + synthetic absent rows for missing working days
  const allDates = [...workingDates].sort()

  const records = allDates.map(date => {
    const r = recByDate.get(date)

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
      }
    }

    const hasPunchIn  = !!r.check_in_at
    const hasPunchOut = !!r.check_out_at
    const is_missing_punch =
      r.status === 'missing_punch' ||
      ((r.status === 'present' || r.status === 'checked_in' || r.status === 'half_day') &&
        (hasPunchIn !== hasPunchOut))
    const late_minutes = is_missing_punch ? null : calcLateMinutes(r.check_in_at, shiftStartMins)
    return {
      id:               r.id,
      attendance_date:  r.attendance_date,
      check_in_at:      r.check_in_at,
      check_out_at:     r.check_out_at,
      status:           r.status,
      effective_status: is_missing_punch ? 'missing_punch' : r.status,
      hours_worked:     hoursWorked(r.check_in_at, r.check_out_at),
      late_minutes,
      is_late:          late_minutes !== null && late_minutes > 0,
      is_missing_punch,
      penalty:          is_missing_punch ? '2h' : null,
    }
  })

  return NextResponse.json({
    employee: {
      id:            empRes.data.id,
      full_name:     empRes.data.full_name,
      employee_code: empRes.data.employee_code,
      office_timing: empRes.data.office_timing,
    },
    year,
    month,
    records,
  })
}
