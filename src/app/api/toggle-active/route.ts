import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { lastAdministratorBlock } from '@/lib/users/lastAdministrator'

export async function POST(req: NextRequest) {
  const { userId, is_active } = await req.json()

  if (!userId || typeof is_active !== 'boolean') {
    return NextResponse.json({ error: 'userId and is_active are required' }, { status: 400 })
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
    return NextResponse.json({ error: 'Only admins can change member status' }, { status: 403 })
  }

  // ── The last-administrator invariant ──────────────────────────────────────
  //
  // Deactivation was the FIRST HALF of the lockout chain this guard closes:
  // the final administrator could be deactivated here, and /api/delete-user
  // would then accept them precisely BECAUSE they were inactive. Guarding
  // demotion in /api/update-member alone stopped neither step.
  //
  // Only switching OFF can violate it — reactivating somebody adds an
  // administrator, it never removes one.
  if (is_active === false) {
    const { data: target } = await serviceClient
      .from('users')
      .select('role, is_active, is_deleted')
      .eq('id', userId)
      .single()

    const blocked = await lastAdministratorBlock(serviceClient, target, userId, 'deactivate')
    if (blocked) return NextResponse.json({ error: blocked }, { status: 400 })
  }

  const { error } = await serviceClient
    .from('users')
    .update({ is_active })
    .eq('id', userId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
