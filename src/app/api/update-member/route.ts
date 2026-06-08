import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function POST(req: NextRequest) {
  const { userId, full_name, team, role, position, email } = await req.json()

  if (!userId || !full_name?.trim()) {
    return NextResponse.json({ error: 'userId and full_name are required' }, { status: 400 })
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

  const { error } = await supabase
    .from('users')
    .update({
      full_name: full_name.trim(),
      team,
      role,
      position: position || null,
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
