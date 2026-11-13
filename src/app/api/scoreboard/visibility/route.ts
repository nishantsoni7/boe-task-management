// GET  /api/scoreboard/visibility          { top5Public }
// POST /api/scoreboard/visibility          { top5Public: boolean }
// Administrators only. Whether staff see the Scoreboard's Top 5 and "Most improved" (owner, 2026-11-13:
// hidden by default; administrators always see them).

import { NextRequest } from 'next/server'
import { dayCloseRoute, jsonBody } from '@/lib/dayClose/route'
import { loadVisibility, saveVisibility } from '@/lib/scoreboard/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  return dayCloseRoute(req, 'scoreboard/visibility', caller => loadVisibility(caller))
}

export async function POST(req: NextRequest) {
  const body = await jsonBody(req)
  return dayCloseRoute(req, 'scoreboard/visibility', caller => saveVisibility(caller, body))
}
