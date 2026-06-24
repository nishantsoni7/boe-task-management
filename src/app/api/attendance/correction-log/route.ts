import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

const PAGE_SIZE = 50

export async function GET(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: { user }, error: authErr } = await svc.auth.getUser(token)
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: me } = await svc.from('users').select('role').eq('id', user.id).single()
  if (!me || me.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { searchParams } = new URL(req.url)
  const page  = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
  const month = searchParams.get('month')   // optional "YYYY-MM" filter
  const from  = (page - 1) * PAGE_SIZE
  const to    = from + PAGE_SIZE - 1

  // Validate month param strictly before using it in date arithmetic
  if (month !== null) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return NextResponse.json({ error: 'Invalid month parameter. Expected format: YYYY-MM (e.g. 2026-04)' }, { status: 400 })
    }
  }

  // Build a safe half-open range [startDate, endDate) to avoid invalid dates
  // like 2026-04-31 or 2026-02-31.
  let startDate: string | null = null
  let endDate:   string | null = null
  if (month) {
    const [y, m] = month.split('-').map(Number)
    startDate = `${y}-${String(m).padStart(2, '0')}-01`
    const nextMonth = m === 12 ? 1 : m + 1
    const nextYear  = m === 12 ? y + 1 : y
    endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`
  }

  let query = svc
    .from('attendance_correction_log')
    .select(`
      id,
      attendance_date,
      old_check_in_at,
      new_check_in_at,
      old_check_out_at,
      new_check_out_at,
      corrected_at,
      source_file_name,
      employee:user_id ( full_name, employee_code ),
      corrector:corrected_by ( full_name )
    `, { count: 'exact' })
    .order('corrected_at', { ascending: false })
    .range(from, to)

  if (startDate && endDate) {
    query = query
      .gte('attendance_date', startDate)
      .lt('attendance_date', endDate)
  }

  const { data: rows, error: logErr, count } = await query
  if (logErr) return NextResponse.json({ error: logErr.message }, { status: 500 })

  // Collect distinct (month, year) pairs to look up payroll status
  const periodKeys = new Set<string>()
  for (const r of rows ?? []) {
    const d = new Date(r.attendance_date)
    periodKeys.add(`${d.getFullYear()}-${d.getMonth() + 1}`)
  }

  let payrollMap: Record<string, string> = {}
  if (periodKeys.size > 0) {
    const { data: periods } = await svc
      .from('payroll_periods')
      .select('payroll_month, payroll_year, status')
    for (const p of periods ?? []) {
      payrollMap[`${p.payroll_year}-${p.payroll_month}`] = p.status
    }
  }

  const results = (rows ?? []).map(r => {
    const d    = new Date(r.attendance_date)
    const key  = `${d.getFullYear()}-${d.getMonth() + 1}`
    const emp  = Array.isArray(r.employee)  ? r.employee[0]  : r.employee
    const corr = Array.isArray(r.corrector) ? r.corrector[0] : r.corrector

    return {
      id:               r.id,
      attendance_date:  r.attendance_date,
      employee_name:    emp?.full_name    ?? '—',
      employee_code:    emp?.employee_code ?? null,
      change_type:      (r.old_check_in_at == null && r.old_check_out_at == null) ? 'New' : 'Modified',
      old_check_in_at:  r.old_check_in_at,
      new_check_in_at:  r.new_check_in_at,
      old_check_out_at: r.old_check_out_at,
      new_check_out_at: r.new_check_out_at,
      corrected_by:     corr?.full_name   ?? '—',
      corrected_at:     r.corrected_at,
      source_file_name: r.source_file_name ?? null,
      payroll_status:   payrollMap[key] ?? 'not_generated',
    }
  })

  return NextResponse.json({
    results,
    total: count ?? 0,
    page,
    page_size: PAGE_SIZE,
  })
}
