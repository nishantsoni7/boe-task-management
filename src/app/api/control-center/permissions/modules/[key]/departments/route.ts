import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { isSelfServiceModule } from '@/lib/moduleAccess'
import { parseTeamChanges, stateFromStored, teamRuleAction } from '@/lib/permissions/departmentAccess'

// Team access for ONE module — Control Center › Access › By Module › Team access.
//
// GET  reads, per department, whether a team rule exists for the module's entry
//      action (Allowed / Blocked / Not set) and how many active people are in it.
// PUT  sets those rules. Only the module's ENTRY action (`view` / `use`) is ever
//      written, so this cannot hand a team any other — least of all a protected —
//      permission. "Not set" removes the rule; nothing else is deleted.
//
// Administrators only, checked from the session on every call (same check as the
// sibling routes). The service role is used because department_permissions is
// admin-managed; the caller's identity is never taken from the request body.

async function adminClient(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '').trim()
  if (!token) return null

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: { user } } = await svc.auth.getUser(token)
  if (!user) return null

  // Deactivating or soft-deleting a member does not revoke their session, so role
  // alone is not enough. is_deleted is nullable: only an explicit true rejects.
  const { data: p } = await svc.from('users').select('role, is_active, is_deleted').eq('id', user.id).single()
  if (!p || p.role !== 'admin' || p.is_active !== true || p.is_deleted === true) return null

  return svc
}

type Svc = NonNullable<Awaited<ReturnType<typeof adminClient>>>

async function loadModule(svc: Svc, key: string) {
  const { data: mod, error } = await svc
    .from('permission_modules')
    .select(`id, module_key, display_name, is_active,
      module_permission_actions ( permission_actions ( id, action_key ) )`)
    .eq('module_key', key)
    .maybeSingle()
  if (error) return { error: NextResponse.json({ error: error.message }, { status: 500 }) }
  if (!mod) return { error: NextResponse.json({ error: 'Unknown module' }, { status: 404 }) }
  if (isSelfServiceModule(key)) {
    return { error: NextResponse.json({ error: 'This module is restricted to system administrators and is not granted to teams' }, { status: 400 }) }
  }
  type Row = { permission_actions: { id: string; action_key: string } | { id: string; action_key: string }[] | null }
  const actions = ((mod.module_permission_actions ?? []) as Row[])
    .flatMap(r => (Array.isArray(r.permission_actions) ? r.permission_actions : r.permission_actions ? [r.permission_actions] : []))
  const entryKey = teamRuleAction(actions.map(a => a.action_key))
  const entry = actions.find(a => a.action_key === entryKey)
  if (!entry) {
    return { error: NextResponse.json({ error: 'This module has no single entry permission to grant to a team' }, { status: 400 }) }
  }
  return { module: { id: mod.id as string, key: mod.module_key as string, name: mod.display_name as string, entry } }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const svc = await adminClient(req)
  if (!svc) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { key } = await params

  const loaded = await loadModule(svc, key)
  if ('error' in loaded) return loaded.error
  const { module: mod } = loaded

  const [depts, rules, people] = await Promise.all([
    svc.from('departments').select('id, department_key, department_name, is_active, sort_order').order('sort_order').order('department_name'),
    svc.from('department_permissions').select('department_id, allowed').eq('module_id', mod.id).eq('action_id', mod.entry.id),
    svc.from('users').select('team').eq('is_active', true).or('is_deleted.eq.false,is_deleted.is.null'),
  ])
  const failed = depts.error ?? rules.error ?? people.error
  if (failed) return NextResponse.json({ error: failed.message }, { status: 500 })

  const allowedByDept = new Map((rules.data ?? []).map(r => [r.department_id as string, r.allowed as boolean]))
  const headcount = new Map<string, number>()
  for (const u of people.data ?? []) if (u.team) headcount.set(u.team as string, (headcount.get(u.team as string) ?? 0) + 1)

  return NextResponse.json({
    module: { moduleKey: mod.key, displayName: mod.name, entryAction: mod.entry.action_key },
    departments: (depts.data ?? []).map(d => ({
      departmentKey: d.department_key as string,
      departmentName: d.department_name as string,
      isActive: d.is_active as boolean,
      people: headcount.get(d.department_key as string) ?? 0,
      state: stateFromStored(allowedByDept.get(d.id as string) ?? null),
    })),
  }, { headers: { 'Cache-Control': 'no-store, private' } })
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const svc = await adminClient(req)
  if (!svc) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { key } = await params

  const parsed = parseTeamChanges(await req.json().catch(() => null))
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const loaded = await loadModule(svc, key)
  if ('error' in loaded) return loaded.error
  const { module: mod } = loaded

  const { data: depts, error: deptError } = await svc
    .from('departments').select('id, department_key').in('department_key', parsed.changes.map(c => c.departmentKey))
  if (deptError) return NextResponse.json({ error: deptError.message }, { status: 500 })
  const idByKey = new Map((depts ?? []).map(d => [d.department_key as string, d.id as string]))
  const missing = parsed.changes.find(c => !idByKey.has(c.departmentKey))
  if (missing) return NextResponse.json({ error: `Unknown department: ${missing.departmentKey}` }, { status: 400 })

  const toUpsert = parsed.changes
    .filter(c => c.state !== 'inherit')
    .map(c => ({ department_id: idByKey.get(c.departmentKey)!, module_id: mod.id, action_id: mod.entry.id, allowed: c.state === 'allow' }))
  const toClear = parsed.changes.filter(c => c.state === 'inherit').map(c => idByKey.get(c.departmentKey)!)

  if (toUpsert.length > 0) {
    const { error } = await svc.from('department_permissions').upsert(toUpsert, { onConflict: 'department_id,module_id,action_id' })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (toClear.length > 0) {
    const { error } = await svc.from('department_permissions').delete()
      .eq('module_id', mod.id).eq('action_id', mod.entry.id).in('department_id', toClear)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ success: true, changed: parsed.changes.length })
}
