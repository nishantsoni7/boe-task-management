'use client'

import { Suspense, useEffect, useState, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { MAIN_PATH, resolveControlCenterTab, type ControlCenterTab } from '@/lib/controlCenter/navModel'
import { ControlCenterSkeleton } from '@/components/layout/ControlCenterSkeleton'
import { cc, CcSection, CcTable, CcBadge, CcDialog, CcField } from '@/components/controlCenter/CcPrimitives'
import { isSelfServiceModule } from '@/lib/moduleAccess'
import {
  useAdminMembers, useDepartments, useAppModules, useControlCenterCache,
  NO_MEMBERS, NO_DEPARTMENTS, NO_APP_MODULES,
  type ControlCenterAppModule,
} from '@/hooks/queries/useControlCenterData'
import { ModuleMemberPicker } from './ModuleMemberPicker'
import { HomeDirectory } from '@/components/controlCenter/HomeDirectory'

// ── Local types ───────────────────────────────────────────────────────────────

/**
 * What a member of a self-service module gets to look at, in the admin's own
 * words. Keyed the same way as SELF_SERVICE_MODULE_KEYS so the copy cannot
 * describe a module the rule does not cover.
 */
function selfServiceNoun(moduleKey: string): string {
  return moduleKey === 'payroll' ? 'payroll' : 'attendance'
}

// The row shapes come with the shared queries; the local names are kept so
// nothing below has to change to read them.
type AppModule      = ControlCenterAppModule
type VisibilityType = AppModule['visibility_type']


// ── Module Visibility badge (hidden tab, kept for rollback) ──────────────────

const VIS_META: Record<VisibilityType, { label: string; tone: 'green' | 'blue' | 'amber' | 'violet' | 'gray' }> = {
  live:            { label: 'Live',       tone: 'green' },
  admin_only:      { label: 'Admin Only', tone: 'blue' },
  department_only: { label: 'Dept Only',  tone: 'amber' },
  custom:          { label: 'Custom',     tone: 'violet' },
  hidden:          { label: 'Hidden',     tone: 'gray' },
}

/**
 * The "Allowed" cell — who a module is currently open to, in one line.
 *
 * Departments are named because there are only ever a handful. Members are
 * counted rather than listed ("Custom · 3 members"), with the names on hover:
 * a row that grows a name per person stops being a table.
 */
function moduleAllowedSummary(
  mod: AppModule,
  deptLabel: (key: string) => string,
  memberLabel: (id: string) => string,
): React.ReactNode {
  if (mod.visibility_type === 'department_only') {
    return mod.allowed_department?.length
      ? mod.allowed_department.map(deptLabel).join(', ')
      : <span className={cc.faint}>—</span>
  }
  if (mod.visibility_type === 'custom') {
    const ids = mod.allowed_user_ids ?? []
    if (ids.length === 0) return <span style={{ color: '#B42332' }}>Custom · no members</span>
    return (
      <span title={ids.map(memberLabel).join(', ')} style={{ cursor: 'help' }}>
        Custom · {ids.length} member{ids.length === 1 ? '' : 's'}
      </span>
    )
  }
  return <span className={cc.faint}>—</span>
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ControlCenterPage() {
  return (
    <Suspense fallback={<ControlCenterSkeleton />}>
      <ControlCenterPageInner />
    </Suspense>
  )
}

function ControlCenterPageInner() {
  const supabase = useMemo(() => createClient(), [])

  const [token,    setToken]    = useState('')

  // Shared with Access Control (and cached across sections): see
  // src/hooks/queries/useControlCenterData.ts. The setters patch the cache
  // with the same updaters that used to patch local state.
  const membersQuery = useAdminMembers()
  const deptsQuery   = useDepartments()
  const modulesQuery = useAppModules()
  const { setModules } = useControlCenterCache()
  const members = membersQuery.data ?? NO_MEMBERS
  const depts   = deptsQuery.data   ?? NO_DEPARTMENTS
  const modules = modulesQuery.data ?? NO_APP_MODULES
  const loading = membersQuery.isPending || deptsQuery.isPending || modulesQuery.isPending

  // ── Active tab — the URL (?tab=) is the single source of truth, read
  // reactively via useSearchParams so cross-page navigation lands on the right
  // section on the first render.
  const searchParams = useSearchParams()
  const router = useRouter()
  const tab: ControlCenterTab = resolveControlCenterTab(searchParams.get('tab'))

  // ── Module edit modal ────────────────────────────────────────────────────
  const [editMod,        setEditMod]        = useState<AppModule | null>(null)
  const [modVisType,     setModVisType]     = useState<VisibilityType>('live')
  const [modAllowedDepts,setModAllowedDepts]= useState<string[]>([])
  const [modAllowedUsers,setModAllowedUsers]= useState<string[]>([])
  const [modSaving,      setModSaving]      = useState(false)
  const [modError,       setModError]       = useState('')

  // ── Init ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const init = async () => {
      // Identity and the admin check are owned by control-center/layout.tsx,
      // which renders this page only for an admitted administrator. The stored
      // session is read here solely for the bearer token the save handlers
      // below need; the lists themselves come from the shared queries above.
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      setToken(session.access_token)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ?tab=people was where the read-only employee table lived. Employee
  // administration is now one screen at /people — the list AND every operation
  // on a person, which used to be split across this tab and a separate Employee
  // Records page. The tab keeps resolving so an old bookmark still lands
  // somewhere useful; it just lands on the real screen.
  useEffect(() => {
    if (tab === 'people') router.replace(`${MAIN_PATH}/people`)
  }, [tab, router])

  // ── Helpers ───────────────────────────────────────────────────────────────

  const activeDepts = depts.filter(d => d.is_active)

  function openEditMod(mod: AppModule) {
    setEditMod(mod)
    setModVisType(mod.visibility_type)
    setModAllowedDepts(mod.allowed_department ?? [])
    setModAllowedUsers(mod.allowed_user_ids ?? [])
    setModError('')
  }

  function toggleModAllowedUser(userId: string) {
    setModAllowedUsers(prev =>
      prev.includes(userId) ? prev.filter(u => u !== userId) : [...prev, userId]
    )
  }

  function toggleModAllowedDept(deptKey: string) {
    setModAllowedDepts(prev =>
      prev.includes(deptKey) ? prev.filter(d => d !== deptKey) : [...prev, deptKey]
    )
  }

  // ── Save handlers ──────────────────────────────────────────────────────────

  async function saveModule() {
    if (!editMod) return
    if (modVisType === 'department_only' && modAllowedDepts.length === 0) {
      setModError('Select at least one department.'); return
    }
    // Fails closed for the same reason the route and the resolver do: a Custom
    // module with nobody in it must be an explicit "hidden", not an accident
    // that reads as "everyone".
    if (modVisType === 'custom' && modAllowedUsers.length === 0) {
      setModError('Select at least one member.'); return
    }
    setModSaving(true); setModError('')
    try {
      const res = await fetch(`/api/control-center/modules/${editMod.module_key}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          visibility_type: modVisType,
          allowed_department: modVisType === 'department_only' ? modAllowedDepts : null,
          allowed_user_ids:  modVisType === 'custom' ? modAllowedUsers : null,
        }),
      })
      const json = await res.json()
      if (!res.ok) { setModError(json.error ?? 'Save failed'); return }

      // The server re-validates the member list against active users, so the
      // row reflects what it stored rather than what the form sent.
      const savedUsers: string[] | null = modVisType === 'custom'
        ? (Array.isArray(json.allowed_user_ids) ? json.allowed_user_ids : modAllowedUsers)
        : null

      setModules(prev => prev.map(m =>
        m.module_key === editMod.module_key
          ? {
              ...m,
              visibility_type: modVisType,
              allowed_department: modVisType === 'department_only' ? modAllowedDepts : null,
              allowed_user_ids: savedUsers,
            }
          : m
      ))
      setEditMod(null)
    } finally {
      setModSaving(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) return <ControlCenterSkeleton />

  const deptLabel = (key: string | null | undefined) => {
    if (!key) return '—'
    return depts.find(d => d.department_key === key)?.department_name ?? key
  }

  // A member id that no longer resolves is a member who was deactivated or
  // deleted after being selected. The resolver already ignores them (a dangling
  // uuid matches nobody), and the next save drops them; until then the cell says
  // so rather than printing a raw uuid.
  const memberLabel = (id: string) => {
    const m = members.find(u => u.id === id)
    return m?.full_name ?? m?.email ?? 'Removed member'
  }

  // Active, non-deleted people only — Custom grants module access, and a
  // deactivated account must not be handed one.
  const pickableMembers = members
    .filter(m => !m.is_deleted && m.is_active)
    .map(m => ({ id: m.id, full_name: m.full_name, email: m.email, team: m.team }))
    .sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? ''))

  // members is already loaded pre-filtered to non-deleted users (see
  // /api/admin-members), so this is exactly "people currently assigned to
  // this department" — the same set that blocks a department delete.
  const peopleInDept = (key: string) =>
    members.filter(m => m.team === key).length

  return (
    <>
      {/* ── Overview ─────────────────────────────────────────────────────── */}
      {tab === 'overview' && (
        <HomeDirectory members={members} depts={depts} modules={modules} peopleInDept={peopleInDept} />
      )}

      {/* ── Module Visibility (hidden; ?tab=modules, kept for rollback) ──── */}
      {tab === 'modules' && (
        <CcSection>
          <CcTable>
            <thead>
              <tr>
                <th>Module</th>
                <th>Visibility</th>
                <th>Allowed</th>
                <th>Route</th>
                <th className={cc.right}></th>
              </tr>
            </thead>
            <tbody>
              {modules.map(mod => (
                <tr key={mod.module_key}>
                  <td style={{ fontWeight: 600 }}>{mod.module_name}</td>
                  <td><CcBadge tone={(VIS_META[mod.visibility_type] ?? VIS_META.live).tone}>{(VIS_META[mod.visibility_type] ?? VIS_META.live).label}</CcBadge></td>
                  <td>{moduleAllowedSummary(mod, deptLabel, memberLabel)}</td>
                  <td className={cc.mono}>{mod.route_path}</td>
                  <td className={cc.right}>
                    <button className={cc.linkBtn} onClick={() => openEditMod(mod)}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </CcTable>
        </CcSection>
      )}

      {/* ── Module edit dialog ────────────────────────────────────────────── */}
      {editMod && (
        <CcDialog
          title={editMod.module_name}
          subtitle="Who sees this module in the launcher"
          onClose={() => setEditMod(null)}
          footer={
            <>
              <button className="boe-btn boe-btn-ghost" onClick={() => setEditMod(null)}>Cancel</button>
              <button className="boe-btn boe-btn-primary" onClick={saveModule} disabled={modSaving}>
                {modSaving ? 'Saving…' : 'Save'}
              </button>
            </>
          }
        >
          <CcField label="Visibility">
            <select
              className={cc.fieldControl}
              value={modVisType}
              onChange={e => setModVisType(e.target.value as VisibilityType)}
            >
              <option value="live">Live — visible to everyone</option>
              <option value="admin_only">Admin Only</option>
              <option value="department_only">Department Only</option>
              <option value="custom">Custom — chosen members</option>
              <option value="hidden">Hidden — not shown in launcher</option>
            </select>
          </CcField>

          {/* Attendance and Payroll are two surfaces under one name: the
              management module, which reads the whole company and is admins
              only, and the employee's own record. This setting governs the
              second one. See SELF_SERVICE_MODULE_KEYS in src/lib/moduleAccess.ts. */}
          {isSelfServiceModule(editMod.module_key) && (
            <div className={cc.note} style={{ marginBottom: 14 }}>
              This controls who can see{' '}
              <strong>their own {selfServiceNoun(editMod.module_key)}</strong>. Managing{' '}
              {editMod.module_name}{' '}for the whole company — everyone&rsquo;s records,
              and every administrative action — stays with admins and cannot be granted here.
            </div>
          )}

          {modVisType === 'custom' && isSelfServiceModule(editMod.module_key) && (
            <div className={cc.muted} style={{ fontSize: 12, marginBottom: 10 }}>
              Selected members can view their own {selfServiceNoun(editMod.module_key)}.
            </div>
          )}

          {modVisType === 'custom' && (
            <ModuleMemberPicker
              members={pickableMembers}
              selectedIds={modAllowedUsers}
              onToggle={toggleModAllowedUser}
              onRemove={id => setModAllowedUsers(prev => prev.filter(u => u !== id))}
            />
          )}

          {modVisType === 'department_only' && (
            <CcField
              label="Allowed departments"
              hint={modAllowedDepts.length > 0
                ? `Selected: ${modAllowedDepts.map(deptLabel).join(', ')}`
                : 'No departments selected — the module will be hidden from all non-admins.'}
            >
              <div className={cc.pickerBox}>
                {activeDepts.length === 0 ? (
                  <div className={cc.muted} style={{ fontSize: 12.5 }}>No active departments.</div>
                ) : (
                  activeDepts.map(d => (
                    <label key={d.department_key} className={cc.check} style={{ padding: '4px 0' }}>
                      <input
                        type="checkbox"
                        checked={modAllowedDepts.includes(d.department_key)}
                        onChange={() => toggleModAllowedDept(d.department_key)}
                      />
                      {d.department_name}
                    </label>
                  ))
                )}
              </div>
            </CcField>
          )}

          {modError && <div className={cc.error}>{modError}</div>}
        </CcDialog>
      )}

    </>
  )
}
