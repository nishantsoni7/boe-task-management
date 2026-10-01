import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { readAllMinopDeliveries } from '@/lib/minop/incomingQuery'
import { buildIncomingRows, filterIncomingRows, sortIncomingRows, isIstDate } from '@/lib/minop/incomingRegister'

const PAGE_SIZE = 50

/**
 * Admin-only, read-only register of everything Minop has sent: one row per
 * punch, plus a row for every message that could not be read. Never touches
 * attendance, employee mapping or payroll.
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
  const page = Math.max(1, Math.floor(Number(params.get('page') ?? '1')) || 1)

  let read
  try {
    read = await readAllMinopDeliveries(auth.svc)
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not read Minop data' }, { status: 500 })
  }

  const all = buildIncomingRows(read.deliveries)
  const filtered = sortIncomingRows(
    filterIncomingRows(all, { q: params.get('q') ?? '', from: from ?? undefined, to: to ?? undefined }),
  )
  const start = (page - 1) * PAGE_SIZE

  return NextResponse.json({
    rows: filtered.slice(start, start + PAGE_SIZE),
    total: filtered.length,
    page,
    pageSize: PAGE_SIZE,
    messagesRetained: read.deliveries.length,
    latestReceivedAt: read.deliveries[0]?.received_at ?? null,
    truncated: read.truncated,
  })
}
