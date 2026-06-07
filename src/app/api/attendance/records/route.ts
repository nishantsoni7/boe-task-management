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

  const { searchParams } = new URL(req.url)
  const employeeId = searchParams.get('employee_id')
  const fromDate   = searchParams.get('from')
  const toDate     = searchParams.get('to')
  const format     = searchParams.get('format')
  const page       = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))

  function applyFilters(q: ReturnType<typeof svc.from>) {
    if (employeeId) q = q.eq('user_id', employeeId)
    if (fromDate)   q = q.gte('attendance_date', fromDate)
    if (toDate)     q = q.lte('attendance_date', toDate)
    return q
  }

  // ── CSV export: return all matching rows as a downloadable file ──
  if (format === 'csv') {
    let query = svc
      .from('attendance_records')
      .select('attendance_date, check_in_at, check_out_at, status, users(full_name, employee_code)')
      .order('attendance_date', { ascending: false })

    query = applyFilters(query)

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const rows = data ?? []
    const lines: string[] = ['Date,Employee,Employee Code,Check In,Check Out,Status']
    for (const r of rows) {
      const u = (r.users as { full_name: string; employee_code: string | null } | null)
      lines.push([
        r.attendance_date,
        u?.full_name ?? '',
        u?.employee_code ?? '',
        r.check_in_at ? formatTimeCSV(r.check_in_at) : '',
        r.check_out_at ? formatTimeCSV(r.check_out_at) : '',
        r.status,
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    }

    return new NextResponse(lines.join('\r\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="attendance-records.csv"',
      },
    })
  }

  // ── Paginated JSON response ──
  const from = (page - 1) * PAGE_SIZE
  const to   = from + PAGE_SIZE - 1

  let query = svc
    .from('attendance_records')
    .select('id, attendance_date, check_in_at, check_out_at, status, user_id, users(full_name, employee_code)', { count: 'exact' })
    .order('attendance_date', { ascending: false })
    .range(from, to)

  query = applyFilters(query)

  const { data, error, count } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ records: data ?? [], total: count ?? 0, page, pageSize: PAGE_SIZE })
}

function formatTimeCSV(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}
