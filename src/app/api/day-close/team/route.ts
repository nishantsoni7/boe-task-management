// GET /api/day-close/team?date=YYYY-MM-DD   Team Today: every person switched on, their punches, plan,
// items with proof, calls logged, overdue tasks and strikes; and every strike waiting for a decision.
// Administrators and the Day Close reviewer only.

import { NextRequest } from 'next/server'
import { dayCloseRoute } from '@/lib/dayClose/route'
import { loadTeam } from '@/lib/dayClose/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  return dayCloseRoute(req, 'team', caller => loadTeam(caller, req.nextUrl.searchParams.get('date')))
}
