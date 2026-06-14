import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

// Returns YYYY-MM-DD date range for a given year+month
function monthRange(year: number, month: number): { from: string; to: string } {
  const from = `${year}-${String(month).padStart(2, '0')}-01`
  const lastDay = new Date(year, month, 0).getDate()
  const to   = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  return { from, to }
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
  }

  // Group records by user_id
  const byEmployee = new Map<string, typeof records[number][]>()
  for (const rec of records ?? []) {
    const arr = byEmployee.get(rec.user_id) ?? []
    arr.push(rec)
    byEmployee.set(rec.user_id, arr)
  }

  const summaries: EmployeeSummary[] = (employees ?? []).map(emp => {
    const recs = byEmployee.get(emp.id) ?? []

    let present       = 0
    let half_day      = 0
    let late          = 0
    let missing_punch = 0

    for (const r of recs) {
      const status = r.status ?? ''

      if (status === 'half_day') {
        half_day++
      } else if (status === 'late') {
        late++
        present++ // late but present
      } else if (status === 'present' || status === 'checked_in') {
        // missing_punch: has check_in but no check_out (or vice versa)
        const hasPunchIn  = !!r.check_in_at
        const hasPunchOut = !!r.check_out_at
        if (hasPunchIn && !hasPunchOut) {
          missing_punch++
        } else {
          present++
        }
      } else if (status === 'missing_punch') {
        missing_punch++
      } else if (status === 'absent') {
        // counted in absent below
      }
    }

    // Absent = days with an explicit absent record
    const absent = recs.filter(r => r.status === 'absent').length

    return {
      employee_id:   emp.id,
      employee_name: emp.full_name,
      employee_code: emp.employee_code,
      present,
      half_day,
      absent,
      late,
      missing_punch,
      total_records: recs.length,
    }
  })

  return NextResponse.json({ year, month, summaries })
}
