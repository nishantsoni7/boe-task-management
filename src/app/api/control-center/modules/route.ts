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
    .from('app_modules')
    .select('id, module_key, module_name, description, route_path, visibility_type, allowed_department, allowed_user_ids, sort_order')
    .order('sort_order')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ modules: data ?? [] })
}
