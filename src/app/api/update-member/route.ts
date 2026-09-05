import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { isDesignationLevel } from '@/lib/users/designationLevels'

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

  // ── The last-administrator guard ──────────────────────────────────────────
  //
  // `users.role = 'admin'` is this system's highest authority: it is what every
  // RLS policy tests, what the permission engine short-circuits on, and what
  // admits somebody to the Control Center. Nothing else can hand it back.
  //
  // Until this check, an administrator could set the only remaining admin
  // account — their own, in the usual case — to `manager` or `member` in one
  // click, and the organisation would be locked out of its own administration
  // with no route to recovery inside the application. That is the exact
  // accident this refuses.
  //
  // It is deliberately narrow: demoting an admin is fine while another one
  // remains. Only the LAST one is protected, and the message says so.
  if (role !== undefined && role !== 'admin') {
    const { data: target } = await supabase
      .from('users')
      .select('role')
      .eq('id', userId)
      .single()

    if (target?.role === 'admin') {
      // Deleted accounts cannot sign in, so they do not count as a remaining
      // administrator; an inactive one can be reactivated and does.
      const { count } = await supabase
        .from('users')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'admin')
        .or('is_deleted.eq.false,is_deleted.is.null')

      if ((count ?? 0) <= 1) {
        return NextResponse.json({
          error: 'This is the only administrator account. Give another member the Administrator system role before changing this one, or the system would be left with nobody who can manage it.',
        }, { status: 400 })
      }
    }
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
