import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { getEffectivePermissionsForUser } from '@/lib/permissions/resolver'

// GET — the read-only access matrix for ONE module: every non-deleted employee
// with the resolver's answer for each of the module's actions.
//
// This is what the Control Center's By Module view reads. It decides nothing
// and writes nothing: the level shown per row is derived on the client from
// these rows by the same shared helpers By Employee uses, and any change an
// administrator makes there is saved through the existing per-employee PUT
// (/api/control-center/permissions/employees/[id]), so the two views can never
// store different things for the same intention.
//
// One admin check, one module read, one users read, then the existing bulk
// resolver RPC once per employee in small batches. No new SQL.

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

type PermissionActionRef = { action_key: string; display_name: string }

/** Resolver calls in flight at once. The RPC is cheap; this only bounds the burst. */
const RESOLVE_BATCH = 8

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const svc = await adminClient(req)
  if (!svc) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { key } = await params

  const { data: mod, error: moduleError } = await svc
    .from('permission_modules')
    .select(`
      id, module_key, display_name, is_active,
      module_permission_actions (
        default_allowed,
        permission_actions ( action_key, display_name )
      )
    `)
    .eq('module_key', key)
    .maybeSingle()

  if (moduleError) return NextResponse.json({ error: moduleError.message }, { status: 500 })
  if (!mod || !mod.is_active) return NextResponse.json({ error: 'Module not found' }, { status: 404 })

  const actions = mod.module_permission_actions
    .map((link) => ({
      action: link.permission_actions as unknown as PermissionActionRef | null,
      defaultAllowed: link.default_allowed as boolean,
    }))
    .filter((link): link is { action: PermissionActionRef; defaultAllowed: boolean } => link.action !== null)
    .map(({ action, defaultAllowed }) => ({
      actionKey: action.action_key,
      displayName: action.display_name,
      defaultAllowed,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName))

  // The same directory By Employee shows: soft-deleted accounts excluded at
  // the source, and nothing else — an inactive account still holds grants an
  // administrator must be able to see.
  const { data: users, error: usersError } = await svc
    .from('users')
    .select('id, full_name, email, role, team, is_active')
    .or('is_deleted.eq.false,is_deleted.is.null')
    .order('full_name')

  if (usersError) return NextResponse.json({ error: usersError.message }, { status: 500 })

  const employees: {
    id: string
    name: string
    email: string
    role: string
    team: string | null
    is_active: boolean
    actions: { actionKey: string; allowed: boolean; source: string }[]
  }[] = []

  const rows = users ?? []
  for (let i = 0; i < rows.length; i += RESOLVE_BATCH) {
    const slice = rows.slice(i, i + RESOLVE_BATCH)
    const resolved = await Promise.all(
      slice.map((u) => getEffectivePermissionsForUser(svc, u.id).then((byModule) => byModule.get(key) ?? [])),
    )
    slice.forEach((u, j) => {
      const byAction = new Map(resolved[j].map((e) => [e.actionKey, e]))
      employees.push({
        id: u.id,
        name: u.full_name,
        email: u.email,
        role: u.role,
        team: u.team,
        is_active: u.is_active === true,
        actions: actions.map((a) => {
          const r = byAction.get(a.actionKey)
          return {
            actionKey: a.actionKey,
            allowed: r?.allowed ?? a.defaultAllowed,
            source: r?.source ?? 'system_default',
          }
        }),
      })
    })
  }

  return NextResponse.json({
    module: {
      moduleKey: mod.module_key,
      displayName: mod.display_name,
      actions: actions.map(({ actionKey, displayName }) => ({ actionKey, displayName })),
    },
    employees,
  })
}
