// GET  /api/attendance-requests          own requests (employee) · the queue (admin, ?scope=queue)
// POST /api/attendance-requests          submit a request, or a correction of your own
//
// Identity comes from the bearer token; everything else — including every
// authorisation decision — is in src/lib/attendance/requestHandlers.ts.

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller, UNAUTHORIZED } from '@/lib/security/attendancePayrollApiAuth'
import { listRequests, submitRequest } from '@/lib/attendance/requestHandlers'

export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()
  const r = await listRequests(caller, req.nextUrl.searchParams.get('scope'), req.nextUrl.searchParams.get('status'))
  return NextResponse.json(r.body, { status: r.status })
}

export async function POST(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()
  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  const r = await submitRequest(caller, body, new Date().toISOString())
  return NextResponse.json(r.body, { status: r.status })
}
