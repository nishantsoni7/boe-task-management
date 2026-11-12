// GET /api/scoreboard/me   the caller's own month-to-date score (the morning card and the evening line), the
// change since yesterday's record, the fastest way up, and the top 5 (names only, never anybody's rank).
// The caller comes from the bearer token. Rules: src/lib/scoreboard/score.ts.

import { NextRequest } from 'next/server'
import { dayCloseRoute } from '@/lib/dayClose/route'
import { loadMyScore } from '@/lib/scoreboard/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(req: NextRequest) {
  return dayCloseRoute(req, 'scoreboard/me', caller => loadMyScore(caller))
}
