// GET /api/day-close/launcher?parts=prompt,me,vote,starSeller
//
// The Modules page's four answers in one call: the Day Close strip (/api/day-close/prompt), the score card
// (/api/scoreboard/me), the vote card (/api/scoreboard/vote) and the Star Seller card
// (/api/scoreboard/star-seller). Each part is that route's own loader for the same caller and comes back
// with the status and body its route would have sent: { parts: { prompt: { status, body }, ... } }.
// Rules and the reasons: src/lib/dayClose/launcherBatch.ts. The four routes still exist; the client
// falls back to them if this one fails.

import { NextRequest } from 'next/server'
import { dayCloseRoute } from '@/lib/dayClose/route'
import { loadMyPrompt } from '@/lib/dayClose/server'
import { loadLauncher, parseLauncherParts } from '@/lib/dayClose/launcherBatch'
import { loadMyScore, loadVote } from '@/lib/scoreboard/server'
import { loadStarSeller } from '@/lib/scoreboard/starSeller'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(req: NextRequest) {
  const parts = parseLauncherParts(req.nextUrl.searchParams.get('parts'))
  return dayCloseRoute(req, 'launcher', caller => loadLauncher(caller, parts, {
    prompt: c => loadMyPrompt(c),
    me: c => loadMyScore(c),
    vote: c => loadVote(c),
    starSeller: c => loadStarSeller(c),
  }))
}
