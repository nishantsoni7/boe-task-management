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
//
// VOLUME. The app sends only waits of 5 s or more and errors, at most
// MAX_REPORTS_PER_TAB per tab. Here, a request from another site is refused,
// and each instance logs at most SERVER_MAX_LINES_PER_MINUTE lines a minute —
// the excess is counted and reported in one summary line, so a flood can
// neither bury real reports nor fill the log.

import { NextRequest, NextResponse } from 'next/server'
import { MAX_REPORT_BYTES, SERVER_MAX_LINES_PER_MINUTE, lineBudget, parseRouteHealthReport } from '@/lib/telemetry/routeHealth'

export const dynamic = 'force-dynamic'

const takeLine = lineBudget(SERVER_MAX_LINES_PER_MINUTE, summary => console.log(`[client-health] ${summary}`))

/** Only this app's own pages may report. A missing header (older browsers) is allowed. */
function fromThisSite(req: NextRequest): boolean {
  const site = req.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin') return false
  const origin = req.headers.get('origin')
  if (!origin) return true
  try { return new URL(origin).host === (req.headers.get('x-forwarded-host') ?? req.headers.get('host')) } catch { return false }
}

export async function POST(req: NextRequest) {
  if (!fromThisSite(req)) return new NextResponse(null, { status: 204 })
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > MAX_REPORT_BYTES) return new NextResponse(null, { status: 204 })

  let text = ''
  try { text = await req.text() } catch { return new NextResponse(null, { status: 204 }) }
  if (text.length === 0 || text.length > MAX_REPORT_BYTES) return new NextResponse(null, { status: 204 })

  let body: unknown
  try { body = JSON.parse(text) } catch { return new NextResponse(null, { status: 204 }) }

  const report = parseRouteHealthReport(body)
  if (!report) return new NextResponse(null, { status: 204 })

  if (!takeLine(Date.now())) return new NextResponse(null, { status: 204 })
  const device = /Mobi|Android|iPhone|iPad/i.test(req.headers.get('user-agent') ?? '') ? 'mobile' : 'desktop'
  console.log(`[client-health] ${JSON.stringify({ ...report, device })}`)
  return new NextResponse(null, { status: 204 })
}
