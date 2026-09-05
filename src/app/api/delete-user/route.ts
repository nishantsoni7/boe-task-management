import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { checkLastAdministrator } from '@/lib/users/lastAdministrator'

export async function POST(req: NextRequest) {
  const { userId } = await req.json()

  if (!userId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  }

  const authHeader = req.headers.get('authorization') ?? ''
  const callerToken = authHeader.replace('Bearer ', '').trim()
  if (!callerToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const serviceClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: { user: caller }, error: callerError } = await serviceClient.auth.getUser(callerToken)
  if (callerError || !caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: callerProfile } = await serviceClient
    .from('users')
    .select('role')
    .eq('id', caller.id)
    .single()

  if (callerProfile?.role !== 'admin') {
    return NextResponse.json({ error: 'Only admins can delete members' }, { status: 403 })
  }

  const { data: target, error: targetError } = await serviceClient
    .from('users')
    .select('id, role, is_active, is_deleted')
    .eq('id', userId)
    .single()

  if (targetError || !target) {
    return NextResponse.json({ error: 'Member not found' }, { status: 404 })
  }

  if (target.is_active) {
    return NextResponse.json({ error: 'Please deactivate this member before deleting.' }, { status: 400 })
  }

  if (target.is_deleted) {
    return NextResponse.json({ error: 'Member is already deleted' }, { status: 400 })
  }

  // ── The last-administrator invariant ──────────────────────────────────────
  //
  // The SECOND HALF of the lockout chain. A target reaching this line is always
  // inactive — the check above requires it — so "they were only deactivated,
  // not removed" is no defence: this is the step that takes the account out of
  // the directory, and it must not take the last administrator with it.
  //
  // The shared rule asks whether any OTHER active, non-deleted administrator
  // remains, which is the right question here too: soft-deleting a spare
  // administrator while a working one exists is ordinary housekeeping and stays
  // allowed.
  const check = await checkLastAdministrator(serviceClient, userId, 'delete')
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })

  const now = new Date()
  const scheduledAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)

  const { error } = await serviceClient
    .from('users')
    .update({
      is_deleted: true,
      deleted_at: now.toISOString(),
      deleted_by: caller.id,
      deletion_scheduled_at: scheduledAt.toISOString(),
    })
    .eq('id', userId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
