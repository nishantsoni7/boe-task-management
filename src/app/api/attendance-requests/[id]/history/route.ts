// GET /api/attendance-requests/[id]/history     the audit trail of one request chain
//
// Own chain for an employee; any for an admin. Rules:
// src/lib/attendance/requestHandlers.ts.

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller, UNAUTHORIZED } from '@/lib/security/attendancePayrollApiAuth'
import { requestHistory } from '@/lib/attendance/requestHandlers'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()
  const { id } = await params
  const r = await requestHistory(caller, id)
  return NextResponse.json(r.body, { status: r.status })
}
