'use client'

import { Suspense, useEffect, useState, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Search, Users, ShieldCheck, Settings2, ArrowUpRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { resolveControlCenterTab, type ControlCenterTab } from '@/components/layout/ControlCenterLayout'
import { ControlCenterSkeleton } from '@/components/layout/ControlCenterSkeleton'
import { Avatar } from '@/components/ui/atoms'
import {
  cc, CcSection, CcToolbar, CcTable, CcBadge, ActiveBadge, CcEmpty, CcDialog, CcField,
} from '@/components/controlCenter/CcPrimitives'
import { orderNumberErrorMessage, parseOrderNumberInput, formatOrderNumber } from '@/lib/orderNumbering'
import { isSelfServiceModule } from '@/lib/moduleAccess'
import { MODULE_ENFORCEMENT, moduleEnforcement, ENFORCEMENT_BADGE_LABEL } from '@/lib/permissions/enforcement'
import { ENGINE_GATED_MODULE_KEYS } from '@/lib/permissions/moduleVisibility'
import {
  useAdminMembers, useDepartments, useAppModules, useControlCenterCache,
  NO_MEMBERS, NO_DEPARTMENTS, NO_APP_MODULES,
  type ControlCenterAppModule, type ControlCenterDepartment,
} from '@/hooks/queries/useControlCenterData'
import { ModuleMemberPicker } from './ModuleMemberPicker'

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
type Department     = ControlCenterDepartment
type VisibilityType = AppModule['visibility_type']

const MAIN_PATH = '/admin/control-center'

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
    if (ids.length === 0) return <span style={{ color: '#D94F4F' }}>Custom · no members</span>
    return (
      <span title={ids.map(memberLabel).join(', ')} style={{ cursor: 'help' }}>
        Custom · {ids.length} member{ids.length === 1 ? '' : 's'}
      </span>
    )
  }
  return <span className={cc.faint}>—</span>
}

// ── Confirmed Order Number Cycle ─────────────────────────────────────────────
//
// The admin control for the next Confirmed Order number (migrations
// 20260703000000 and 20260704000000). It has its own sidebar entry under
// SYSTEM: a control an admin cannot find is a control that does not exist.
//
// Both values come from get_confirmed_order_number_cycle() rather than from the
// table: order_number_cycle has RLS enabled with no policies, so it is not
// client-readable at all. That RPC is admin-gated in the database, which means
// nothing on this page is what stands between a non-admin and the data.
//
// Client-side validation (parseOrderNumberInput) is a convenience that saves a
// round trip on an obvious typo. Every rule it applies is independently enforced
// by set_next_confirmed_order_number(), and when the two disagree the database
// wins and its message is what gets shown.

type OrderNumberCycle = {
  next_number: number | null
  next_number_display: string | null
  highest_existing_number: number
  highest_existing_display: string | null
  configured: boolean
  exhausted: boolean
}

function OrderNumberCycleTab() {
  const supabase = useMemo(() => createClient(), [])

  const [cycle,    setCycle]    = useState<OrderNumberCycle | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [loadErr,  setLoadErr]  = useState('')
  const [input,    setInput]    = useState('')
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState('')
  const [saved,    setSaved]    = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadErr('')
    const { data, error: rpcErr } = await supabase.rpc('get_confirmed_order_number_cycle')
    if (rpcErr) {
      // The card must survive this. Losing the whole section on a failed read
      // would put the admin back where they started: unable to find the control.
      setLoadErr(orderNumberErrorMessage(rpcErr.message, 'admin') ?? rpcErr.message)
      setCycle(null)
      setLoading(false)
      return
    }
    const res = data as OrderNumberCycle | null
    setCycle(res)
    setInput(res?.next_number != null ? String(res.next_number) : '')
    setLoading(false)
  }, [supabase])

  // A FETCH IS STARTED HERE. `load` raises the loading flag before its await,
  // and on mount that flag is already true, so React bails out of the update.
  useEffect(() => {
    const startFetch = () => { void load() }
    startFetch()
  }, [load])

  const parsed  = parseOrderNumberInput(input)
  const preview = parsed.ok ? formatOrderNumber(parsed.value) : null

  // Save is disabled when nothing changed. Compared numerically, so retyping
  // '0020' over a stored 20 correctly counts as unchanged.
  const unchanged = parsed.ok && cycle?.next_number != null && parsed.value === cycle.next_number
  const canSave   = !saving && !loading && parsed.ok && !unchanged

  const save = async () => {
    setError('')
    setSaved('')
    if (!parsed.ok) { setError(parsed.error); return }

    setSaving(true)
    const { error: rpcErr } = await supabase.rpc('set_next_confirmed_order_number', {
      p_next_number: parsed.value,
    })
    setSaving(false)

    if (rpcErr) {
      // The database is authoritative. Show what it actually said, in plain
      // language where there is a mapping, and never a generic fallback that
      // hides which rule was broken.
      setError(orderNumberErrorMessage(rpcErr.message, 'admin') ?? rpcErr.message)
      return
    }

    setSaved(`The next Confirmed Order will be ${formatOrderNumber(parsed.value)}.`)
    await load()
  }

  if (loading) return <div className={cc.muted} style={{ fontSize: 12.5 }}>Loading…</div>

  if (loadErr) {
    return (
      <CcSection>
        <div className={cc.error} style={{ marginTop: 0, marginBottom: 12 }}>{loadErr}</div>
        <button className="boe-btn boe-btn-ghost" onClick={() => void load()}>Retry</button>
      </CcSection>
    )
  }

  return (
    <>
      <div className={cc.stats} style={{ maxWidth: 520 }}>
        <div className={cc.stat}>
          <div className={cc.statValue}>{cycle?.highest_existing_display ?? '—'}</div>
          <div className={cc.statLabel}>Highest existing Order</div>
        </div>
        <div className={cc.stat}>
          <div className={cc.statValue}>
            {cycle?.next_number_display ?? (cycle?.exhausted ? 'Exhausted' : 'Not set')}
          </div>
          <div className={cc.statLabel}>Next Confirmed Order</div>
        </div>
      </div>

      <CcSection title="Set the next number" description="Order Request numbers (ORD-REQ-…) are a separate scheme and are not affected.">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className={cc.control}
            style={{ width: 130 }}
            value={input}
            onChange={e => { setInput(e.target.value); setError(''); setSaved('') }}
            onKeyDown={e => { if (e.key === 'Enter' && canSave) void save() }}
            inputMode="numeric"
            placeholder="e.g. 25"
            aria-label="Next Confirmed Order number"
          />
          {/* The live four-digit preview: it is what the admin is actually
              choosing, so it is shown at the moment of choosing rather than
              only after a save. */}
          <div className={cc.muted} style={{ fontSize: 12.5 }}>
            {preview
              ? <>will be saved as <strong style={{ color: '#111318', fontSize: 15 }}>{preview}</strong></>
              : input.trim() ? <span style={{ color: '#D94F4F' }}>{parsed.ok ? '' : parsed.error}</span> : null}
          </div>
          <button className="boe-btn boe-btn-primary" onClick={save} disabled={!canSave}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>

        {error && <div className={cc.error}>{error}</div>}
        {saved && <div className={cc.success} style={{ marginTop: 10 }}>{saved}</div>}

        <div className={cc.note} style={{ marginTop: 18 }}>
          This changes the number assigned to the next future Confirmed Order.
          Existing Orders are not renumbered.
          <br />
          Order numbers are always four digits, 0001 to 9999, and the next number must be
          higher than the highest Order that already exists.
        </div>
      </CcSection>
    </>
  )
}

// ── Overview ─────────────────────────────────────────────────────────────────
//
// A landing surface, not a dashboard: what can be managed here, where to go,
// and whether anything in the configuration that is already loaded looks
// wrong. Every number and every attention row is derived from the three
// cached lists and the enforcement table in code — nothing is fetched for it.

type EnforcementSummary = {
  enforced: string[]
  partial: string[]
  prepared: string[]
}

/**
 * Which modules the permission engine actually decides, per module, from the
 * one source that answers that question (src/lib/permissions/enforcement.ts).
 * Attendance and Payroll are admin-only by product decision and are not
 * counted — there is no grant to enforce.
 */
function summarizeEnforcement(): EnforcementSummary {
  const keys = new Set<string>([...ENGINE_GATED_MODULE_KEYS, ...Object.keys(MODULE_ENFORCEMENT)])
  const out: EnforcementSummary = { enforced: [], partial: [], prepared: [] }
  for (const key of keys) {
    if (isSelfServiceModule(key)) continue
    const state = moduleEnforcement(key).state
    if (state === 'enforced') out.enforced.push(key)
    else if (state === 'partial') out.partial.push(key)
    else if (state === 'prepared') out.prepared.push(key)
  }
  return out
}

function titleCase(key: string): string {
  return key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

function OverviewTab({
  members, depts, modules, peopleInDept,
}: {
  members: UserProfile[]
  depts: Department[]
  modules: AppModule[]
  peopleInDept: (key: string) => number
}) {
  const live = members.filter(m => !m.is_deleted)
  const activeMembers = live.filter(m => m.is_active)
  const activeDepts = depts.filter(d => d.is_active)
  const launcherModules = modules.filter(m => m.visibility_type !== 'hidden')
  const enforcement = summarizeEnforcement()
  const enforcementTotal = enforcement.enforced.length + enforcement.partial.length + enforcement.prepared.length

  const moduleName = (key: string) => modules.find(m => m.module_key === key)?.module_name ?? titleCase(key)

  // Attention rows — real conditions in loaded data, nothing predicted.
  const knownDept = new Set(depts.map(d => d.department_key))
  const withoutDepartment = activeMembers.filter(m => !m.team || !knownDept.has(m.team))
  const inactiveWithPeople = depts.filter(d => !d.is_active && peopleInDept(d.department_key) > 0)
  const customEmpty = modules.filter(m => m.visibility_type === 'custom' && (m.allowed_user_ids?.length ?? 0) === 0)
  const notEnforced = [...enforcement.partial, ...enforcement.prepared]

  const attention: { key: string; text: React.ReactNode; href: string; action: string }[] = []
  if (withoutDepartment.length > 0) {
    attention.push({
      key: 'no-dept',
      text: <>{withoutDepartment.length} active {withoutDepartment.length === 1 ? 'employee has' : 'employees have'} no department.</>,
      href: `${MAIN_PATH}?tab=people`, action: 'Review employees',
    })
  }
  for (const d of inactiveWithPeople) {
    attention.push({
      key: `inactive-${d.department_key}`,
      text: <><strong>{d.department_name}</strong> is inactive but still has {peopleInDept(d.department_key)} {peopleInDept(d.department_key) === 1 ? 'person' : 'people'} assigned.</>,
      href: `${MAIN_PATH}?tab=departments`, action: 'Open departments',
    })
  }
  for (const m of customEmpty) {
    attention.push({
      key: `custom-${m.module_key}`,
      text: <><strong>{m.module_name}</strong> is set to Custom visibility with no members, so nobody but administrators can see it.</>,
      href: `${MAIN_PATH}?tab=modules`, action: 'Open visibility',
    })
  }

  return (
    <>
      <div className={cc.stats}>
        <div className={cc.stat}>
          <div className={cc.statValue}>{activeMembers.length}</div>
          <div className={cc.statLabel}>Active employees</div>
          <div className={cc.statMeta}>{live.length - activeMembers.length} deactivated</div>
        </div>
        <div className={cc.stat}>
          <div className={cc.statValue}>{activeDepts.length}</div>
          <div className={cc.statLabel}>Active departments</div>
          <div className={cc.statMeta}>{depts.length} in total</div>
        </div>
        <div className={cc.stat}>
          <div className={cc.statValue}>{launcherModules.length}</div>
          <div className={cc.statLabel}>Modules in the launcher</div>
          <div className={cc.statMeta}>{modules.length - launcherModules.length} hidden</div>
        </div>
        <div className={cc.stat}>
          <div className={cc.statValue}>{enforcement.enforced.length}<span className={cc.muted} style={{ fontSize: 13, fontWeight: 500 }}> / {enforcementTotal}</span></div>
          <div className={cc.statLabel}>Modules with enforced access</div>
          <div className={cc.statMeta}>
            {enforcement.partial.length > 0 && `${enforcement.partial.length} ${ENFORCEMENT_BADGE_LABEL.partial.toLowerCase()} · `}
            {enforcement.prepared.length} {ENFORCEMENT_BADGE_LABEL.prepared.toLowerCase()}
          </div>
        </div>
      </div>

      <div className={cc.quick}>
        <div className={cc.quickCard}>
          <div className={cc.quickHead}><Users size={15} strokeWidth={1.9} />People</div>
          <div className={cc.quickDesc}>Who has an account, which department and position they hold, and whether the account is active.</div>
          <div className={cc.quickLinks}>
            <Link className={cc.quickLink} href={`${MAIN_PATH}?tab=people`}>Employees</Link>
            <Link className={cc.quickLink} href={`${MAIN_PATH}?tab=departments`}>Departments</Link>
            <Link className={cc.quickLink} href={`${MAIN_PATH}/positions`}>Positions</Link>
            <Link className={`${cc.quickLink} ${cc.quickLinkMuted}`} href="/admin/members">
              Employee Records <ArrowUpRight size={11} style={{ verticalAlign: '-1px' }} />
            </Link>
          </div>
        </div>
        <div className={cc.quickCard}>
          <div className={cc.quickHead}><ShieldCheck size={15} strokeWidth={1.9} />Access</div>
          <div className={cc.quickDesc}>What each employee can open and do in every module: a level per module, with individual permissions underneath.</div>
          <div className={cc.quickLinks}>
            <Link className={cc.quickLink} href={`${MAIN_PATH}/permissions`}>By Employee</Link>
          </div>
        </div>
        <div className={cc.quickCard}>
          <div className={cc.quickHead}><Settings2 size={15} strokeWidth={1.9} />System</div>
          <div className={cc.quickDesc}>Numbering and the test-data controls. Nothing here is routine, and each one explains itself before it acts.</div>
          <div className={cc.quickLinks}>
            <Link className={cc.quickLink} href={`${MAIN_PATH}?tab=order-numbering`}>Order Numbering</Link>
            <Link className={cc.quickLink} href={`${MAIN_PATH}/test-data-cleanup`}>Test Data Cleanup</Link>
            <Link className={cc.quickLink} href={`${MAIN_PATH}/data-management`}>Data Management</Link>
          </div>
        </div>
      </div>

      <CcSection title="Needs attention" description="Checked against the departments, employees and module settings already loaded.">
        <div className={cc.list}>
          {attention.length === 0 ? (
            <div className={cc.listRow}>
              <span className={`${cc.dot} ${cc.dotOk}`} />
              Nothing needs attention. Every active employee has a department, no inactive department still holds people, and no module is set to an empty Custom audience.
            </div>
          ) : attention.map(row => (
            <div key={row.key} className={cc.listRow}>
              <span className={cc.dot} />
              <span className={cc.listMain}>{row.text}</span>
              <Link className={cc.linkBtn} href={row.href}>{row.action}</Link>
            </div>
          ))}
        </div>
      </CcSection>

      {/* Which modules the permission engine decides today, from the one
          source that answers it (src/lib/permissions/enforcement.ts). A grant
          in a module that is not enforced is saved but decides nothing, and an
          administrator handing out access deserves to know that here, not
          only inside the Change Access dialog. */}
      <CcSection title="Access enforcement" description="Modules where saved permissions are not yet fully applied by the engine. Every other module is enforced in the database and the screen.">
        <div className={cc.list}>
          {notEnforced.length === 0 ? (
            <div className={cc.listRow}>
              <span className={`${cc.dot} ${cc.dotOk}`} />
              Every module&apos;s permissions are enforced.
            </div>
          ) : notEnforced.map(key => {
            const e = moduleEnforcement(key)
            return (
              <div key={key} className={cc.listRow}>
                <span className={cc.dot} />
                <span className={cc.listMain}>
                  <strong>{moduleName(key)}</strong>
                  <div className={cc.listDetail}>{e.detail}</div>
                </span>
                <CcBadge tone={e.state === 'partial' ? 'amber' : 'gray'}>{ENFORCEMENT_BADGE_LABEL[e.state]}</CcBadge>
              </div>
            )
          })}
        </div>
      </CcSection>
    </>
  )
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
  const { setMembers, setDepts, setModules } = useControlCenterCache()
  const members = membersQuery.data ?? NO_MEMBERS
  const depts   = deptsQuery.data   ?? NO_DEPARTMENTS
  const modules = modulesQuery.data ?? NO_APP_MODULES
  const loading = membersQuery.isPending || deptsQuery.isPending || modulesQuery.isPending

  // ── Active tab — the URL (?tab=) is the single source of truth, read
  // reactively via useSearchParams so cross-page navigation lands on the right
  // section on the first render.
  const searchParams = useSearchParams()
  const tab: ControlCenterTab = resolveControlCenterTab(searchParams.get('tab'))

  // ── Module edit modal ────────────────────────────────────────────────────
  const [editMod,        setEditMod]        = useState<AppModule | null>(null)
  const [modVisType,     setModVisType]     = useState<VisibilityType>('live')
  const [modAllowedDepts,setModAllowedDepts]= useState<string[]>([])
  const [modAllowedUsers,setModAllowedUsers]= useState<string[]>([])
  const [modSaving,      setModSaving]      = useState(false)
  const [modError,       setModError]       = useState('')

  // ── Department modal (edit or add) ───────────────────────────────────────
  const [editDept,   setEditDept]   = useState<Department | null>(null)
  const [addingDept, setAddingDept] = useState(false)
  const [deptName,   setDeptName]   = useState('')
  const [deptActive, setDeptActive] = useState(true)
  const [deptSaving, setDeptSaving] = useState(false)
  const [deptError,  setDeptError]  = useState('')

  // ── Department delete modal ───────────────────────────────────────────────
  const [deleteDept,   setDeleteDept]   = useState<Department | null>(null)
  const [deleteSaving, setDeleteSaving] = useState(false)
  const [deleteError,  setDeleteError]  = useState('')

  // ── Department people popup ───────────────────────────────────────────────
  const [peopleDept, setPeopleDept] = useState<Department | null>(null)

  // ── Inline row edit (department popup) ────────────────────────────────────
  const [editingPersonId,    setEditingPersonId]    = useState<string | null>(null)
  const [editingPersonTeam,  setEditingPersonTeam]  = useState('')
  const [editingPersonSaving,setEditingPersonSaving]= useState(false)
  const [editingPersonError, setEditingPersonError] = useState('')

  // ── User department modal ─────────────────────────────────────────────────
  const [editUser,   setEditUser]   = useState<UserProfile | null>(null)
  const [userTeam,   setUserTeam]   = useState('')
  const [userSaving, setUserSaving] = useState(false)
  const [userError,  setUserError]  = useState('')

  // ── People search/filter ─────────────────────────────────────────────────
  const [peopleSearch,       setPeopleSearch]       = useState('')
  const [peopleDeptFilter,   setPeopleDeptFilter]   = useState('')
  const [peopleRoleFilter,   setPeopleRoleFilter]   = useState('')
  const [peopleStatusFilter, setPeopleStatusFilter] = useState('')

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

  // People tab's filtered view. Computed with useMemo (not a plain const)
  // because it must run unconditionally every render, same as the other
  // hooks above — it's used after the `if (loading) return` below, but its
  // own hook call has to happen before that early return.
  const filteredMembers = useMemo(() => {
    const q = peopleSearch.trim().toLowerCase()
    return members
      .filter(m => !m.is_deleted)
      .filter(m => !q || m.full_name?.toLowerCase().includes(q) || m.email?.toLowerCase().includes(q))
      .filter(m => !peopleDeptFilter || m.team === peopleDeptFilter)
      .filter(m => !peopleRoleFilter || m.role === peopleRoleFilter)
      .filter(m => !peopleStatusFilter || (peopleStatusFilter === 'active' ? m.is_active : !m.is_active))
  }, [members, peopleSearch, peopleDeptFilter, peopleRoleFilter, peopleStatusFilter])

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

  function openEditDept(dept: Department) {
    setEditDept(dept)
    setDeptName(dept.department_name)
    setDeptActive(dept.is_active)
    setDeptError('')
  }

  function openAddDept() {
    setAddingDept(true)
    setDeptName('')
    setDeptActive(true)
    setDeptError('')
  }

  function closeDeptModal() {
    setEditDept(null)
    setAddingDept(false)
  }

  function openDeleteDept(dept: Department) {
    setDeleteDept(dept)
    setDeleteError('')
  }

  function closeDeleteDept() {
    setDeleteDept(null)
    setDeleteError('')
  }

  function openPeopleDept(dept: Department) {
    setPeopleDept(dept)
    setEditingPersonId(null)
    setEditingPersonError('')
  }

  function closePeopleDept() {
    setPeopleDept(null)
    setEditingPersonId(null)
    setEditingPersonError('')
  }

  function startEditPerson(person: UserProfile) {
    setEditingPersonId(person.id)
    setEditingPersonTeam(person.team ?? '')
    setEditingPersonError('')
  }

  function cancelEditPerson() {
    setEditingPersonId(null)
    setEditingPersonError('')
  }

  function openEditUser(user: UserProfile) {
    setEditUser(user)
    setUserTeam(user.team ?? '')
    setUserError('')
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

  async function saveDept() {
    if (!deptName.trim()) { setDeptError('Name cannot be empty.'); return }
    setDeptSaving(true); setDeptError('')
    try {
      if (addingDept) {
        const res = await fetch('/api/control-center/departments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ department_name: deptName }),
        })
        const json = await res.json()
        if (!res.ok) { setDeptError(json.error ?? 'Save failed'); return }
        setDepts(prev => [...prev, json.department])
      } else if (editDept) {
        const res = await fetch(`/api/control-center/departments/${editDept.department_key}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ department_name: deptName, is_active: deptActive }),
        })
        const json = await res.json()
        if (!res.ok) { setDeptError(json.error ?? 'Save failed'); return }
        setDepts(prev => prev.map(d =>
          d.department_key === editDept.department_key
            ? { ...d, department_name: deptName, is_active: deptActive }
            : d
        ))
      }
      setEditDept(null); setAddingDept(false)
    } finally {
      setDeptSaving(false)
    }
  }

  async function confirmDeleteDept() {
    if (!deleteDept) return
    setDeleteSaving(true); setDeleteError('')
    try {
      const res = await fetch(`/api/control-center/departments/${deleteDept.department_key}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const json = await res.json()
      if (!res.ok) { setDeleteError(json.error ?? 'Delete failed'); return }
      setDepts(prev => prev.filter(d => d.department_key !== deleteDept.department_key))
      setDeleteDept(null)
    } finally {
      setDeleteSaving(false)
    }
  }

  async function saveEditPerson(person: UserProfile) {
    setEditingPersonSaving(true); setEditingPersonError('')
    try {
      const res = await fetch('/api/update-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          userId:    person.id,
          full_name: person.full_name,
          team:      editingPersonTeam,
          role:      person.role,
          position:  person.position ?? null,
        }),
      })
      const json = await res.json()
      if (!res.ok) { setEditingPersonError(json.error ?? 'Save failed'); return }
      setMembers(prev => prev.map(m =>
        m.id === person.id ? { ...m, team: editingPersonTeam } : m
      ))
      setEditingPersonId(null)
    } catch {
      setEditingPersonError('Save failed. Check your connection and try again.')
    } finally {
      setEditingPersonSaving(false)
    }
  }

  async function saveUserDept() {
    if (!editUser) return
    setUserSaving(true); setUserError('')
    try {
      const res = await fetch('/api/update-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          userId:    editUser.id,
          full_name: editUser.full_name,
          team:      userTeam,
          role:      editUser.role,
          position:  editUser.position ?? null,
        }),
      })
      const json = await res.json()
      if (!res.ok) { setUserError(json.error ?? 'Save failed'); return }
      setMembers(prev => prev.map(m =>
        m.id === editUser.id ? { ...m, team: userTeam } : m
      ))
      setEditUser(null)
    } finally {
      setUserSaving(false)
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

  const peopleRoles = Array.from(new Set(members.filter(m => !m.is_deleted).map(m => m.role))).sort()
  const peopleCount = members.filter(m => !m.is_deleted).length

  return (
    <>
      {/* ── Overview ─────────────────────────────────────────────────────── */}
      {tab === 'overview' && (
        <OverviewTab members={members} depts={depts} modules={modules} peopleInDept={peopleInDept} />
      )}

      {/* ── Order Numbering ──────────────────────────────────────────────── */}
      {tab === 'order-numbering' && <OrderNumberCycleTab />}

      {/* ── Employees ────────────────────────────────────────────────────── */}
      {tab === 'people' && (
        <CcSection>
          <CcToolbar>
            <div className={cc.search}>
              <Search size={13} strokeWidth={2} />
              <input
                className={cc.control}
                placeholder="Search name or email"
                aria-label="Search employees"
                value={peopleSearch}
                onChange={e => setPeopleSearch(e.target.value)}
              />
            </div>
            <select className={cc.control} aria-label="Department" value={peopleDeptFilter} onChange={e => setPeopleDeptFilter(e.target.value)}>
              <option value="">All departments</option>
              {depts.map(d => (
                <option key={d.department_key} value={d.department_key}>{d.department_name}</option>
              ))}
            </select>
            <select className={cc.control} aria-label="Role" value={peopleRoleFilter} onChange={e => setPeopleRoleFilter(e.target.value)}>
              <option value="">All roles</option>
              {peopleRoles.map(r => (
                <option key={r} value={r} style={{ textTransform: 'capitalize' }}>{r}</option>
              ))}
            </select>
            <select className={cc.control} aria-label="Status" value={peopleStatusFilter} onChange={e => setPeopleStatusFilter(e.target.value)}>
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
            <span className={cc.count}>
              {filteredMembers.length === peopleCount
                ? `${peopleCount} ${peopleCount === 1 ? 'employee' : 'employees'}`
                : `${filteredMembers.length} of ${peopleCount}`}
            </span>
            <span className={cc.toolbarGrow} />
            {/* Accounts, roles, positions and passwords are managed in Employee
                Records. This screen changes departments only, so the full
                editor is one click away rather than duplicated here. */}
            <Link href="/admin/members" className="boe-btn boe-btn-ghost">
              Employee Records <ArrowUpRight size={12} />
            </Link>
          </CcToolbar>

          {filteredMembers.length === 0 ? (
            <CcEmpty message="No employees match these filters." />
          ) : (
            <CcTable>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Department</th>
                  <th>Role</th>
                  <th>Position</th>
                  <th>Status</th>
                  <th className={cc.right}></th>
                </tr>
              </thead>
              <tbody>
                {filteredMembers.map(member => (
                  <tr key={member.id}>
                    <td>
                      <div className={cc.person}>
                        <Avatar name={member.full_name} size={26} />
                        <div style={{ minWidth: 0 }}>
                          <div className={cc.personName}>{member.full_name}</div>
                          <div className={cc.personSub}>{member.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className={member.team ? undefined : cc.faint}>{deptLabel(member.team)}</td>
                    <td className={`${cc.muted} ${cc.cap}`}>{member.role}</td>
                    <td className={member.position ? cc.muted : cc.faint}>{member.position ?? '—'}</td>
                    <td><ActiveBadge active={member.is_active} /></td>
                    <td className={cc.right}>
                      <button className={cc.linkBtn} onClick={() => openEditUser(member)}>Change department</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </CcTable>
          )}
        </CcSection>
      )}

      {/* ── Departments ──────────────────────────────────────────────────── */}
      {tab === 'departments' && (
        <CcSection>
          <CcToolbar>
            <span className={cc.count}>
              {activeDepts.length} active · {depts.length - activeDepts.length} inactive
            </span>
            <span className={cc.toolbarGrow} />
            <button className="boe-btn boe-btn-primary" onClick={openAddDept}>Add Department</button>
          </CcToolbar>

          {depts.length === 0 ? (
            <CcEmpty message="No departments yet." hint="Add a department to start assigning people to it." />
          ) : (
            <CcTable>
              <thead>
                <tr>
                  <th>Department</th>
                  <th>People</th>
                  <th>Status</th>
                  <th className={cc.right}></th>
                </tr>
              </thead>
              <tbody>
                {depts.map(dept => (
                  <tr key={dept.department_key}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{dept.department_name}</div>
                      <div className={cc.mono}>{dept.department_key}</div>
                    </td>
                    <td>
                      <button
                        className={cc.countBtn}
                        onClick={() => openPeopleDept(dept)}
                        title="See who is in this department"
                      >
                        {peopleInDept(dept.department_key)}
                      </button>
                    </td>
                    <td><ActiveBadge active={dept.is_active} /></td>
                    <td className={cc.right}>
                      <span className={cc.rowActions}>
                        <button className={cc.linkBtn} onClick={() => openEditDept(dept)}>Edit</button>
                        <button className={`${cc.linkBtn} ${cc.linkBtnMuted}`} onClick={() => openDeleteDept(dept)}>Delete</button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </CcTable>
          )}
        </CcSection>
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

      {/* ── Department dialog (add / edit) ────────────────────────────────── */}
      {(editDept || addingDept) && (
        <CcDialog
          title={addingDept ? 'Add Department' : editDept!.department_name}
          subtitle={addingDept ? 'A short key is generated automatically from the name.' : 'Rename the department or change whether it is active.'}
          onClose={closeDeptModal}
          footer={
            <>
              <button className="boe-btn boe-btn-ghost" onClick={closeDeptModal}>Cancel</button>
              <button className="boe-btn boe-btn-primary" onClick={saveDept} disabled={deptSaving}>
                {deptSaving ? 'Saving…' : 'Save'}
              </button>
            </>
          }
        >
          <CcField label="Department name">
            <input
              className={cc.fieldControl}
              value={deptName}
              onChange={e => setDeptName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !deptSaving) void saveDept() }}
              placeholder="e.g. Business Development"
              autoFocus
            />
          </CcField>

          {!addingDept && (
            <label className={cc.check}>
              <input
                type="checkbox"
                checked={deptActive}
                onChange={e => setDeptActive(e.target.checked)}
              />
              Active
            </label>
          )}

          {deptError && <div className={cc.error}>{deptError}</div>}
        </CcDialog>
      )}

      {/* ── Department delete dialog ──────────────────────────────────────── */}
      {deleteDept && (
        peopleInDept(deleteDept.department_key) > 0 ? (
          <CcDialog
            title={`Delete ${deleteDept.department_name}`}
            onClose={closeDeleteDept}
            footer={<button className="boe-btn boe-btn-primary" onClick={closeDeleteDept}>OK</button>}
          >
            <div style={{ fontSize: 13 }}>
              This department has people assigned. Move them before deleting.
            </div>
          </CcDialog>
        ) : (
          <CcDialog
            title={`Delete ${deleteDept.department_name}`}
            onClose={closeDeleteDept}
            footer={
              <>
                <button className="boe-btn boe-btn-ghost" onClick={closeDeleteDept}>Cancel</button>
                <button className="boe-btn boe-btn-danger" onClick={confirmDeleteDept} disabled={deleteSaving}>
                  {deleteSaving ? 'Deleting…' : 'Delete department'}
                </button>
              </>
            }
          >
            <div style={{ fontSize: 13 }}>
              Delete <strong>{deleteDept.department_name}</strong>? This cannot be undone.
            </div>
            {deleteError && <div className={cc.error}>{deleteError}</div>}
          </CcDialog>
        )
      )}

      {/* ── Department people dialog ──────────────────────────────────────── */}
      {peopleDept && (
        <CcDialog
          title={`People in ${peopleDept.department_name}`}
          subtitle="Reassign anyone here without leaving the list."
          onClose={closePeopleDept}
          wide
          footer={<button className="boe-btn boe-btn-ghost" onClick={closePeopleDept}>Close</button>}
        >
          {(() => {
            const people = members.filter(m => !m.is_deleted && m.team === peopleDept.department_key)
            if (people.length === 0) {
              return <div className={cc.muted} style={{ fontSize: 13 }}>No people are assigned to this department.</div>
            }
            return (
              <CcTable>
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Role</th>
                    <th>Department</th>
                    <th>Status</th>
                    <th className={cc.right}></th>
                  </tr>
                </thead>
                <tbody>
                  {people.map(person => {
                    const isEditing = editingPersonId === person.id
                    return (
                      <tr key={person.id}>
                        <td>
                          <div className={cc.person}>
                            <Avatar name={person.full_name} size={26} />
                            <div style={{ minWidth: 0 }}>
                              <div className={cc.personName}>{person.full_name}</div>
                              <div className={cc.personSub}>{person.email}</div>
                            </div>
                          </div>
                        </td>
                        <td className={`${cc.muted} ${cc.cap}`}>{person.role}</td>
                        <td>
                          {isEditing ? (
                            <>
                              <select
                                className={`${cc.control} ${cc.inlineSelect}`}
                                value={editingPersonTeam}
                                onChange={e => setEditingPersonTeam(e.target.value)}
                                disabled={editingPersonSaving}
                              >
                                {activeDepts.map(d => (
                                  <option key={d.department_key} value={d.department_key}>
                                    {d.department_name}
                                  </option>
                                ))}
                              </select>
                              {editingPersonError && (
                                <div className={cc.error} style={{ marginTop: 4 }}>{editingPersonError}</div>
                              )}
                            </>
                          ) : (
                            <span className={person.team ? undefined : cc.faint}>{deptLabel(person.team)}</span>
                          )}
                        </td>
                        <td><ActiveBadge active={person.is_active} /></td>
                        <td className={cc.right}>
                          {isEditing ? (
                            <span className={cc.rowActions}>
                              <button className={cc.linkBtn} onClick={() => saveEditPerson(person)} disabled={editingPersonSaving}>
                                {editingPersonSaving ? 'Saving…' : 'Save'}
                              </button>
                              <button className={`${cc.linkBtn} ${cc.linkBtnMuted}`} onClick={cancelEditPerson} disabled={editingPersonSaving}>
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button className={cc.linkBtn} onClick={() => startEditPerson(person)}>Change department</button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </CcTable>
            )
          })()}
        </CcDialog>
      )}

      {/* ── Employee department dialog ────────────────────────────────────── */}
      {editUser && (
        <CcDialog
          title={editUser.full_name}
          subtitle="Only the department is changed here. Roles, positions and account status are managed in Employee Records."
          onClose={() => setEditUser(null)}
          footer={
            <>
              <button className="boe-btn boe-btn-ghost" onClick={() => setEditUser(null)}>Cancel</button>
              <button className="boe-btn boe-btn-primary" onClick={saveUserDept} disabled={userSaving}>
                {userSaving ? 'Saving…' : 'Save'}
              </button>
            </>
          }
        >
          <CcField label="Department">
            <select
              className={cc.fieldControl}
              value={userTeam}
              onChange={e => setUserTeam(e.target.value)}
              autoFocus
            >
              <option value="">— No department —</option>
              {activeDepts.map(d => (
                <option key={d.department_key} value={d.department_key}>
                  {d.department_name}
                </option>
              ))}
            </select>
          </CcField>

          {userError && <div className={cc.error}>{userError}</div>}
        </CcDialog>
      )}
    </>
  )
}
