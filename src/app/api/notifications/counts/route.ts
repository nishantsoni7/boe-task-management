// GET /api/notifications/counts?parts=task,finance,order,sample[&subjectUserId=<uuid>]
//
// The Modules page's unread badges in one call. Each part is the unchanged GET handler of the route it
// stands in for: a notification category runs /api/notifications?count=1&category=<part> (with the
// subjectUserId while an administrator previews somebody), `sample` runs /api/samples/notifications?count=1.
// The answer is { parts: { <part>: { status, body } } }, each exactly what that route would have sent to
// this caller. Reasons and rules: src/lib/notifications/countBatch.ts. The two routes still exist; the
// browser falls back to them if this one fails.

import { NextRequest, NextResponse } from 'next/server'
import { GET as notificationCount } from '../route'
import { GET as sampleCount } from '@/app/api/samples/notifications/route'
import { SAMPLE_PART, loadCounts, parseCountParts } from '@/lib/notifications/countBatch'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const parts = parseCountParts(req.nextUrl.searchParams.get('parts'))
  const subject = req.nextUrl.searchParams.get('subjectUserId')
  const result = await loadCounts(parts, subject, (part, path) => {
    // The caller's own cookies travel with it: each handler signs the caller in from them, as it does for
    // a request of its own. Only the address differs.
    const inner = new NextRequest(new URL(path, req.nextUrl.origin), { headers: req.headers })
    return part === SAMPLE_PART ? sampleCount(inner) : notificationCount(inner)
  })
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } })
}
