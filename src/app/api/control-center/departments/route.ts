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

  // Deactivating or soft-deleting a member does not revoke their Supabase
  // session, so role alone is not enough. is_deleted is treated as nullable
  // (as /api/admin-members already does), so only an explicit true rejects.
  const { data: p } = await svc.from('users').select('role, is_active, is_deleted').eq('id', user.id).single()
  if (!p || p.role !== 'admin' || p.is_active !== true || p.is_deleted === true) return null

  return svc
}

export async function GET(req: NextRequest) {
  const svc = await adminClient(req)
  if (!svc) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await svc
    .from('departments')
    .select('id, department_key, department_name, is_active, sort_order')
    .order('sort_order')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ departments: data ?? [] })
}

export async function POST(req: NextRequest) {
  const svc = await adminClient(req)
  if (!svc) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { department_name } = await req.json()
  if (!department_name?.trim()) {
    return NextResponse.json({ error: 'Department name is required' }, { status: 400 })
  }

  const department_key = department_name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

  const { data: existing } = await svc
    .from('departments')
    .select('id')
    .eq('department_key', department_key)
    .single()

  if (existing) {
    return NextResponse.json({ error: 'A department with this name already exists' }, { status: 400 })
  }

  const { data: last } = await svc
    .from('departments')
    .select('sort_order')
    .order('sort_order', { ascending: false })
    .limit(1)
    .single()

  const sort_order = ((last?.sort_order ?? 0) + 10)

  const { data, error } = await svc
    .from('departments')
    .insert({ department_key, department_name: department_name.trim(), sort_order })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ department: data })
}
