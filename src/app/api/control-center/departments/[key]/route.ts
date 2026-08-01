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

// DELETE — hard-removes a department row. departments.department_key is not
// FK-constrained to users.team (see 20260645_create_control_center_v1.sql),
// so nothing at the DB layer stops this from orphaning assigned people —
// this app-level check is what actually keeps that safe. RLS already allows
// admin deletes (departments_admin_delete); no RLS/schema change needed.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const svc = await adminClient(req)
  if (!svc) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { key } = await params

  const { count, error: countError } = await svc
    .from('users')
    .select('id', { count: 'exact', head: true })
    .eq('team', key)
    .or('is_deleted.eq.false,is_deleted.is.null')

  if (countError) return NextResponse.json({ error: countError.message }, { status: 500 })

  if ((count ?? 0) > 0) {
    return NextResponse.json(
      { error: 'This department has people assigned. Move them before deleting.' },
      { status: 409 },
    )
  }

  const { error } = await svc
    .from('departments')
    .delete()
    .eq('department_key', key)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
