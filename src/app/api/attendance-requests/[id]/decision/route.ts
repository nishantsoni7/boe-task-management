// POST /api/attendance-requests/[id]/decision     admin approves or rejects
//
// Approval records PERMISSION only; it changes no punch, correction, deduction
// or salary. An admin cannot decide their own request. Rules:
// src/lib/attendance/requestHandlers.ts.

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller, UNAUTHORIZED } from '@/lib/security/attendancePayrollApiAuth'
import { decideRequest } from '@/lib/attendance/requestHandlers'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()
  const { id } = await params
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const r = await decideRequest(caller, id, body, new Date().toISOString())
  return NextResponse.json(r.body, { status: r.status })
}
