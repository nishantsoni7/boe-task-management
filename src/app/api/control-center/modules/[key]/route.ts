import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

const VALID_TYPES = ['live', 'admin_only', 'department_only', 'hidden'] as const

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
  const { visibility_type, allowed_department } = await req.json()

  if (!VALID_TYPES.includes(visibility_type)) {
    return NextResponse.json({ error: 'Invalid visibility_type' }, { status: 400 })
  }

  const departments = Array.isArray(allowed_department)
    ? allowed_department.filter((d): d is string => typeof d === 'string' && d.length > 0)
    : []

  if (visibility_type === 'department_only' && departments.length === 0) {
    return NextResponse.json({ error: 'Select at least one department' }, { status: 400 })
  }

  const { error } = await svc
    .from('app_modules')
    .update({
      visibility_type,
      allowed_department: visibility_type === 'department_only' ? departments : null,
      updated_at: new Date().toISOString(),
    })
    .eq('module_key', key)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
