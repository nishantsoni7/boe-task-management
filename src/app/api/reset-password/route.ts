import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const { userId, newPassword } = await req.json()

  if (!userId || !newPassword) {
    return NextResponse.json({ error: 'userId and newPassword are required' }, { status: 400 })
  }

  if (newPassword.length < 6) {
    return NextResponse.json({ error: 'Password must be at least 6 characters' }, { status: 400 })
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
    return NextResponse.json({ error: 'Only admins can reset passwords' }, { status: 403 })
  }

  const { error } = await supabase.auth.admin.updateUserById(userId, { password: newPassword })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null

  const { error: logError } = await supabase.from('password_reset_log').insert({
    target_id:  userId,
    actor_id:   caller.id,
    ip_address: ip,
  })

  if (logError) {
    console.error('password_reset_log insert failed:', logError.message)
  }

  return NextResponse.json({ success: true })
}
