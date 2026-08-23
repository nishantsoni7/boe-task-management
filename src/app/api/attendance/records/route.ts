import { NextRequest, NextResponse } from 'next/server'
import { requireSelfOrAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { PagedReadError, fetchAllRows, unwrapPagedRows } from '@/lib/supabasePaging'

/** One row of the attendance CSV export. */
type CsvAttendanceRow = {
  id: string
  attendance_date: string
  check_in_at: string | null
  check_out_at: string | null
  status: string | null
  // PostgREST returns an embedded relation as an object; the generated types
  // widen it to an array. Both shapes are handled at the call site below, as
  // they were before this read was paged.
  users: { full_name: string; employee_code: string | null }[]
}


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
  //
  // PAGED, BECAUSE "ALL MATCHING ROWS" MEANT AT MOST 1000. Every filter here is
  // optional, so an unfiltered export asks for the whole table — and PostgREST
  // caps a response at 1000 rows with no error and no warning
  // (src/lib/supabasePaging.ts). The file downloaded fine, opened fine, and was
  // missing everything past the newest thousand days of attendance. An export is
  // the worst place for that: it leaves the building and gets reconciled against
  // by somebody who has no way to tell it is short.
  //
  // unwrapPagedRows REFUSES a failed or capped read rather than writing a
  // partial CSV, because a partial CSV is indistinguishable from a complete one.
  if (format === 'csv') {
    const makeCsvPage = (pageFrom: number, pageTo: number) => {
      let q = svc
        .from('attendance_records')
        .select('id, attendance_date, check_in_at, check_out_at, status, users(full_name, employee_code)')
        .order('attendance_date', { ascending: false })
        // A unique tiebreak. range() maps to LIMIT/OFFSET, which promises
        // nothing about row order unless the ordering is deterministic — and two
        // employees share every attendance_date.
        .order('id', { ascending: false })

      if (employeeId) q = q.eq('user_id', employeeId)
      if (fromDate)   q = q.gte('attendance_date', fromDate)
      if (toDate)     q = q.lte('attendance_date', toDate)

      return q.range(pageFrom, pageTo)
    }

    let rows: CsvAttendanceRow[]
    try {
      rows = unwrapPagedRows('attendance export',
        await fetchAllRows<CsvAttendanceRow>(makeCsvPage as unknown as Parameters<typeof fetchAllRows<CsvAttendanceRow>>[0]))
    } catch (err) {
      const detail = err instanceof PagedReadError ? err.detail : String(err)
      return NextResponse.json({ error: detail }, { status: 500 })
    }
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
