import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { isDesignationLevel } from '@/lib/users/designationLevels'
import { lastAdministratorBlock } from '@/lib/users/lastAdministrator'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function POST(req: NextRequest) {
  const { userId, full_name, team, role, position, email, designation_level } = await req.json()

  if (!userId || !full_name?.trim()) {
    return NextResponse.json({ error: 'userId and full_name are required' }, { status: 400 })
  }

  // Validated rather than trusted; the column's CHECK constraint would
  // otherwise turn a typo into an opaque database error. Setting a level
  // changes no permission — it is the organisational rung, not access.
  const levelGiven = designation_level !== undefined
  if (levelGiven && designation_level != null && designation_level !== '' && !isDesignationLevel(designation_level)) {
    return NextResponse.json({ error: 'Unknown designation level' }, { status: 400 })
  }

  if (email !== undefined) {
    if (!email?.trim()) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 })
    }
    if (!EMAIL_RE.test(email.trim())) {
      return NextResponse.json({ error: 'Please enter a valid email address' }, { status: 400 })
    }
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

  // ── The last-administrator invariant ──────────────────────────────────────
  //
  // Demotion is one of four paths that can take the final administrator's
  // authority away; the others are deactivation, soft deletion and permanent
  // deletion, each guarded in its own route with the same shared rule. See
  // src/lib/users/lastAdministrator.ts for why the count requires an ACTIVE
  // administrator and not merely a non-deleted one.
  //
  // Only a change AWAY from 'admin' can violate it: leaving `role` out of the
  // request, or setting it to 'admin', removes nothing.
  if (role !== undefined && role !== 'admin') {
    const { data: target } = await supabase
      .from('users')
      .select('role, is_active, is_deleted')
      .eq('id', userId)
      .single()

    const blocked = await lastAdministratorBlock(supabase, target, userId, 'demote')
    if (blocked) return NextResponse.json({ error: blocked }, { status: 400 })
  }

  const { error } = await supabase
    .from('users')
    .update({
      full_name: full_name.trim(),
      team,
      role,
      position: position || null,
      // Absent from the request means "leave it alone" — the Control Center's
      // department-only edits post no level, and must not blank one.
      ...(levelGiven ? { designation_level: designation_level || null } : {}),
      ...(email !== undefined ? { email: email.trim() } : {}),
    })
    .eq('id', userId)

  if (error) {
    if (error.message.includes('duplicate') || error.message.includes('unique')) {
      return NextResponse.json({ error: 'This email is already in use by another member' }, { status: 400 })
    }
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  if (email !== undefined) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, { email: email.trim() })
    if (authError) {
      if (authError.message.includes('already') || authError.message.includes('duplicate')) {
        return NextResponse.json({ error: 'This email is already registered in auth' }, { status: 400 })
      }
      return NextResponse.json({ error: authError.message }, { status: 400 })
    }
  }

  return NextResponse.json({ success: true })
}
