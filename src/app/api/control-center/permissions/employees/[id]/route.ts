import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { getEffectivePermissionsForUser } from '@/lib/permissions/resolver'

async function adminClient(req: NextRequest): Promise<{ svc: SupabaseClient; adminId: string } | null> {
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

  return { svc, adminId: user.id }
}

type PermissionActionRef = { action_key: string; display_name: string }

// Human labels for each precedence level, computed once here so the page
// never has to hardcode a source -> label mapping. Adding a new level
// (e.g. a future "permission_profile" source) only requires updating this
// map, not the frontend.
const SOURCE_LABELS: Record<string, string> = {
  system_default: 'System Default',
  role: 'Role',
  department: 'Department',
  employee_override: 'Employee Override',
}
function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source
}

const ACTION_DISPLAY_LABELS: Record<string, string> = {
  manage_quotations: 'Submit Quotation Requests',
}

function actionDisplayLabel(action: PermissionActionRef): string {
  return ACTION_DISPLAY_LABELS[action.action_key] ?? action.display_name
}

// GET — UI-ready permission tree for one employee: identity + every active
// module's actions, each carrying its effective (allowed, source). One
// resolver round trip via getEffectivePermissionsForUser, merged here with
// the module/action registry — the page renders this directly.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await adminClient(req)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { svc } = auth

  const { id: userId } = await params

  const { data: employee, error: employeeError } = await svc
    .from('users')
    .select('id, full_name, role, team')
    .eq('id', userId)
    .single()

  if (employeeError || !employee) {
    return NextResponse.json({ error: 'Employee not found' }, { status: 404 })
  }

  let departmentName: string | null = null
  if (employee.team) {
    const { data: dept } = await svc
      .from('departments')
      .select('department_name')
      .eq('department_key', employee.team)
      .single()
    departmentName = dept?.department_name ?? null
  }

  const { data: moduleRows, error: modulesError } = await svc
    .from('permission_modules')
    .select(`
      id, module_key, display_name,
      module_permission_actions (
        default_allowed,
        permission_actions ( action_key, display_name )
      )
    `)
    .eq('is_active', true)
    .order('display_name')

  if (modulesError) return NextResponse.json({ error: modulesError.message }, { status: 500 })

  const effectiveByModule = await getEffectivePermissionsForUser(svc, userId)

  const modules = (moduleRows ?? []).map((mod) => {
    const effective = effectiveByModule.get(mod.module_key) ?? []
    const effectiveByAction = new Map(effective.map((e) => [e.actionKey, e]))

    return {
      moduleKey: mod.module_key,
      displayName: mod.display_name,
      actions: mod.module_permission_actions
        .map((link) => ({
          action: link.permission_actions as unknown as PermissionActionRef | null,
          defaultAllowed: link.default_allowed,
        }))
        .filter((link): link is { action: PermissionActionRef; defaultAllowed: boolean } => link.action !== null)
        .map(({ action, defaultAllowed }) => {
          const resolved = effectiveByAction.get(action.action_key)
          const source = resolved?.source ?? 'system_default'
          return {
            actionKey: action.action_key,
            displayName: actionDisplayLabel(action),
            allowed: resolved?.allowed ?? defaultAllowed,
            source,
            sourceLabel: sourceLabel(source),
          }
        })
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    }
  })

  return NextResponse.json({
    employee: {
      id: employee.id,
      name: employee.full_name,
      role: employee.role,
      department: departmentName,
    },
    modules,
  })
}

type Change = { moduleKey: string; actionKey: string; allowed: boolean | null }

// PUT — writes only the employee-override rows that actually changed.
// allowed: true/false sets (upserts) an override; allowed: null reverts to
// inherited by soft-revoking any existing active override. Inherited
// (role/department/system default) rows are never touched.
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await adminClient(req)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { svc, adminId } = auth

  const { id: userId } = await params
  const body = await req.json()
  const changes = Array.isArray(body?.changes) ? (body.changes as Change[]) : []

  if (changes.length === 0) {
    return NextResponse.json({ error: 'No changes provided' }, { status: 400 })
  }

  const moduleKeys = Array.from(new Set(changes.map((c) => c.moduleKey)))
  const actionKeys = Array.from(new Set(changes.map((c) => c.actionKey)))

  const [{ data: modules, error: modulesError }, { data: actions, error: actionsError }] = await Promise.all([
    svc.from('permission_modules').select('id, module_key').in('module_key', moduleKeys),
    svc.from('permission_actions').select('id, action_key').in('action_key', actionKeys),
  ])
  if (modulesError) return NextResponse.json({ error: modulesError.message }, { status: 500 })
  if (actionsError) return NextResponse.json({ error: actionsError.message }, { status: 500 })

  const moduleIdByKey = new Map((modules ?? []).map((m) => [m.module_key, m.id]))
  const actionIdByKey = new Map((actions ?? []).map((a) => [a.action_key, a.id]))

  const toUpsert: { user_id: string; module_id: string; action_id: string; allowed: boolean; granted_by: string; granted_at: string; revoked_by: null; revoked_at: null }[] = []
  const toRevoke: { moduleId: string; actionId: string }[] = []

  for (const change of changes) {
    const moduleId = moduleIdByKey.get(change.moduleKey)
    const actionId = actionIdByKey.get(change.actionKey)
    if (!moduleId || !actionId) {
      return NextResponse.json(
        { error: `Unknown module/action: ${change.moduleKey}/${change.actionKey}` },
        { status: 400 },
      )
    }

    if (change.allowed === null) {
      toRevoke.push({ moduleId, actionId })
    } else {
      toUpsert.push({
        user_id: userId,
        module_id: moduleId,
        action_id: actionId,
        allowed: change.allowed,
        granted_by: adminId,
        granted_at: new Date().toISOString(),
        revoked_by: null,
        revoked_at: null,
      })
    }
  }

  if (toUpsert.length > 0) {
    const { error } = await svc
      .from('employee_permission_overrides')
      .upsert(toUpsert, { onConflict: 'user_id,module_id,action_id' })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  for (const { moduleId, actionId } of toRevoke) {
    const { error } = await svc
      .from('employee_permission_overrides')
      .update({ revoked_by: adminId, revoked_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('module_id', moduleId)
      .eq('action_id', actionId)
      .is('revoked_at', null)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
