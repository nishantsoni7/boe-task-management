import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { getEffectivePermissionsForUser } from '@/lib/permissions/resolver'

// Returns allowed Sample Tracking action keys for any user_id.
// Requires the caller to be an admin (verified via their session token).
// Uses service role to run the resolver as the DB owner — admins need to
// read any user's effective permissions to power Admin View Mode.

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? ''
  const callerToken = authHeader.replace('Bearer ', '').trim()
  if (!callerToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userId = req.nextUrl.searchParams.get('userId')
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 })

  const serviceClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: { user: caller }, error: callerErr } = await serviceClient.auth.getUser(callerToken)
  if (callerErr || !caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: callerProfile } = await serviceClient
    .from('users')
    .select('role')
    .eq('id', caller.id)
    .single()

  if (callerProfile?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const effectiveByModule = await getEffectivePermissionsForUser(serviceClient, userId)
    const permissions = (effectiveByModule.get('sample_tracking') ?? [])
      .filter(p => p.allowed)
      .map(p => p.actionKey)

    return NextResponse.json({ permissions })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}
