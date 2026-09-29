// GET  /api/attendance-requests/reconciliation?year=&month=[&summary=1]   admin: the month's review
// POST /api/attendance-requests/reconciliation                              admin: record a decision
//
// The POST applies a Paid / waived or Unpaid actual decision through the SAME
// attendance-correction service as /api/payroll/attendance-correction, then
// records it. Nothing here calculates money. Rules and authorisation:
// src/lib/attendance/requestHandlers.ts.

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller, UNAUTHORIZED } from '@/lib/security/attendancePayrollApiAuth'
import { getReconciliation, saveReview } from '@/lib/attendance/requestHandlers'
import { istToday } from '@/lib/istDate'

export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()
  const p = req.nextUrl.searchParams
  const r = await getReconciliation(caller, p.get('year'), p.get('month'), p.get('summary') === '1', istToday())
  return NextResponse.json(r.body, { status: r.status })
}

export async function POST(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()
  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  const r = await saveReview(caller, body, istToday())
  return NextResponse.json(r.body, { status: r.status })
}
