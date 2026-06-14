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

  const [empRes, recRes] = await Promise.all([
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
  ])

  if (empRes.error) return NextResponse.json({ error: empRes.error.message }, { status: 500 })
  if (recRes.error) return NextResponse.json({ error: recRes.error.message }, { status: 500 })
  if (!empRes.data)  return NextResponse.json({ error: 'Employee not found' }, { status: 404 })

  const records = (recRes.data ?? []).map(r => ({
    id:              r.id,
    attendance_date: r.attendance_date,
    check_in_at:     r.check_in_at,
    check_out_at:    r.check_out_at,
    status:          r.status,
    hours_worked:    hoursWorked(r.check_in_at, r.check_out_at),
    is_late:         r.status === 'late',
    is_missing_punch:
      r.status === 'missing_punch' ||
      ((r.status === 'present' || r.status === 'checked_in') && (!!r.check_in_at !== !!r.check_out_at)),
  }))

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
