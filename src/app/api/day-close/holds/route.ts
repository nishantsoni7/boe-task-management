// GET /api/day-close/holds?year=YYYY&month=M   administrators: the month's held days still to decide, and those
// decided (Attendance -> Monthly Review). Rules: src/lib/dayClose/hold.ts (loadMonthHolds).

import { NextRequest } from 'next/server'
import { dayCloseRoute } from '@/lib/dayClose/route'
import { loadMonthHolds } from '@/lib/dayClose/hold'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams
  return dayCloseRoute(req, 'holds', caller => loadMonthHolds(caller, Number(q.get('year')), Number(q.get('month'))))
}
