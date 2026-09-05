import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { isDesignationLevel } from '@/lib/users/designationLevels'

export async function POST(req: NextRequest) {
  const { email, password, full_name, phone, role, team, position, designation_level } = await req.json()

  // The organisational rung. Optional, and validated rather than trusted: the
  // column carries a CHECK constraint, so an unknown value would fail the
  // insert with a database error instead of a readable one. It grants nothing
  // either way — see src/lib/users/designationLevels.ts.
  if (designation_level != null && designation_level !== '' && !isDesignationLevel(designation_level)) {
    return NextResponse.json({ error: 'Unknown designation level' }, { status: 400 })
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
    return NextResponse.json({ error: 'Only admins can create members' }, { status: 403 })
  }

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })

  if (authError || !authData.user) {
    return NextResponse.json({ error: authError?.message || 'Failed to create user' }, { status: 400 })
  }

  const { error: dbError } = await supabase.from('users').insert({
    id: authData.user.id,
    full_name,
    email,
    phone: phone || null,
    role,
    team,
    position: position || null,
    designation_level: designation_level || null,
    is_active: true,
  })

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 400 })
  }

  return NextResponse.json({ success: true })
}