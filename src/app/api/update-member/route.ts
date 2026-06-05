import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const { userId, full_name, team, role, position } = await req.json()

  if (!userId || !full_name?.trim()) {
    return NextResponse.json({ error: 'userId and full_name are required' }, { status: 400 })
  }

  const authHeader = req.headers.get('authorization') ?? ''
  const callerToken = authHeader.replace('Bearer ', '').trim()
  if (!callerToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: { user: caller }, error: callerError } = await supabase.auth.getUser(callerToken)
  if (callerError || !caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: callerProfile } = await supabase
    .from('users')
    .select('role')
    .eq('id', caller.id)
    .single()

  if (callerProfile?.role !== 'admin') {
    return NextResponse.json({ error: 'Only admins can update members' }, { status: 403 })
  }

  const { error } = await supabase
    .from('users')
    .update({ full_name: full_name.trim(), team, role, position: position || null })
    .eq('id', userId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true })
}
