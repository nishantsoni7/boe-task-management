// GET  /api/scoreboard/review?month=YYYY-MM-01   the month's final standings, suggested awards, private-review
//                                                flags, what is saved, and (once frozen) the WhatsApp message
// POST /api/scoreboard/review   { action: 'freeze', month, awards: { key: [ids] }, notes: { key: text } }
//                               { action: 'goals', month, employee_id, goals: [..3], checkin_on, warning, note }
// The owner alone (the Day Close reviewer seat). Rules: src/lib/scoreboard/review.ts.

import { NextRequest } from 'next/server'
import { dayCloseRoute, jsonBody } from '@/lib/dayClose/route'
import { freezeMonth, loadReview, saveGoals } from '@/lib/scoreboard/reviewServer'
import type { Result } from '@/lib/scoreboard/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  return dayCloseRoute(req, 'scoreboard/review', caller => loadReview(caller, req.nextUrl.searchParams.get('month')))
}

export async function POST(req: NextRequest) {
  const body = await jsonBody(req)
  return dayCloseRoute(req, 'scoreboard/review', async (caller): Promise<Result> => {
    if (body.action === 'freeze') return freezeMonth(caller, body)
    if (body.action === 'goals') return saveGoals(caller, body)
    return { status: 400, body: { error: 'Unknown action.' } }
  })
}
