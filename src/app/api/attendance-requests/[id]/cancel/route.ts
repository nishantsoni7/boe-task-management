// POST /api/attendance-requests/[id]/cancel     the employee withdraws their OWN request
//
// The row is never deleted — its status becomes `cancelled` and the audit
// trigger records who and when. Rules: src/lib/attendance/requestHandlers.ts.

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller, UNAUTHORIZED } from '@/lib/security/attendancePayrollApiAuth'
import { cancelRequest } from '@/lib/attendance/requestHandlers'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()
  const { id } = await params
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const r = await cancelRequest(caller, id, body, new Date().toISOString())
  return NextResponse.json(r.body, { status: r.status })
}
