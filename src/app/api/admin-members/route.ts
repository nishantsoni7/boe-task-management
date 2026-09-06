import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

// `performance_tracking_enabled` (20260719000000) is included so Control Center
// can show and set "Included in Performance" on the employee it is editing.
// PARTICIPATION IS NOT ACCESS: it decides whether this person is MEASURED by
// Performance — counted in the team average, the rankings, the attention list —
// and says nothing about which pages they may open, which stays with the
// permission engine. See src/lib/performanceEligibility.ts.
const MEMBER_COLUMNS = 'id, full_name, email, phone, role, team, position, designation_level, is_active, created_at, is_deleted, deleted_at, deletion_scheduled_at, performance_tracking_enabled'

export async function GET(req: NextRequest) {
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
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data, error } = await serviceClient
    .from('users')
    .select(MEMBER_COLUMNS)
    .or('is_deleted.eq.false,is_deleted.is.null')
    .order('full_name')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ members: data ?? [] })
}
