'use client'

// Access › People.
//
// One person, every module: what they can open, how much they can do inside,
// and which decisions are theirs. A module is ONE control (Off, or a level)
// plus the authorities held as chips; nothing on this screen is offered that
// the app does not read (src/lib/permissions/accessCatalog.ts). Reads come
// from the per-employee tree route; every change is saved through the same
// per-employee PUT the Modules and Authorities screens use, with the
// per-action override choices derived by the same shared rule
// (src/lib/permissions/accessControlChanges.ts), so the three screens store
// identical rows for identical intentions.

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Search, ArrowUpRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { ControlCenterSkeleton } from '@/components/layout/ControlCenterSkeleton'
import { AlertBanner, Avatar } from '@/components/ui/atoms'
import { cc, CcBadge, CcEmpty } from '@/components/controlCenter/CcPrimitives'
import { ModuleIcon } from '@/components/modules/ModuleIcons'
import {
  AuthorityChips, AuthorityPicker, LevelControl, OffConfirm, setByText,
} from '@/components/controlCenter/AccessRow'
import { entryActionForModule } from '@/lib/permissions/levels'
import {
  choicesForDesired,
  type OverrideChoice,
  type PermissionSource,
} from '@/lib/permissions/accessControlChanges'
import {
  adminEditableActions,
  isAdminEditableAction,
} from '@/lib/permissions/orderApproval'
import {
  authoritiesClearedByOff,
  authoritiesFor,
  desiredForLevel,
  desiredWithAuthority,
  detectOfferedLevel,
  heldAuthorities,
  isModuleOfferedTo,
  isSelfServiceModuleKey,
  levelLabel,
  levelSentence,
  moduleWords,
  offeredLevels,
  type OfferedLevel,
} from '@/lib/permissions/accessCatalog'
import { describeChange } from '@/components/controlCenter/accessEdits'
import {
  useAdminMembers, useDepartments, useInvalidateAccessMatrix, NO_MEMBERS, NO_DEPARTMENTS,
} from '@/hooks/queries/useControlCenterData'
import styles from './permissions.module.css'

// ── Local types ───────────────────────────────────────────────────────────────

type ActionState = {
  actionKey: string
  displayName: string
  allowed: boolean
  source: PermissionSource
  sourceLabel: string
  grantedBy: { id: string; name: string | null } | null
  grantedAt: string | null
}

type ModuleState = {
  moduleKey: string
  displayName: string
  actions: ActionState[]
}

type EmployeePermissionTree = {
  employee: { id: string; name: string; role: string; department: string | null }
  modules: ModuleState[]
}

/**
 * A system Administrator's authority comes from users.role, not from anything
 * on this screen. Every module guard, RPC and policy in the app short-circuits
 * on role = 'admin', so an override written here could neither add to that nor
 * take anything away — with the exception of the per-person authorities that
 * have a permission-only door in the database (ADMIN_EDITABLE_ACTIONS).
 *
 * This is checked against the SELECTED employee, not the signed-in one, so it
 * protects every admin rather than only the person doing the editing.
 */
function isSystemAdmin(tree: EmployeePermissionTree | null): boolean {
  return tree?.employee.role === 'admin'
}

const ROLE_HINT: Record<string, string> = {
  member: 'Member grants nothing by itself. The modules below are what decide.',
  manager: 'Manager still grants four things by itself that no row below shows: the All Tasks page, creating attendance-only employees, reading every EOD log, and recording fabric/finish approvals on orders.',
  admin: 'Administrator opens every module and the Control Center. Only the authorities granted per person can be given or taken away here.',
}

// Override choices are keyed "moduleKey:actionKey" because one tree holds
// every module. The write rule itself — which choice each action gets for a
// desired state — is the shared one in accessControlChanges.ts, so Modules
// and Authorities cannot store something different for the same intention.
function overrideKey(moduleKey: string, actionKey: string) {
  return `${moduleKey}:${actionKey}`
}

function choiceFromAction(action: ActionState): OverrideChoice {
  if (action.source !== 'employee_override') return 'inherit'
  return action.allowed ? 'allow' : 'deny'
}

// The effective allowed/denied state per action, folding in any pending
// (unsaved) override choice on top of what the server resolved on load.
function effectiveMapForModule(mod: ModuleState, overrides: Map<string, OverrideChoice>): Record<string, boolean> {
  const map: Record<string, boolean> = {}
  for (const action of mod.actions) {
    const choice = overrides.get(overrideKey(mod.moduleKey, action.actionKey)) ?? 'inherit'
    map[action.actionKey] = choice === 'inherit' ? action.allowed : choice === 'allow'
  }
  return map
}

function baseMapForModule(mod: ModuleState): Record<string, boolean> {
  const map: Record<string, boolean> = {}
  for (const action of mod.actions) map[action.actionKey] = action.allowed
  return map
}

// THE PARENT GATE, as this screen reports it.
//
// Open/Off is effective `view` and nothing else — the same single fact the
// launcher card and every route guard read (canAccessManagementModule in
// src/lib/permissions/moduleVisibility.ts). The screen and the running app
// therefore cannot disagree about whether a module is on.
const MODULE_ENTRY_ACTION = 'view'

/**
 * ONE module expresses entry with a different key, and the control has to
 * follow it or it is a control that decides nothing. Review Workflow registers
 * `use` and `verify` and NO `view`. entryActionForModule reads the module's
 * OWN registered actions, so this screen, the catalogue and the module guard
 * cannot drift; `view` remains the answer for every other module.
 */
function entryActionFor(mod: ModuleState): string {
  return entryActionForModule(mod.actions.map(a => a.actionKey)) ?? MODULE_ENTRY_ACTION
}

/** Open or Off including any unsaved change the administrator has made. */
function moduleIsAccessible(mod: ModuleState, overrides: Map<string, OverrideChoice>): boolean {
  return effectiveMapForModule(mod, overrides)[entryActionFor(mod)] === true
}

function moduleIsDirty(mod: ModuleState, overrides: Map<string, OverrideChoice>, initialOverrides: Map<string, OverrideChoice>): boolean {
  return mod.actions.some(a => {
    const key = overrideKey(mod.moduleKey, a.actionKey)
    return overrides.get(key) !== initialOverrides.get(key)
  })
}

const keysOf = (mod: ModuleState) => mod.actions.map(a => a.actionKey)

const DATE_FMT = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })

// ── Employee directory (left column) ────────────────────────────────────────

function EmployeePanel({
  search, onSearchChange, results, selectedEmployeeId, onSelect, deptLabel,
}: {
  search: string
  onSearchChange: (v: string) => void
  results: UserProfile[]
  selectedEmployeeId: string | null
  onSelect: (id: string) => void
  deptLabel: (key: string | null | undefined) => string
}) {
  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <span>Employees</span>
        {/* A plain count, so an administrator can see the list is the whole
            directory rather than a window onto it. */}
        {results.length > 0 && (
          <span className={styles.panelCount}>
            {results.length} {results.length === 1 ? 'employee' : 'employees'}
          </span>
        )}
      </div>

      <div className={cc.search}>
        <Search size={13} strokeWidth={2} />
        <input
          className={cc.control}
          style={{ width: '100%' }}
          placeholder="Search name, department or title"
          aria-label="Search employees"
          value={search}
          onChange={e => onSearchChange(e.target.value)}
        />
      </div>

      <div className={styles.panelList}>
        {results.length === 0 && (
          <div className={cc.muted} style={{ padding: '14px 4px', fontSize: 13 }}>No matches.</div>
        )}
        {results.map(m => {
          const selected = m.id === selectedEmployeeId
          return (
            <button
              key={m.id}
              type="button"
              className={`${styles.row}${selected ? ` ${styles.rowSelected}` : ''}${m.is_active ? '' : ` ${styles.rowMuted}`}`}
              aria-pressed={selected}
              onClick={() => onSelect(m.id)}
            >
              <Avatar name={m.full_name} size={28} />
              <div className={styles.rowText}>
                <div className={styles.rowName}>
                  {m.full_name}
                  {m.role === 'admin' && <span style={{ marginLeft: 6 }}><CcBadge tone="gray">Admin</CcBadge></span>}
                </div>
                <div className={styles.rowSub}>
                  {deptLabel(m.team)}{m.position ? ` · ${m.position}` : ''}{m.is_active ? '' : ' · Inactive'}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Workspace header (selected employee summary) ────────────────────────────

function WorkspaceHeader({
  tree, overrides, position, offered, onRemoveAll,
}: {
  tree: EmployeePermissionTree
  overrides: Map<string, OverrideChoice>
  position: string | null
  offered: ModuleState[]
  onRemoveAll: () => void
}) {
  const admin = isSystemAdmin(tree)
  const accessible = admin ? offered.length : offered.filter(mod => moduleIsAccessible(mod, overrides)).length
  const authorities = offered.reduce((n, mod) => {
    const held = heldAuthorities(mod.moduleKey, keysOf(mod), effectiveMapForModule(mod, overrides))
    return n + (admin ? held.filter(a => a.perPerson).length : held.length)
  }, 0)
  const latest = offered.flatMap(mod => mod.actions)
    .filter(a => a.source === 'employee_override' && a.grantedAt)
    .sort((a, b) => (b.grantedAt ?? '').localeCompare(a.grantedAt ?? ''))[0]
  const lastChange = latest?.grantedAt
    ? `${DATE_FMT.format(new Date(latest.grantedAt))}${latest.grantedBy?.name ? ` · ${latest.grantedBy.name.split(' ')[0]}` : ''}`
    : '—'

  return (
    <div className={styles.header}>
      <div className={styles.headerIdentity}>
        <Avatar name={tree.employee.name} size={40} />
        <div style={{ minWidth: 0 }}>
          <div className={styles.headerName}>{tree.employee.name}</div>
          <div className={styles.headerSub}>{tree.employee.department ?? '—'}{position ? ` · ${position}` : ''}</div>
        </div>
      </div>
      <div className={styles.headerStats}>
        <div className={styles.headerStat}>
          <div className={styles.headerStatValue}>{accessible}<small> / {offered.length}</small></div>
          <div className={styles.headerStatLabel}>Can open</div>
        </div>
        <div className={styles.headerStat}>
          <div className={styles.headerStatValue}>{authorities}</div>
          <div className={styles.headerStatLabel}>Authorities</div>
        </div>
        <div className={styles.headerStat}>
          <div className={styles.headerStatValue} style={{ fontSize: 14, paddingTop: 4 }}>{lastChange}</div>
          <div className={styles.headerStatLabel}>Last change</div>
        </div>
      </div>
      <div className={styles.headerRole}>
        <span><b>System role</b></span>
        <CcBadge tone={admin ? 'gray' : 'blue'}>{admin ? 'Administrator' : tree.employee.role === 'manager' ? 'Manager' : 'Member'}</CcBadge>
        <span className={cc.muted}>{ROLE_HINT[tree.employee.role] ?? ''}</span>
        <Link href="/admin/control-center/people" className={cc.linkBtn}>Change in Employees <ArrowUpRight size={11} style={{ verticalAlign: '-1px' }} /></Link>
      </div>
      {!admin && (
        <div className={styles.headerActions}>
          <button type="button" className="boe-btn boe-btn-ghost" onClick={onRemoveAll}>Remove all access</button>
        </div>
      )}
    </div>
  )
}

// ── Attendance & Payroll ─────────────────────────────────────────────────────
//
// One quiet row, deliberately read-only. Attendance and Payroll are two
// permission modules wearing one name: the launcher shows them as a single
// card, and their MANAGEMENT surface is admin-only by an explicit product
// decision that no grant on this screen can change — see
// SELF_SERVICE_MODULE_KEYS and resolveManagementAccess in src/lib/moduleAccess.ts.
// Nothing on this page writes an attendance or payroll override.

function AttendancePayrollCard({ modules }: { modules: ModuleState[] }) {
  // An inert override would decide nothing today, but an administrator should
  // still be told it is there rather than discovering it during a future
  // cutover — that is exactly how migration 20260723000000 came to exist.
  const strayOverrides = modules.flatMap(mod =>
    mod.actions
      .filter(a => a.source === 'employee_override' && a.allowed)
      .map(a => `${mod.displayName} ${a.displayName}`),
  )

  return (
    <div className={styles.mrow}>
      <div>
        <div className={styles.mrowName}><span className={styles.mrowIcon}><ModuleIcon moduleKey="attendance_payroll" size={17} /></span>Attendance &amp; Payroll</div>
        <div className={styles.mrowDesc}>
          Self-service: employees can view their own attendance and payroll and raise issues.
          {' '}Management access is restricted to system administrators and cannot be granted here.
        </div>
        {strayOverrides.length > 0 && (
          <div className={styles.rowNote} style={{ color: '#805B0D' }}>
            <strong>Unused permissions on record:</strong> {strayOverrides.join(', ')}.
            These grant nothing — management access is admin-only — and have been
            left exactly as they are.
          </div>
        )}
      </div>
      <div className={styles.mrowRight}><CcBadge tone="blue">Self-service · own record</CcBadge></div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PermissionsPage() {
  return (
    <Suspense fallback={<ControlCenterSkeleton />}>
      <PermissionsPageInner />
    </Suspense>
  )
}

function PermissionsPageInner() {
  const supabase = useMemo(() => createClient(), [])
  const router   = useRouter()
  const pathname = usePathname()
  const employeeParam = useSearchParams().get('employee')
  const invalidateMatrix = useInvalidateAccessMatrix()

  const [token,   setToken]   = useState('')

  // Shared with the main Control Center page and cached across sections: see
  // src/hooks/queries/useControlCenterData.ts.
  const membersQuery = useAdminMembers()
  const deptsQuery   = useDepartments()
  const members = membersQuery.data ?? NO_MEMBERS
  const depts   = deptsQuery.data   ?? NO_DEPARTMENTS
  const loading = membersQuery.isPending || deptsQuery.isPending

  const [search,             setSearch]             = useState('')
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null)

  const [tree,        setTree]        = useState<EmployeePermissionTree | null>(null)
  const [treeLoading,  setTreeLoading] = useState(false)
  const [treeError,    setTreeError]   = useState('')

  const [overrides,      setOverrides]      = useState<Map<string, OverrideChoice>>(new Map())
  const [initialOverrides, setInitialOverrides] = useState<Map<string, OverrideChoice>>(new Map())

  const [pickerModuleKey, setPickerModuleKey] = useState<string | null>(null)
  const [offConfirm, setOffConfirm] = useState<{ moduleKey: string; cleared: string[] } | null>(null)
  const [removeAllConfirm, setRemoveAllConfirm] = useState<string[] | null>(null)
  const [showClosed, setShowClosed] = useState(false)

  const [saving,   setSaving]   = useState(false)
  const [saveError, setSaveError] = useState('')

  // ── Init ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const init = async () => {
      // Identity and the admin check are owned by control-center/layout.tsx,
      // which renders this page only for an admitted administrator. The stored
      // session is read here solely for the bearer token the tree GET and the
      // save PUT need; the directory comes from the shared queries above.
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      setToken(session.access_token)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Employee search results ─────────────────────────────────────────────
  const deptLabel = (key: string | null | undefined) => {
    if (!key) return '—'
    return depts.find(d => d.department_key === key)?.department_name ?? key
  }

  /**
   * Every employee an administrator may assign access to.
   *
   * Nothing is truncated: the panel scrolls and the search box narrows it. The
   * only exclusion is soft-deleted accounts. Inactive accounts remain listed
   * because an administrator has to be able to see and adjust what a
   * deactivated person would regain, and because hiding them here is how
   * somebody becomes unassignable. Names are never filtered on content — an
   * account that can authenticate is an account that can hold permissions.
   */
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    const pool = members.filter(m => !m.is_deleted)
    if (!q) return pool
    return pool.filter(m =>
      m.full_name?.toLowerCase().includes(q) ||
      m.email?.toLowerCase().includes(q) ||
      deptLabel(m.team).toLowerCase().includes(q) ||
      m.position?.toLowerCase().includes(q) ||
      m.role?.toLowerCase().includes(q)
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, members, depts])

  // ── Load an employee's permission tree ──────────────────────────────────
  //
  // THE ONLY READ OF THE TREE ROUTE, and it happens when an employee is opened.
  const UNSAVED_PROMPT = 'You have unsaved access changes. Leave without saving?'

  async function selectEmployee(id: string) {
    if (id === selectedEmployeeId) return
    // Only ask when there is something to lose. Prompting on a clean screen
    // trains people to dismiss the prompt without reading it.
    if (dirty && !window.confirm(UNSAVED_PROMPT)) return

    // Leaving discards LOCAL pending state only. No request is sent — the
    // employee's stored permissions are untouched by walking away.
    setSelectedEmployeeId(id)
    setSaveError('')
    setPickerModuleKey(null)
    setOffConfirm(null)
    setRemoveAllConfirm(null)
    // The selection is in the URL so it can be linked to (Modules' rows and
    // the employee dialog land here) and survives a refresh. Replaced, not
    // pushed: walking a directory is not a history of pages.
    router.replace(`${pathname}?employee=${id}`)
    await loadTree(id)
  }

  async function loadTree(id: string) {
    setTreeLoading(true)
    setTreeError('')
    try {
      const res = await fetch(`/api/control-center/permissions/employees/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const json = await res.json()
      if (!res.ok) { setTreeError(json.error ?? 'Failed to load permissions'); setTree(null); return }

      const data = json as EmployeePermissionTree
      setTree(data)

      const initial = new Map<string, OverrideChoice>()
      for (const mod of data.modules) {
        for (const action of mod.actions) {
          initial.set(overrideKey(mod.moduleKey, action.actionKey), choiceFromAction(action))
        }
      }
      setInitialOverrides(initial)
      setOverrides(new Map(initial))
      setPickerModuleKey(null)
      setOffConfirm(null)
    } finally {
      setTreeLoading(false)
    }
  }

  // The ONE place per-action override state is written.
  //
  // `deriveDesired` receives the module's current effective map — including any
  // unsaved edits — and returns the intended one. The level control, the
  // authority chips and the Off confirmation all go through here, so there is
  // one write path and no second setting to reconcile. How each action's
  // choice is decided is the shared rule in accessControlChanges.ts
  // (choicesForDesired), which Modules and Authorities use too.
  //
  // The current map is read from `prev` INSIDE the updater rather than from the
  // `overrides` closure, so two edits applied in the same tick cannot read a
  // stale map and undo one another.
  function applyDesiredActions(
    mod: ModuleState,
    deriveDesired: (current: Record<string, boolean>) => Record<string, boolean>,
  ) {
    setOverrides(prev => {
      const desired = deriveDesired(effectiveMapForModule(mod, prev))
      const next = new Map(prev)
      for (const [actionKey, choice] of choicesForDesired(mod.actions, desired)) {
        next.set(overrideKey(mod.moduleKey, actionKey), choice)
      }
      return next
    })
  }

  /**
   * The level control. A level writes only the offered standard actions and
   * KEEPS every authority (the owner's decision of 2026-10-29). Off is the one
   * complete statement — every registered action false — and because that
   * removes things it names them and waits.
   */
  function changeLevel(mod: ModuleState, level: OfferedLevel | 'off') {
    const actionKeys = keysOf(mod)
    if (level === 'off') {
      const cleared = authoritiesClearedByOff(mod.moduleKey, actionKeys, effectiveMapForModule(mod, overrides))
      if (cleared.length > 0) { setOffConfirm({ moduleKey: mod.moduleKey, cleared }); setPickerModuleKey(null); return }
    }
    applyDesiredActions(mod, current => desiredForLevel(mod.moduleKey, actionKeys, level, current))
    setOffConfirm(null)
  }

  function confirmOff(mod: ModuleState) {
    applyDesiredActions(mod, current => desiredForLevel(mod.moduleKey, keysOf(mod), 'off', current))
    setOffConfirm(null)
  }

  function addAuthority(mod: ModuleState, actionKey: string) {
    applyDesiredActions(mod, current => desiredWithAuthority(mod.moduleKey, keysOf(mod), actionKey, true, current))
    setPickerModuleKey(null)
  }

  function removeAuthority(mod: ModuleState, actionKey: string) {
    applyDesiredActions(mod, current => desiredWithAuthority(mod.moduleKey, keysOf(mod), actionKey, false, current))
  }

  function removeAll(offered: ModuleState[]) {
    const cleared = offered.flatMap(mod => authoritiesClearedByOff(mod.moduleKey, keysOf(mod), effectiveMapForModule(mod, overrides)))
    if (cleared.length > 0 && removeAllConfirm === null) { setRemoveAllConfirm(cleared); return }
    for (const mod of offered) applyDesiredActions(mod, current => desiredForLevel(mod.moduleKey, keysOf(mod), 'off', current))
    setRemoveAllConfirm(null)
  }

  // A plain computation, not useMemo: it is one pass over a Map of a few dozen
  // entries, and memoizing it stopped the React Compiler from optimizing the
  // component at all once the toggle and navigation guards started reading the
  // same state.
  let hasPendingChanges = false
  for (const [key, choice] of overrides) {
    if (initialOverrides.get(key) !== choice) { hasPendingChanges = true; break }
  }
  const dirty = hasPendingChanges

  // Refresh, tab close and browser Back. The listener is attached only while
  // there is something to lose and removed the moment the screen goes clean, so
  // a saved page never traps anybody. Browsers show their own wording here; the
  // in-app prompt above is where our sentence appears.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  // A deep link (?employee=) opens that person once the token and directory
  // are ready. Only when nothing is selected yet, so it can never override a
  // choice the administrator has made since.
  useEffect(() => {
    if (!token || !employeeParam || selectedEmployeeId) return
    if (!members.some(m => m.id === employeeParam)) return
    const open = () => { void selectEmployee(employeeParam) }
    open()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, employeeParam, members])

  function discardChanges() {
    setOverrides(new Map(initialOverrides))
    setSaveError('')
    setOffConfirm(null)
    setRemoveAllConfirm(null)
  }

  // ── Save ─────────────────────────────────────────────────────────────────
  async function save() {
    if (!selectedEmployeeId || !tree) return
    const admin = isSystemAdmin(tree)

    const changes: { moduleKey: string; actionKey: string; allowed: boolean | null }[] = []
    for (const mod of tree.modules) {
      for (const action of mod.actions) {
        // A system Administrator's authority comes from users.role for every
        // action EXCEPT the ones with a permission-only door in the database
        // (today: orders.approve_order). The controls are locked for the rest,
        // and this is the second gate: nothing else is even put in the
        // request, so a bypassed UI still sends only what can take effect.
        if (admin && !isAdminEditableAction(mod.moduleKey, action.actionKey)) continue
        const key = overrideKey(mod.moduleKey, action.actionKey)
        const choice = overrides.get(key)
        if (!choice || choice === initialOverrides.get(key)) continue
        changes.push({
          moduleKey: mod.moduleKey,
          actionKey: action.actionKey,
          allowed: choice === 'inherit' ? null : choice === 'allow',
        })
      }
    }
    if (changes.length === 0) return

    setSaving(true)
    setSaveError('')
    try {
      const res = await fetch(`/api/control-center/permissions/employees/${selectedEmployeeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ changes }),
      })
      const json = await res.json()
      if (!res.ok) { setSaveError(json.error ?? 'Save failed'); return }

      await loadTree(selectedEmployeeId)
      // Modules and Authorities read the matrix; the next look must be fresh.
      await invalidateMatrix()
    } finally {
      setSaving(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) return <ControlCenterSkeleton />

  const adminLocked = isSystemAdmin(tree)
  const selfServiceModules = tree?.modules.filter(m => isSelfServiceModuleKey(m.moduleKey)) ?? []
  // Attendance & Payroll are never granted here; Employee Records only on an
  // Administrator (the owner's decision of 2026-10-29). See accessCatalog.ts.
  const offeredModules = tree?.modules.filter(m => isModuleOfferedTo(m.moduleKey, tree.employee.role)) ?? []
  const openModules = adminLocked ? offeredModules : offeredModules.filter(mod => moduleIsAccessible(mod, overrides))
  const closedModules = adminLocked ? [] : offeredModules.filter(mod => !moduleIsAccessible(mod, overrides))
  const selectedMember = members.find(m => m.id === selectedEmployeeId) ?? null

  const changeList = tree
    ? offeredModules
        .filter(mod => moduleIsDirty(mod, overrides, initialOverrides))
        .map(mod => describeChange(mod.moduleKey, mod.displayName, keysOf(mod), baseMapForModule(mod), effectiveMapForModule(mod, overrides)))
    : []
  const changedModuleCount = changeList.length

  return (
    <div className={styles.layout}>

      <EmployeePanel
        search={search}
        onSearchChange={setSearch}
        results={searchResults}
        selectedEmployeeId={selectedEmployeeId}
        onSelect={selectEmployee}
        deptLabel={deptLabel}
      />

      <div className={styles.workspace}>
        {!selectedEmployeeId && (
          <CcEmpty
            message="Select an employee to see and change what they can access."
            hint="Or look at one module across everyone under Access › Modules, or every decision under Authorities."
          />
        )}

        {selectedEmployeeId && treeLoading && <ControlCenterSkeleton />}

        {selectedEmployeeId && !treeLoading && treeError && (
          <div className={cc.error}>{treeError}</div>
        )}

        {selectedEmployeeId && !treeLoading && tree && (
          <>
            <WorkspaceHeader
              tree={tree}
              overrides={overrides}
              position={selectedMember?.position ?? null}
              offered={offeredModules}
              onRemoveAll={() => removeAll(offeredModules)}
            />

            {removeAllConfirm && (
              <OffConfirm
                moduleName="every module"
                personName={tree.employee.name}
                cleared={removeAllConfirm}
                onConfirm={() => removeAll(offeredModules)}
                onCancel={() => setRemoveAllConfirm(null)}
              />
            )}

            {adminLocked && (
              <AlertBanner variant="amber">
                <strong>System Administrator.</strong> Module access is controlled by
                this person&apos;s system role, not by the settings below. An override
                saved here could neither add to their authority nor reduce it,
                except for the authorities granted per person (such as
                Approve PI / Confirm Order), which can be given to, and taken back
                from, an administrator like anybody else.
              </AlertBanner>
            )}

            <div className={styles.sectionHead}>
              <span className={styles.sectionTitle}>Can open <small>{openModules.length}</small></span>
              <span className={styles.sectionDesc}>One control per module: Off, or how much they can do. Authorities are the decisions this person holds.</span>
            </div>

            <div className={styles.cards}>
              {openModules.map(mod => {
                const actionKeys = keysOf(mod)
                const effective = effectiveMapForModule(mod, overrides)
                const base = baseMapForModule(mod)
                const level = adminLocked ? 'viewer' : detectOfferedLevel(mod.moduleKey, actionKeys, effective)
                const words = moduleWords(mod.moduleKey)
                const unsaved = moduleIsDirty(mod, overrides, initialOverrides)
                const hasAuthorities = authoritiesFor(mod.moduleKey, actionKeys).some(a => !adminLocked || a.perPerson)
                return (
                  <div key={mod.moduleKey} className={`${styles.mrow}${unsaved ? ` ${styles.mrowChanged}` : ''}`}>
                    <div style={{ minWidth: 0 }}>
                      <div className={styles.mrowName}>
                        <span className={styles.mrowIcon}><ModuleIcon moduleKey={mod.moduleKey} size={17} /></span>
                        {mod.displayName}
                        {unsaved && <span className={styles.unsaved}>Unsaved</span>}
                      </div>
                      <div className={styles.mrowDesc}>
                        {adminLocked ? 'Everything, by role.' : levelSentence(mod.moduleKey, actionKeys, level)}
                      </div>
                      {words?.note && <div className={styles.rowNote}>{words.note}</div>}
                    </div>
                    <div className={styles.mrowRight}>
                      <LevelControl
                        moduleKey={mod.moduleKey}
                        moduleName={mod.displayName}
                        personName={tree.employee.name}
                        actionKeys={actionKeys}
                        level={level}
                        locked={adminLocked}
                        onChange={lv => changeLevel(mod, lv)}
                      />
                      <div className={styles.setBy}>
                        {setByText(mod.actions, entryActionFor(mod), tree.employee.role, { defaultOn: words?.defaultOn, unsaved })}
                      </div>
                    </div>
                    {hasAuthorities && (
                      <div className={styles.mrowAuth}>
                        <span className={styles.mrowAuthLabel}>Authorities</span>
                        <AuthorityChips
                          moduleKey={mod.moduleKey}
                          actionKeys={actionKeys}
                          effective={effective}
                          baseEffective={base}
                          locked={adminLocked}
                          perPersonOnly={adminLocked}
                          canAdd
                          pickerOpen={pickerModuleKey === mod.moduleKey}
                          onRemove={actionKey => removeAuthority(mod, actionKey)}
                          onOpenPicker={() => { setPickerModuleKey(k => k === mod.moduleKey ? null : mod.moduleKey); setOffConfirm(null) }}
                        />
                        {adminLocked && heldAuthorities(mod.moduleKey, actionKeys, effective).filter(a => a.perPerson).length === 0 && adminEditableActions(mod.moduleKey).length > 0 && (
                          <span className={cc.muted} style={{ fontSize: 12 }}>Granted per person, Administrators included.</span>
                        )}
                      </div>
                    )}
                    {words?.related && !adminLocked && (
                      <div className={styles.mrowRelated}>
                        {words.related.map(r => (
                          <span key={r.href}>{r.label}: <Link href={r.href}>{r.where}</Link></span>
                        ))}
                      </div>
                    )}
                    {pickerModuleKey === mod.moduleKey && (
                      <div className={styles.mrowWide}>
                        <AuthorityPicker
                          moduleKey={mod.moduleKey}
                          moduleName={mod.displayName}
                          personName={tree.employee.name}
                          actionKeys={actionKeys}
                          effective={effective}
                          perPersonOnly={adminLocked}
                          onAdd={a => addAuthority(mod, a.actionKey)}
                          onClose={() => setPickerModuleKey(null)}
                        />
                      </div>
                    )}
                    {offConfirm?.moduleKey === mod.moduleKey && (
                      <div className={styles.mrowWide}>
                        <OffConfirm
                          moduleName={mod.displayName}
                          personName={tree.employee.name}
                          cleared={offConfirm.cleared}
                          onConfirm={() => confirmOff(mod)}
                          onCancel={() => setOffConfirm(null)}
                        />
                      </div>
                    )}
                  </div>
                )
              })}

              {/* Attendance & Payroll is one row, and it is not editable. It is
                  rendered from the two underlying modules but writes neither. */}
              {selfServiceModules.length > 0 && (
                <AttendancePayrollCard modules={selfServiceModules} />
              )}
            </div>

            {closedModules.length > 0 && (
              <>
                <div className={styles.sectionHead}>
                  <span className={styles.sectionTitle}>Cannot open <small>{closedModules.length}</small></span>
                  <button type="button" className={cc.linkBtn} onClick={() => setShowClosed(s => !s)}>
                    {showClosed ? 'Hide' : 'Show'}
                  </button>
                </div>
                {showClosed && (
                  <div className={styles.closed}>
                    {closedModules.map(mod => {
                      const actionKeys = keysOf(mod)
                      const levels = offeredLevels(mod.moduleKey, actionKeys)
                      return (
                        <div key={mod.moduleKey} className={styles.closedRow}>
                          <span className={styles.closedName}>
                            <span className={styles.rowIcon}><ModuleIcon moduleKey={mod.moduleKey} size={15} /></span>
                            {mod.displayName}
                          </span>
                          <span className={styles.closedDesc}>{moduleWords(mod.moduleKey)?.blurb ?? ''}</span>
                          <select
                            className={cc.control}
                            value=""
                            aria-label={`Give access to ${mod.displayName}`}
                            onChange={e => { if (e.target.value) changeLevel(mod, e.target.value as OfferedLevel) }}
                          >
                            <option value="">Give access…</option>
                            {levels.map(l => <option key={l} value={l}>{levelLabel(mod.moduleKey, actionKeys, l)}</option>)}
                          </select>
                        </div>
                      )
                    })}
                  </div>
                )}
              </>
            )}

            {/* ── Save bar ──────────────────────────────────────────────── */}
            <div className={styles.saveBar}>
              <div className={styles.saveBarText}>
                {dirty
                  ? <>
                      <b>{changedModuleCount} {changedModuleCount === 1 ? 'module' : 'modules'} changed</b> · not saved yet
                      <ul className={styles.saveBarList}>{changeList.map(t => <li key={t}>{t}</li>)}</ul>
                    </>
                  : 'No unsaved changes'}
              </div>
              {saveError && <span className={cc.error} style={{ marginTop: 0 }}>{saveError}</span>}
              <button className="boe-btn boe-btn-ghost" onClick={discardChanges} disabled={!dirty || saving}>
                Discard
              </button>
              <button className="boe-btn boe-btn-primary" onClick={save} disabled={!dirty || saving}>
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
