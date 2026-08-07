import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

const VALID_TYPES = ['live', 'admin_only', 'department_only', 'hidden', 'custom'] as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  const { visibility_type, allowed_department, allowed_user_ids } = await req.json()

  if (!VALID_TYPES.includes(visibility_type)) {
    return NextResponse.json({ error: 'Invalid visibility_type' }, { status: 400 })
  }

  const departments = Array.isArray(allowed_department)
    ? allowed_department.filter((d): d is string => typeof d === 'string' && d.length > 0)
    : []

  if (visibility_type === 'department_only' && departments.length === 0) {
    return NextResponse.json({ error: 'Select at least one department' }, { status: 400 })
  }

  // ── Custom members ────────────────────────────────────────────────────────
  // The ids are re-checked against the users table on every save rather than
  // trusted from the form. Two things ride on that: a member who was
  // deactivated or deleted since the picker was opened must not be written back
  // in, and a hand-crafted PATCH must not be able to name an id that is not an
  // active BOE member. Duplicates are collapsed so the stored list is what the
  // admin actually chose.
  let members: string[] = []
  if (visibility_type === 'custom') {
    const requested = Array.isArray(allowed_user_ids)
      ? [...new Set(allowed_user_ids.filter((v): v is string => typeof v === 'string' && UUID.test(v)))]
      : []

    if (requested.length === 0) {
      return NextResponse.json({ error: 'Select at least one member' }, { status: 400 })
    }

    const { data: valid, error: memberErr } = await svc
      .from('users')
      .select('id')
      .in('id', requested)
      .eq('is_active', true)
      .or('is_deleted.eq.false,is_deleted.is.null')

    if (memberErr) return NextResponse.json({ error: memberErr.message }, { status: 500 })

    members = (valid ?? []).map(u => u.id as string)
    if (members.length === 0) {
      return NextResponse.json({ error: 'Select at least one active member' }, { status: 400 })
    }
  }

  const { error } = await svc
    .from('app_modules')
    .update({
      visibility_type,
      allowed_department: visibility_type === 'department_only' ? departments : null,
      // Cleared for every other mode: a member list left behind a mode that
      // ignores it is how a module silently re-grants access the next time
      // someone switches back to Custom.
      allowed_user_ids: visibility_type === 'custom' ? members : null,
      updated_at: new Date().toISOString(),
    })
    .eq('module_key', key)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, allowed_user_ids: visibility_type === 'custom' ? members : null })
}
