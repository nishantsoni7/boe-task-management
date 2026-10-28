import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { getEffectivePermissionsForUser } from '@/lib/permissions/resolver'

// GET — the read-only access matrix for EVERY active module: every non-deleted
// employee with the resolver's answer for each registered action, plus who
// set each override and when.
//
// This is what Control Center › Access › Modules and › Authorities read: one
// request for the whole hub, cached by React Query for the stale window and
// refetched after a save. It decides nothing and writes nothing — the level
// and the authority chips shown per row are derived on the client by the
// shared catalogue (src/lib/permissions/accessCatalog.ts), and every change
// is saved through the existing per-employee PUT
// (/api/control-center/permissions/employees/[id]), so the three Access
// screens can never store different things for the same intention.
//
// It supersedes the per-module matrix route
// (/modules/[key]/employees): same directory, same resolver, same batching,
// one fetch instead of one per module.
//
// One admin check, one module read, one users read, one overrides read, then
// the existing bulk resolver RPC once per employee in small batches. No new SQL.

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

type PermissionActionRef = { id: string; action_key: string; display_name: string }

/** Resolver calls in flight at once. The RPC is cheap; this only bounds the burst. */
const RESOLVE_BATCH = 8

export type MatrixAction = {
  actionKey: string
  allowed: boolean
  source: string
  /** Set only when the effective value comes from an active employee override. */
  grantedBy: { id: string; name: string | null } | null
  grantedAt: string | null
}

export async function GET(req: NextRequest) {
  const svc = await adminClient(req)
  if (!svc) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: moduleRows, error: moduleError } = await svc
    .from('permission_modules')
    .select(`
      id, module_key, display_name, description,
      module_permission_actions (
        default_allowed,
        permission_actions ( id, action_key, display_name )
      )
    `)
    .eq('is_active', true)
    .order('display_name')

  if (moduleError) return NextResponse.json({ error: moduleError.message }, { status: 500 })

  const modules = (moduleRows ?? []).map((mod) => ({
    id: mod.id as string,
    moduleKey: mod.module_key as string,
    displayName: mod.display_name as string,
    description: (mod.description as string | null) ?? null,
    actions: mod.module_permission_actions
      .map((link) => ({
        action: link.permission_actions as unknown as PermissionActionRef | null,
        defaultAllowed: link.default_allowed as boolean,
      }))
      .filter((link): link is { action: PermissionActionRef; defaultAllowed: boolean } => link.action !== null)
      .map(({ action, defaultAllowed }) => ({
        id: action.id,
        actionKey: action.action_key,
        displayName: action.display_name,
        defaultAllowed,
      })),
  }))

  // The same directory By Employee shows: soft-deleted accounts excluded at
  // the source, and nothing else — an inactive account still holds grants an
  // administrator must be able to see.
  const { data: users, error: usersError } = await svc
    .from('users')
    .select('id, full_name, role, team, is_active')
    .or('is_deleted.eq.false,is_deleted.is.null')
    .order('full_name')

  if (usersError) return NextResponse.json({ error: usersError.message }, { status: 500 })

  // Every active override in one read, so "Set by" needs no round trip per row.
  const { data: overrideRows, error: overridesError } = await svc
    .from('employee_permission_overrides')
    .select('user_id, module_id, action_id, granted_by, granted_at')
    .is('revoked_at', null)
  if (overridesError) return NextResponse.json({ error: overridesError.message }, { status: 500 })

  const overrideByKey = new Map(
    (overrideRows ?? []).map((row) => [`${row.user_id}:${row.module_id}:${row.action_id}`, row]),
  )
  const granterIds = Array.from(new Set((overrideRows ?? []).map((r) => r.granted_by).filter((id): id is string => !!id)))
  const granterName = new Map<string, string>()
  if (granterIds.length > 0) {
    const { data: granters } = await svc.from('users').select('id, full_name').in('id', granterIds)
    for (const g of granters ?? []) granterName.set(g.id, g.full_name)
  }

  const employees: {
    id: string
    name: string
    role: string
    team: string | null
    is_active: boolean
    modules: Record<string, MatrixAction[]>
  }[] = []

  const rows = users ?? []
  for (let i = 0; i < rows.length; i += RESOLVE_BATCH) {
    const slice = rows.slice(i, i + RESOLVE_BATCH)
    const resolved = await Promise.all(slice.map((u) => getEffectivePermissionsForUser(svc, u.id)))
    slice.forEach((u, j) => {
      const byModule = resolved[j]
      const perModule: Record<string, MatrixAction[]> = {}
      for (const mod of modules) {
        const byAction = new Map((byModule.get(mod.moduleKey) ?? []).map((e) => [e.actionKey, e]))
        perModule[mod.moduleKey] = mod.actions.map((a) => {
          const r = byAction.get(a.actionKey)
          const source = r?.source ?? 'system_default'
          const override = source === 'employee_override' ? overrideByKey.get(`${u.id}:${mod.id}:${a.id}`) : undefined
          return {
            actionKey: a.actionKey,
            allowed: r?.allowed ?? a.defaultAllowed,
            source,
            grantedBy: override?.granted_by
              ? { id: override.granted_by, name: granterName.get(override.granted_by) ?? null }
              : null,
            grantedAt: override?.granted_at ?? null,
          }
        })
      }
      employees.push({
        id: u.id,
        name: u.full_name,
        role: u.role,
        team: u.team,
        is_active: u.is_active === true,
        modules: perModule,
      })
    })
  }

  return NextResponse.json({
    modules: modules.map(({ moduleKey, displayName, description, actions }) => ({
      moduleKey,
      displayName,
      description,
      actions: actions.map(({ actionKey, displayName: actionName }) => ({ actionKey, displayName: actionName })),
    })),
    employees,
  })
}
