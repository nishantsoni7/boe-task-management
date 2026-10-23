// POST /api/impersonation/start   { targetUserId }
//
// Issues a one-time login token for a member so an administrator can sign in
// AS them (see src/lib/impersonation.ts). The browser exchanges `tokenHash` with
// supabase.auth.verifyOtp and becomes the member.
//
// Gate: bearer token -> active, non-deleted administrator. Nothing in the body
// is authority; targetUserId only says WHICH member. Every start is audited
// BEFORE the token is returned, so a login that cannot be recorded is refused.
// No email is sent: generateLink only mints the token.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse, FORBIDDEN } from '@/lib/security/attendancePayrollApiAuth'
import { isValidUUID } from '@/lib/ui'
import { isEligibleImpersonator, startRefusal } from '@/lib/impersonation'

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth

  const body = await req.json().catch(() => null) as { targetUserId?: string } | null
  const targetId = body?.targetUserId

  const refusal = startRefusal(auth.id, targetId)
  if (refusal) return NextResponse.json({ error: refusal }, { status: 400 })
  if (!isValidUUID(targetId!)) return NextResponse.json({ error: 'Invalid targetUserId' }, { status: 400 })

  const { data: actor } = await auth.svc
    .from('users').select('role, is_active, is_deleted').eq('id', auth.id).maybeSingle()
  if (!isEligibleImpersonator(actor)) return FORBIDDEN()

  const { data: target } = await auth.svc
    .from('users').select('id, full_name, email, is_deleted').eq('id', targetId!).maybeSingle()
  if (!target || target.is_deleted === true) {
    return NextResponse.json({ error: 'Member not found' }, { status: 404 })
  }

  const { data: authUser, error: authErr } = await auth.svc.auth.admin.getUserById(target.id)
  const email = authUser?.user?.email ?? target.email
  if (authErr || !email) {
    return NextResponse.json({ error: 'This member has no sign-in account' }, { status: 404 })
  }

  const { data: session, error: auditErr } = await auth.svc
    .from('admin_impersonation_sessions')
    .insert({
      admin_id: auth.id,
      target_user_id: target.id,
      ip_address: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      user_agent: req.headers.get('user-agent'),
    })
    .select('id')
    .single()
  if (auditErr || !session) {
    return NextResponse.json({ error: 'Could not record the session' }, { status: 500 })
  }

  const { data: link, error: linkErr } = await auth.svc.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  const tokenHash = link?.properties?.hashed_token
  if (linkErr || !tokenHash) {
    await auth.svc.from('admin_impersonation_sessions')
      .update({ ended_at: new Date().toISOString() }).eq('id', session.id)
    return NextResponse.json({ error: linkErr?.message ?? 'Could not create login' }, { status: 500 })
  }

  return NextResponse.json({
    sessionId: session.id,
    tokenHash,
    target: { id: target.id, fullName: target.full_name },
  })
}
