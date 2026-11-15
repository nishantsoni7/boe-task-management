// GET /api/day-close/launcher?parts=prompt,me,vote,starSeller,punch,machine,queue
//
// The Modules page's answers in one call: the Day Close strip (/api/day-close/prompt), the score card
// (/api/scoreboard/me), the vote card (/api/scoreboard/vote), the Star Seller card
// (/api/scoreboard/star-seller), the punch-in strip (/api/attendance/my-punch) and, for an administrator, the
// attendance machine's health (/api/attendance/machine-status) and the pending requests
// (/api/attendance-requests?scope=queue&status=pending). The first four are that route's own loader for the
// same caller; the last three are that route's own unchanged GET handler, run with the caller's own headers
// (the bearer token) and the address it always had, so its sign-in and its administrator-only refusal are
// its own. Each comes back with the status and body its route would have sent:
// { parts: { prompt: { status, body }, ... } }.
// Rules and the reasons: src/lib/dayClose/launcherBatch.ts. The routes still exist; the client falls back
// to them if this one fails.

import { NextRequest } from 'next/server'
import { GET as machineStatus } from '@/app/api/attendance/machine-status/route'
import { GET as myPunch } from '@/app/api/attendance/my-punch/route'
import { GET as requestQueue } from '@/app/api/attendance-requests/route'
import { dayCloseRoute } from '@/lib/dayClose/route'
import { loadMyPrompt, type Result } from '@/lib/dayClose/server'
import { loadLauncher, parseLauncherParts } from '@/lib/dayClose/launcherBatch'
import { loadMyScore, loadVote } from '@/lib/scoreboard/server'
import { loadStarSeller } from '@/lib/scoreboard/starSeller'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(req: NextRequest) {
  const parts = parseLauncherParts(req.nextUrl.searchParams.get('parts'))
  // An attendance part: that route's own GET, asked with this request's own headers and its own address.
  const viaRoute = (handler: (inner: NextRequest) => Promise<Response>, path: string) => async (): Promise<Result> => {
    const res = await handler(new NextRequest(new URL(path, req.nextUrl.origin), { headers: req.headers }))
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
  }
  return dayCloseRoute(req, 'launcher', caller => loadLauncher(caller, parts, {
    prompt: c => loadMyPrompt(c),
    me: c => loadMyScore(c),
    vote: c => loadVote(c),
    starSeller: c => loadStarSeller(c),
    punch: viaRoute(myPunch, '/api/attendance/my-punch'),
    machine: viaRoute(machineStatus, '/api/attendance/machine-status'),
    queue: viaRoute(requestQueue, '/api/attendance-requests?scope=queue&status=pending'),
  }))
}
