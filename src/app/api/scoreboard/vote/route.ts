// GET  /api/scoreboard/vote   this month's vote: open or not, the colleagues to choose from, and the caller's
//                             own three (never anybody else's)
// POST /api/scoreboard/vote   { nominees: [3 ids], notes: { id: "how they helped" } }   once a month
// Secret: no route ever shows who voted for whom. Rules: src/lib/scoreboard/vote.ts.

import { NextRequest } from 'next/server'
import { dayCloseRoute, jsonBody } from '@/lib/dayClose/route'
import { castVote, loadVote } from '@/lib/scoreboard/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  return dayCloseRoute(req, 'scoreboard/vote', caller => loadVote(caller))
}

export async function POST(req: NextRequest) {
  const body = await jsonBody(req)
  return dayCloseRoute(req, 'scoreboard/vote', caller => castVote(caller, body))
}
