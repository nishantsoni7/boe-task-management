import { NextRequest, NextResponse } from 'next/server'
import { requireSelfOrAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'

const PAGE_SIZE = 50

function formatTimeCSV(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

// Service-role route: RLS does not apply, so the identity check below is the
// entire boundary. Before it existed, omitting `employee_id` returned every
// employee's punches — and `format=csv` returned the whole company's attendance,
// with names, as a downloadable file, to any authenticated caller.
//
// An admin may query anyone, or everyone. A non-admin is pinned to their own
// user id whatever the query string says, so a cross-employee export is not
// refused so much as impossible to express.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const requested = searchParams.get('employee_id')

  const auth = await requireSelfOrAdmin(req, requested)
  if (isResponse(auth)) return auth
  const { caller, canReadAll } = auth
  const svc = caller.svc

  // Admin: honour the filter as given, null = every employee. Everyone else:
  // their own rows only, regardless of what arrived.
  const employeeId = canReadAll ? requested : caller.id

  const fromDate   = searchParams.get('from')
  const toDate     = searchParams.get('to')
  const format     = searchParams.get('format')
  const page       = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))

  // ── CSV export: return all matching rows as a downloadable file ──
  if (format === 'csv') {
    let csvQuery = svc
      .from('attendance_records')
      .select('attendance_date, check_in_at, check_out_at, status, users(full_name, employee_code)')
      .order('attendance_date', { ascending: false })

    if (employeeId) csvQuery = csvQuery.eq('user_id', employeeId)
    if (fromDate)   csvQuery = csvQuery.gte('attendance_date', fromDate)
    if (toDate)     csvQuery = csvQuery.lte('attendance_date', toDate)

    const { data, error } = await csvQuery
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const rows = data ?? []
    const lines: string[] = ['Date,Employee,Employee Code,Check In,Check Out,Status']
    for (const r of rows) {
      const u = Array.isArray(r.users) ? r.users[0] : r.users as { full_name: string; employee_code: string | null } | null
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

  let pageQuery = svc
    .from('attendance_records')
    .select('id, attendance_date, check_in_at, check_out_at, status, user_id, users(full_name, employee_code)', { count: 'exact' })
    .order('attendance_date', { ascending: false })
    .range(from, to)

  if (employeeId) pageQuery = pageQuery.eq('user_id', employeeId)
  if (fromDate)   pageQuery = pageQuery.gte('attendance_date', fromDate)
  if (toDate)     pageQuery = pageQuery.lte('attendance_date', toDate)

  const { data, error, count } = await pageQuery
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ records: data ?? [], total: count ?? 0, page, pageSize: PAGE_SIZE })
}
