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

type PermissionActionRef = { action_key: string; display_name: string }

// Lists every registered module with its dynamically-registered actions.
// Source of truth is the DB (permission_modules / module_permission_actions
// / permission_actions), not a hardcoded list — new modules appear here as
// soon as they're synced via scripts/sync-permissions.ts.
export async function GET(req: NextRequest) {
  const svc = await adminClient(req)
  if (!svc) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await svc
    .from('permission_modules')
    .select(`
      id, module_key, display_name, description,
      module_permission_actions (
        default_allowed,
        permission_actions ( action_key, display_name )
      )
    `)
    .eq('is_active', true)
    .order('display_name')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const modules = (data ?? []).map((mod) => ({
    moduleKey: mod.module_key,
    displayName: mod.display_name,
    description: mod.description,
    actions: mod.module_permission_actions
      .map((link) => link.permission_actions as unknown as PermissionActionRef | null)
      .filter((a): a is PermissionActionRef => a !== null)
      .map((a) => ({ actionKey: a.action_key, displayName: a.display_name }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
  }))

  return NextResponse.json({ modules })
}
