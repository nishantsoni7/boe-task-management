// POST /api/impersonation/end   { sessionId }
//
// Closes the audit row of a login-as session. Called while the browser is still
// signed in AS the member, so the caller must be that session's target. It
// grants nothing; it only stamps ended_at, and is idempotent.

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller, UNAUTHORIZED, FORBIDDEN } from '@/lib/security/attendancePayrollApiAuth'
import { isValidUUID } from '@/lib/ui'

export async function POST(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()

  const body = await req.json().catch(() => null) as { sessionId?: string } | null
  const sessionId = body?.sessionId
  if (!sessionId || !isValidUUID(sessionId)) {
    return NextResponse.json({ error: 'Invalid sessionId' }, { status: 400 })
  }

  const { data: row } = await caller.svc
    .from('admin_impersonation_sessions')
    .select('id, target_user_id, ended_at')
    .eq('id', sessionId)
    .maybeSingle()
  if (!row) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  if (row.target_user_id !== caller.id) return FORBIDDEN()

  if (!row.ended_at) {
    await caller.svc
      .from('admin_impersonation_sessions')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', sessionId)
  }
  return NextResponse.json({ ok: true })
}
