// GET  /api/scoreboard/ratings   the owner's ratings for this month, and (once the vote has closed) each
//                                person's vote total and the anonymous lines
// POST /api/scoreboard/ratings   { employee_id, rating: 1-5, reason }   from the 25th until the month closes
// The owner alone (the Day Close reviewer seat).

import { NextRequest } from 'next/server'
import { dayCloseRoute, jsonBody } from '@/lib/dayClose/route'
import { loadRatings, saveRating } from '@/lib/scoreboard/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  return dayCloseRoute(req, 'scoreboard/ratings', caller => loadRatings(caller))
}

export async function POST(req: NextRequest) {
  const body = await jsonBody(req)
  return dayCloseRoute(req, 'scoreboard/ratings', caller => saveRating(caller, body))
}
