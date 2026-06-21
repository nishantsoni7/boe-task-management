import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

async function adminClient(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '').trim()
  if (!token) return null

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: { user } } = await svc.auth.getUser(token)
  if (!user) return null

  const { data: p } = await svc.from('users').select('role').eq('id', user.id).single()
  if (p?.role !== 'admin') return null

  return svc
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const svc = await adminClient(req)
  if (!svc) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { key } = await params
  const { department_name, is_active } = await req.json()

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (department_name !== undefined) {
    if (!department_name.trim()) return NextResponse.json({ error: 'Name cannot be empty' }, { status: 400 })
    updates.department_name = department_name.trim()
  }
  if (is_active !== undefined) updates.is_active = Boolean(is_active)

  const { error } = await svc
    .from('departments')
    .update(updates)
    .eq('department_key', key)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
