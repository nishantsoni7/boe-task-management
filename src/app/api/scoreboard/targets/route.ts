// GET  /api/scoreboard/targets?month=YYYY-MM-01   every scored person and their track and targets for the month
// POST /api/scoreboard/targets                    { month, employee_id, track, sales_target, role_target, role_kind, role_label }
// Administrators only (the owner sets these on the 1st).

import { NextRequest } from 'next/server'
import { dayCloseRoute, jsonBody } from '@/lib/dayClose/route'
import { loadTargets, saveTarget } from '@/lib/scoreboard/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  return dayCloseRoute(req, 'scoreboard/targets', caller => loadTargets(caller, req.nextUrl.searchParams.get('month')))
}

export async function POST(req: NextRequest) {
  const body = await jsonBody(req)
  return dayCloseRoute(req, 'scoreboard/targets', caller => saveTarget(caller, body))
}
