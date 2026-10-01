import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { readAllMinopDeliveries } from '@/lib/minop/incomingQuery'
import { buildIncomingRows, filterIncomingRows, sortIncomingRows, isIstDate } from '@/lib/minop/incomingRegister'
import { buildIncomingCsv, buildRawPayloadExport } from '@/lib/minop/incomingCsv'

/**
 * Admin-only download of every record matching the filters, across all pages.
 *   ?format=csv  → Excel-friendly CSV (default)
 *   ?format=raw  → each matching message once, with its full received body
 * Read-only.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth

  const params = new URL(req.url).searchParams
  const from = params.get('from')
  const to = params.get('to')
  if ((from && !isIstDate(from)) || (to && !isIstDate(to))) {
    return NextResponse.json({ error: 'Dates must be real calendar dates, YYYY-MM-DD.' }, { status: 400 })
  }
  const format = params.get('format') === 'raw' ? 'raw' : 'csv'

  let read
  try {
    read = await readAllMinopDeliveries(auth.svc)
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not read Minop data' }, { status: 500 })
  }

  const rows = sortIncomingRows(
    filterIncomingRows(buildIncomingRows(read.deliveries), { q: params.get('q') ?? '', from: from ?? undefined, to: to ?? undefined }),
  )
  const stamp = new Date().toISOString().slice(0, 10)
  const headers = { 'Cache-Control': 'no-store', 'X-Minop-Export-Truncated': read.truncated ? 'yes' : 'no' }

  if (format === 'raw') {
    return new NextResponse(buildRawPayloadExport(rows, read.deliveries), {
      headers: {
        ...headers,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="minop-raw-payloads-${stamp}.json"`,
      },
    })
  }
  return new NextResponse(buildIncomingCsv(rows), {
    headers: {
      ...headers,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="minop-incoming-data-${stamp}.csv"`,
    },
  })
}
