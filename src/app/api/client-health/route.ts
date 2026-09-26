// POST /api/client-health — privacy-safe evidence of slow navigations and page
// errors, sent by RouteHealthReporter with navigator.sendBeacon.
//
// STORES NOTHING. Each accepted report becomes ONE structured line in the
// function's runtime log (Vercel → Logs, search "client-health"), which is where
// an 8–15 second incident can be looked up afterwards by route and time.
//
// It reads no cookie and no session, so it knows nothing about who sent it. The
// body is capped, parsed against a strict whitelist and re-scrubbed
// (parseRouteHealthReport); anything else is dropped with a 204 so a bad or
// hostile request learns nothing. The only thing added here is a coarse device
// class from the user agent.

import { NextRequest, NextResponse } from 'next/server'
import { MAX_REPORT_BYTES, parseRouteHealthReport } from '@/lib/telemetry/routeHealth'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > MAX_REPORT_BYTES) return new NextResponse(null, { status: 204 })

  let text = ''
  try { text = await req.text() } catch { return new NextResponse(null, { status: 204 }) }
  if (text.length === 0 || text.length > MAX_REPORT_BYTES) return new NextResponse(null, { status: 204 })

  let body: unknown
  try { body = JSON.parse(text) } catch { return new NextResponse(null, { status: 204 }) }

  const report = parseRouteHealthReport(body)
  if (!report) return new NextResponse(null, { status: 204 })

  const device = /Mobi|Android|iPhone|iPad/i.test(req.headers.get('user-agent') ?? '') ? 'mobile' : 'desktop'
  console.log(`[client-health] ${JSON.stringify({ ...report, device })}`)
  return new NextResponse(null, { status: 204 })
}
