'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Search, ArrowUpRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { ControlCenterSkeleton } from '@/components/layout/ControlCenterSkeleton'
import { AlertBanner, Avatar } from '@/components/ui/atoms'
import { cc, CcBadge, CcDialog, CcEmpty, CcTable, type CcTone } from '@/components/controlCenter/CcPrimitives'
import {
  moduleEnforcement,
  type EnforcementState,
} from '@/lib/permissions/enforcement'
import {
  ACCESS_LEVELS,
  ACCESS_LEVEL_LABELS,
  presetAllowedActions,
  enableModuleEntry,
  entryActionForModule,
  detectAccessLevel as detectLevelForActions,
  protectedActionsClearedByPreset,
  actionDependencyChain,
  dependentActionsToRemove,
  type AccessLevel,
  type PresetLevel,
} from '@/lib/permissions/levels'
import {
  choicesForDesired,
  protectedActionWords,
  SOURCE_LABEL,
  type OverrideChoice,
  type PermissionSource,
} from '@/lib/permissions/accessControlChanges'
import styles from './permissions.module.css'
import { useAdminMembers, useDepartments, NO_MEMBERS, NO_DEPARTMENTS } from '@/hooks/queries/useControlCenterData'

// Which modules the engine actually decides now lives in one shared place —
// src/lib/permissions/enforcement.ts — because the launcher, the route guards
// and this screen must not each keep their own opinion.

// ── Local types ───────────────────────────────────────────────────────────────

type ActionState = {
  actionKey: string
  displayName: string
  allowed: boolean
  source: PermissionSource
  sourceLabel: string
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
 * take anything away — it would just look as though it had.
 *
 * This is checked against the SELECTED employee, not the signed-in one, so it
 * protects every admin rather than only the person doing the editing.
 */
function isSystemAdmin(tree: EmployeePermissionTree | null): boolean {
  return tree?.employee.role === 'admin'
}

/**
 * Attendance and Payroll are two permission modules wearing one name.
 *
 * The launcher shows them as a single "Attendance & Payroll" card, and their
 * MANAGEMENT surface is admin-only by an explicit product decision that no grant
 * on this screen can change — see SELF_SERVICE_MODULE_KEYS and
 * resolveManagementAccess in src/lib/moduleAccess.ts. Rendering two editable
 * rows of Viewer/Contributor/Manager controls would therefore be a lie: every
 * switch would save a row that decides nothing.
 *
 * So the two modules are collapsed into one read-only row that says what is
 * actually true, and nothing on this page writes an attendance or payroll
 * override.
 */
const SELF_SERVICE_MODULE_KEYS = ['attendance', 'payroll'] as const
const COMBINED_ATTENDANCE_PAYROLL_LABEL = 'Attendance & Payroll'

function isSelfServiceModuleKey(moduleKey: string): boolean {
  return (SELF_SERVICE_MODULE_KEYS as readonly string[]).includes(moduleKey)
}

// The level vocabulary lives in src/lib/permissions/levels.ts, shared with the
// API, the tests and the capability helpers. The copy that used to sit here
// carried a sixth "Admin" level that granted EVERY action; it is gone, and
// PROTECTED_ACTIONS in levels.ts is what keeps it gone.
const LEVELS = ACCESS_LEVELS.map(key => ({ key, ...ACCESS_LEVEL_LABELS[key] }))

// Override choices are keyed "moduleKey:actionKey" because one tree holds
// every module. The write rule itself — which choice each action gets for a
// desired state — is the shared one in accessControlChanges.ts, so By Module
// cannot store something different for the same intention.
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

function detectAccessLevel(mod: ModuleState, effective: Record<string, boolean>): AccessLevel {
  return detectLevelForActions(mod.actions.map(a => a.actionKey), effective)
}

// THE PARENT GATE, as this screen reports it.
//
// Visible/Hidden is effective `view` and nothing else — the same single fact
// the launcher card and every route guard read (canAccessManagementModule in
// src/lib/permissions/moduleVisibility.ts). The screen and the running app
// therefore cannot disagree about whether a module is on. A leftover child
// grant does NOT make a module Visible; the stored child actions are kept,
// shown under Custom, and come back the moment view does.
const MODULE_ENTRY_ACTION = 'view'

/**
 * ONE module expresses entry with a different key, and the switch has to follow
 * it or it is a control that decides nothing. Customer Review Outreach
 * registers `use` and `verify` and NO `view`. entryActionForModule reads the
 * module's OWN registered actions, so this screen, enableModuleEntry and the
 * module guard cannot drift; `view` remains the answer for every other module.
 */
function entryActionFor(mod: ModuleState): string {
  return entryActionForModule(mod.actions.map(a => a.actionKey)) ?? MODULE_ENTRY_ACTION
}

/** Visible/Hidden including any unsaved change the administrator has made. */
function moduleIsAccessible(mod: ModuleState, overrides: Map<string, OverrideChoice>): boolean {
  return effectiveMapForModule(mod, overrides)[entryActionFor(mod)] === true
}

function moduleIsDirty(mod: ModuleState, overrides: Map<string, OverrideChoice>, initialOverrides: Map<string, OverrideChoice>): boolean {
  return mod.actions.some(a => {
    const key = overrideKey(mod.moduleKey, a.actionKey)
    return overrides.get(key) !== initialOverrides.get(key)
  })
}

// ── Source summary ───────────────────────────────────────────────────────────
// Plain-language explanation of *where* a module's current access is coming
// from, separate from the per-action source labels (EffectiveBadge) that stay
// in place under Custom. A coarser, module-level rollup.

type SourceSummary = { kind: 'single'; source: PermissionSource; label: string } | { kind: 'mixed' }

// A pending choice of allow/deny always reads as an employee override, matching
// how EffectiveBadge treats unsaved picks. Reverting an existing override back
// to 'inherit' can't be resolved to a real source without a save round-trip, so
// it is 'unknown' and folds into "mixed".
function effectiveSourceForAction(action: ActionState, choice: OverrideChoice): PermissionSource | 'unknown' {
  if (choice !== 'inherit') return 'employee_override'
  if (action.source !== 'employee_override') return action.source
  return 'unknown'
}

function summarizeSource(mod: ModuleState, getChoice: (actionKey: string) => OverrideChoice): SourceSummary {
  const sources = mod.actions.map(a => effectiveSourceForAction(a, getChoice(a.actionKey)))
  const unique = new Set(sources)
  const only = sources[0]
  if (unique.size === 1 && only !== 'unknown') {
    return { kind: 'single', source: only, label: SOURCE_LABEL[only] }
  }
  return { kind: 'mixed' }
}

const SOURCE_TONE: Record<PermissionSource, CcTone> = {
  employee_override: 'violet',
  department: 'blue',
  role: 'blue',
  system_default: 'gray',
}

function SourceBadge({ summary }: { summary: SourceSummary }) {
  if (summary.kind === 'mixed') return <CcBadge tone="amber">Mixed</CcBadge>
  return <CcBadge tone={SOURCE_TONE[summary.source]}>{summary.label.replace(' default', '')}</CcBadge>
}

// ── Badges ───────────────────────────────────────────────────────────────────

// The banner colour follows the badge: green only when every action really is
// enforced, so "Partly active" cannot read as a green light.
const ENFORCEMENT_BANNER_VARIANT: Record<EnforcementState, 'green' | 'amber'> = {
  enforced:  'green',
  partial:   'amber',
  prepared:  'amber',
  role_only: 'amber',
}

// THERE IS NO ENFORCEMENT BADGE ON AN EMPLOYEE'S MODULE ROW. Deliberately.
// "Active", "Partly active", "Prepared" and "Not used" describe how far a
// MODULE'S CODE has been cut over to the engine — a fact about the product,
// identical for every employee. Beside a per-employee switch it read as a
// statement about that person's access. It stays in the Change Access dialog,
// which is where "ticking Approve does nothing yet" is worth knowing.

const LEVEL_TONE: Record<AccessLevel, CcTone> = {
  no_access:   'gray',
  viewer:      'blue',
  contributor: 'blue',
  manager:     'green',
  custom:      'amber',
}

function AccessLevelBadge({ level }: { level: AccessLevel }) {
  return <CcBadge tone={LEVEL_TONE[level]}>{ACCESS_LEVEL_LABELS[level].label}</CcBadge>
}

function EffectiveBadge({ choice, action }: { choice: OverrideChoice; action: ActionState }) {
  if (choice === 'inherit') {
    if (action.source !== 'employee_override') {
      return (
        <span className={styles.actionState} style={{ color: action.allowed ? '#166534' : '#B0364A' }}>
          {action.allowed ? 'Allowed' : 'Denied'}
          <span className={cc.muted}> · Inherited from {action.sourceLabel}</span>
        </span>
      )
    }
    return <span className={`${styles.actionState} ${cc.muted}`}>Will inherit (recalculated on save)</span>
  }
  const allowed = choice === 'allow'
  return (
    <span className={styles.actionState} style={{ color: allowed ? '#166534' : '#B0364A' }}>
      {allowed ? 'Allowed' : 'Denied'}
      <span className={cc.muted}> · Employee Override</span>
    </span>
  )
}

function OverrideControl({
  value, onChange,
}: {
  value: OverrideChoice
  onChange: (v: OverrideChoice) => void
}) {
  const OPTIONS: { key: OverrideChoice; label: string; active: string }[] = [
    { key: 'inherit', label: 'Inherit', active: styles.segmentInherit },
    { key: 'allow',   label: 'Allow',   active: styles.segmentAllow },
    { key: 'deny',    label: 'Deny',    active: styles.segmentDeny },
  ]
  return (
    <div className={styles.segment} role="radiogroup">
      {OPTIONS.map(opt => (
        <button
          key={opt.key}
          type="button"
          role="radio"
          aria-checked={value === opt.key}
          onClick={() => onChange(opt.key)}
          className={`${styles.segmentBtn}${value === opt.key ? ` ${opt.active}` : ''}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// ── Change Access dialog ─────────────────────────────────────────────────────

function ChangeAccessModal({
  mod, currentLevel, getChoice, onChangeAction, onApplyLevel, onClose,
}: {
  mod: ModuleState
  currentLevel: AccessLevel
  getChoice: (actionKey: string) => OverrideChoice
  onChangeAction: (actionKey: string, choice: OverrideChoice) => void
  onApplyLevel: (level: PresetLevel) => void
  onClose: () => void
}) {
  const [mode, setMode] = useState<AccessLevel>(currentLevel)
  // A standard level the administrator has chosen but not yet confirmed,
  // because applying it would take protected permissions away.
  const [pendingLevel, setPendingLevel] = useState<PresetLevel | null>(null)

  // What this module currently grants, folding in unsaved choices — the same
  // view the level detector sees.
  const currentlyAllowed: Record<string, boolean> = {}
  for (const action of mod.actions) {
    const choice = getChoice(action.actionKey)
    currentlyAllowed[action.actionKey] = choice === 'inherit' ? action.allowed : choice === 'allow'
  }

  const actionKeys = mod.actions.map(a => a.actionKey)

  function applyLevel(level: PresetLevel) {
    onApplyLevel(level)
    onClose()
  }

  function pick(level: AccessLevel) {
    setMode(level)
    if (level === 'custom') return

    // A standard level clears every protected permission. Say which, and wait.
    // Silently keeping them would be worse (the administrator would believe
    // they had reduced someone to Viewer), and silently dropping them worse
    // still.
    const cleared = protectedActionsClearedByPreset(level, actionKeys, currentlyAllowed)
    if (cleared.length > 0) {
      setPendingLevel(level)
      return
    }
    applyLevel(level)
  }

  const sourceSummary = summarizeSource(mod, getChoice)
  const enforcement = moduleEnforcement(mod.moduleKey)

  return (
    <CcDialog
      title={mod.displayName}
      subtitle="Choose a level, or set individual permissions under Custom."
      onClose={onClose}
      footer={<button className="boe-btn boe-btn-primary" onClick={onClose}>Done</button>}
    >
      <div style={{ marginBottom: 14 }}>
        <AlertBanner variant={ENFORCEMENT_BANNER_VARIANT[moduleEnforcement(mod.moduleKey).state]}>
          {moduleEnforcement(mod.moduleKey).detail}
        </AlertBanner>
      </div>

      <div className={cc.note} style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>Current access</span>
        <AccessLevelBadge level={currentLevel} />
        <SourceBadge summary={sourceSummary} />
        <span className={cc.muted} style={{ fontSize: 12 }}>
          {sourceSummary.kind === 'single' ? `Source: ${sourceSummary.label}` : 'Some permissions are customized'}
          {enforcement.state === 'partial' && ' · Only the enforced actions decide anything today'}
        </span>
      </div>

      {pendingLevel && (
        <div className={cc.note} style={{ marginBottom: 16, borderColor: '#F0C36D', background: '#FFFBEB' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#8C6D1F', marginBottom: 6 }}>
            Changing to {ACCESS_LEVEL_LABELS[pendingLevel].label} will remove:{' '}
            {protectedActionWords(
              protectedActionsClearedByPreset(pendingLevel, actionKeys, currentlyAllowed),
              mod.moduleKey,
            )}
          </div>
          <div className={cc.muted} style={{ fontSize: 12, marginBottom: 10 }}>
            These are kept only under Custom. Choose Custom instead if this person
            should keep them.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="boe-btn boe-btn-danger"
              onClick={() => { const l = pendingLevel; setPendingLevel(null); applyLevel(l) }}
            >
              Remove and continue
            </button>
            <button
              className="boe-btn boe-btn-ghost"
              onClick={() => { setPendingLevel(null); setMode(currentLevel) }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className={styles.levelGrid} role="radiogroup" aria-label="Access level">
        {LEVELS.map(l => {
          const active = mode === l.key
          return (
            <button
              key={l.key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => pick(l.key)}
              className={`${styles.levelOption}${active ? ` ${styles.levelOptionActive}` : ''}`}
            >
              <div className={styles.levelOptionLabel}>{l.label}</div>
              <div className={styles.levelOptionDesc}>{l.description}</div>
            </button>
          )
        })}
      </div>

      {mode === 'custom' && (
        <div style={{ marginTop: 16 }}>
          {mod.actions.map(action => {
            const choice = getChoice(action.actionKey)
            return (
              <div key={action.actionKey} className={styles.actionRow}>
                <div style={{ minWidth: 160 }}>
                  <div className={styles.actionName}>{action.displayName}</div>
                  <EffectiveBadge choice={choice} action={action} />
                </div>
                <OverrideControl value={choice} onChange={v => onChangeAction(action.actionKey, v)} />
              </div>
            )
          })}
        </div>
      )}
    </CcDialog>
  )
}

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
          placeholder="Search name, department or role"
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
                <div className={styles.rowName}>{m.full_name}</div>
                <div className={styles.rowSub}>
                  {deptLabel(m.team)} · <span className={cc.cap}>{m.role}</span>{m.is_active ? '' : ' · Inactive'}
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

function WorkspaceHeader({ tree, overrides }: { tree: EmployeePermissionTree; overrides: Map<string, OverrideChoice> }) {
  const editable = tree.modules.filter(mod => !isSelfServiceModuleKey(mod.moduleKey))
  const accessible = editable.filter(mod => moduleIsAccessible(mod, overrides)).length
  const noAccess = editable.length - accessible

  return (
    <div className={styles.header}>
      <div className={styles.headerIdentity}>
        <Avatar name={tree.employee.name} size={40} />
        <div style={{ minWidth: 0 }}>
          <div className={styles.headerName}>{tree.employee.name}</div>
          <div className={styles.headerSub}>
            {tree.employee.department ?? '—'} · <span className={cc.cap}>{tree.employee.role}</span>
          </div>
        </div>
      </div>
      <div className={styles.headerStats}>
        <div className={styles.headerStat}>
          <div className={styles.headerStatValue} style={{ color: '#166534' }}>{accessible}</div>
          <div className={styles.headerStatLabel}>Visible</div>
        </div>
        <div className={styles.headerStat}>
          <div className={styles.headerStatValue} style={{ color: '#4B5563' }}>{noAccess}</div>
          <div className={styles.headerStatLabel}>Hidden</div>
        </div>
      </div>
    </div>
  )
}

// ── Module row ───────────────────────────────────────────────────────────────

function ModuleRow({
  mod, level, accessible, unsaved, locked, source, onToggle, open, onOpen,
}: {
  mod: ModuleState
  level: AccessLevel
  accessible: boolean
  unsaved: boolean
  /** True for a system Administrator — the row is read-only. */
  locked: boolean
  source: SourceSummary
  onToggle: (on: boolean) => void
  open: boolean
  onOpen: () => void
}) {
  return (
    <tr style={open ? { background: '#FAFBFC' } : undefined}>
      <td>
        <span style={{ fontWeight: 600 }}>{mod.displayName}</span>
        {unsaved && <span className={styles.unsaved}>Unsaved</span>}
      </td>
      <td>
        {/* ONE control, two halves. The switch says whether the module is on;
            the level beside it says how much. Both write the same per-action
            state, so there is no second setting to reconcile. */}
        <label className={`${styles.switch}${locked ? ` ${styles.switchLocked}` : ''}`}>
          <input
            type="checkbox"
            role="switch"
            checked={accessible}
            disabled={locked}
            onChange={e => onToggle(e.target.checked)}
            aria-label={`Module access for ${mod.displayName}`}
          />
          <span className={`${styles.switchWord} ${accessible ? styles.switchOn : styles.switchOff}`}>
            {accessible ? 'Visible' : 'Hidden'}
          </span>
        </label>
      </td>
      <td>{level === 'no_access' ? <span className={cc.faint}>—</span> : <AccessLevelBadge level={level} />}</td>
      <td><SourceBadge summary={source} /></td>
      <td className={cc.right}>
        <button
          type="button"
          className={cc.linkBtn}
          onClick={onOpen}
          disabled={locked}
          aria-haspopup="dialog"
          aria-label={`Change access level for ${mod.displayName}`}
        >
          {accessible ? 'Change level' : 'Choose level'}
        </button>
      </td>
    </tr>
  )
}

// ── Attendance & Payroll ─────────────────────────────────────────────────────
//
// One row, deliberately read-only. See SELF_SERVICE_MODULE_KEYS.

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
    <tr>
      <td>
        <span style={{ fontWeight: 600 }}>{COMBINED_ATTENDANCE_PAYROLL_LABEL}</span>
        <div className={cc.muted} style={{ fontSize: 11.5, marginTop: 2, lineHeight: 1.45 }}>
          Employees can view their own attendance and payroll and raise issues.
          {' '}Management access is restricted to system administrators.
        </div>
        {strayOverrides.length > 0 && (
          <div className={cc.note} style={{ marginTop: 8, fontSize: 11.5, color: '#8C6D1F', borderColor: '#F0C36D', background: '#FFFBEB', padding: '6px 10px' }}>
            <strong>Unused permissions on record:</strong> {strayOverrides.join(', ')}.
            These grant nothing — management access is admin-only — and have been
            left exactly as they are.
          </div>
        )}
      </td>
      <td><CcBadge tone="blue">Self-service</CcBadge></td>
      <td><span className={cc.faint}>—</span></td>
      <td><CcBadge tone="gray">System role</CcBadge></td>
      <td className={cc.right}><span className={cc.faint}>Admin only</span></td>
    </tr>
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

  const [changeModalModuleKey, setChangeModalModuleKey] = useState<string | null>(null)

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
      m.role?.toLowerCase().includes(q)
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, members, depts])

  // ── Load an employee's permission tree ──────────────────────────────────
  //
  // THE ONLY READ OF THE TREE ROUTE, and it happens when an employee is opened.
  // The directory used to prefetch up to twenty trees on load to draw a
  // decorative "x of y modules" beside each name; that counter is gone, and the
  // workspace header states the same two numbers for the person who is open.
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
    setChangeModalModuleKey(null)
    // The selection is in the URL so it can be linked to (By Module's "Open"
    // lands here) and survives a refresh. Replaced, not pushed: walking a
    // directory is not a history of pages.
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
      setChangeModalModuleKey(null)
    } finally {
      setTreeLoading(false)
    }
  }

  function changeOverride(moduleKey: string, actionKey: string, choice: OverrideChoice) {
    setOverrides(prev => {
      const next = new Map(prev)
      const mod = tree?.modules.find(item => item.moduleKey === moduleKey)
      next.set(overrideKey(moduleKey, actionKey), choice)
      if (!mod || choice === 'inherit') return next

      const actionKeys = mod.actions.map(action => action.actionKey)
      const effective = effectiveMapForModule(mod, prev)

      if (choice === 'allow') {
        for (const dependency of actionDependencyChain(actionKey)) {
          if (actionKeys.includes(dependency) && effective[dependency] !== true) {
            next.set(overrideKey(moduleKey, dependency), 'allow')
          }
        }
      } else {
        for (const dependent of dependentActionsToRemove(actionKey, actionKeys)) {
          next.set(overrideKey(moduleKey, dependent), 'deny')
        }
      }

      return next
    })
  }

  // The ONE place per-action override state is written.
  //
  // `deriveDesired` receives the module's current effective map — including any
  // unsaved edits — and returns the intended one. Splitting "what do we want"
  // from "how is it stored" is what lets the level buttons and the Module access
  // switch share a write path while holding genuinely different intentions: a
  // level states every action, the switch states only `view`.
  //
  // The current map is read from `prev` INSIDE the updater rather than from the
  // `overrides` closure, so two edits applied in the same tick cannot read a
  // stale map and undo one another. How each action's choice is decided is the
  // shared rule in accessControlChanges.ts (choicesForDesired), which By Module
  // uses too.
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

  // Picking a standard level. A preset is a COMPLETE statement about the module,
  // so it ignores what is currently held — that is the whole point of choosing
  // "Viewer", and it is why moving somebody down to it revokes what they had.
  function applyAccessLevel(mod: ModuleState, level: PresetLevel) {
    const actionKeys = mod.actions.map(a => a.actionKey)
    applyDesiredActions(mod, () => presetAllowedActions(level, actionKeys))
  }

  /**
   * Module access, on or off. The switch is NOT a second authority; it is a
   * shortcut into the same per-action override state the level selector
   * writes:
   *
   *   Off  →  no_access            (every action for this module set to deny)
   *   On   →  enableModuleEntry    (`view` true, every other action untouched)
   *
   * THE TWO DIRECTIONS ARE NOT SYMMETRICAL, on purpose. OFF is a complete
   * statement, so it applies the no_access preset, and because that removes
   * things it asks first and names them. ON is the smallest possible statement
   * — let this person in — and says nothing about what they may do once
   * inside. It used to apply the Viewer preset, which wrote an explicit deny
   * over every child action the employee held; that is what erased Aditya's
   * Sample Tracking dispatch, receive and mark_lost in production. There is
   * deliberately NO confirmation on ON: it removes nothing.
   */
  function toggleModuleAccess(mod: ModuleState, on: boolean) {
    const actionKeys = mod.actions.map(a => a.actionKey)

    if (!on) {
      const effective = effectiveMapForModule(mod, overrides)
      const cleared = protectedActionsClearedByPreset('no_access', actionKeys, effective)
      if (cleared.length > 0) {
        const message =
          `Turning off ${mod.displayName} will remove: ${protectedActionWords(cleared, mod.moduleKey)}.\n\n` +
          'Continue?'
        if (!window.confirm(message)) return
      }
      applyAccessLevel(mod, 'no_access')
      return
    }

    // Entry only. Every child action keeps exactly the value it already had, so
    // an employee holding protected actions comes back as Custom rather than
    // being flattened to Viewer.
    applyDesiredActions(mod, current => enableModuleEntry(actionKeys, current))
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

  const changedModuleCount = tree
    ? tree.modules.filter(mod => moduleIsDirty(mod, overrides, initialOverrides)).length
    : 0

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
  }

  // ── Save ─────────────────────────────────────────────────────────────────
  async function save() {
    if (!selectedEmployeeId || !tree) return
    // A system Administrator's authority comes from users.role. The grid is
    // disabled for them, and this is the second gate: no request is built, so
    // there is nothing to send even if the UI were bypassed.
    if (isSystemAdmin(tree)) return

    const changes: { moduleKey: string; actionKey: string; allowed: boolean | null }[] = []
    for (const mod of tree.modules) {
      for (const action of mod.actions) {
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
    } finally {
      setSaving(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) return <ControlCenterSkeleton />

  const changeModalModule = changeModalModuleKey
    ? tree?.modules.find(m => m.moduleKey === changeModalModuleKey) ?? null
    : null

  const adminLocked = isSystemAdmin(tree)
  const selfServiceModules = tree?.modules.filter(m => isSelfServiceModuleKey(m.moduleKey)) ?? []
  const editableModules = tree?.modules.filter(m => !isSelfServiceModuleKey(m.moduleKey)) ?? []

  return (
    <>
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
              hint="Or look at one module across everyone under Access › By Module."
            />
          )}

          {selectedEmployeeId && treeLoading && <ControlCenterSkeleton />}

          {selectedEmployeeId && !treeLoading && treeError && (
            <div className={cc.error}>{treeError}</div>
          )}

          {selectedEmployeeId && !treeLoading && tree && (
            <>
              <WorkspaceHeader tree={tree} overrides={overrides} />

              {adminLocked && (
                <div style={{ marginBottom: 12 }}>
                  <AlertBanner variant="amber">
                    <strong>System Administrator.</strong> Module access is controlled by
                    this person&apos;s system role, not by the settings below. An override
                    saved here could neither add to their authority nor reduce it.
                  </AlertBanner>
                </div>
              )}

              <CcTable>
                <thead>
                  <tr>
                    <th>Module</th>
                    <th>Access</th>
                    <th>Level</th>
                    <th>Source</th>
                    <th className={cc.right}></th>
                  </tr>
                </thead>
                <tbody>
                  {editableModules.map(mod => {
                    const effective = effectiveMapForModule(mod, overrides)
                    const level = detectAccessLevel(mod, effective)
                    const accessible = moduleIsAccessible(mod, overrides)
                    const unsaved = moduleIsDirty(mod, overrides, initialOverrides)
                    const source = summarizeSource(mod, actionKey => overrides.get(overrideKey(mod.moduleKey, actionKey)) ?? 'inherit')
                    return (
                      <ModuleRow
                        key={mod.moduleKey}
                        mod={mod}
                        level={level}
                        accessible={accessible}
                        unsaved={unsaved}
                        locked={adminLocked}
                        source={source}
                        onToggle={on => toggleModuleAccess(mod, on)}
                        open={changeModalModuleKey === mod.moduleKey}
                        onOpen={() => { if (!adminLocked) setChangeModalModuleKey(mod.moduleKey) }}
                      />
                    )
                  })}
                  {/* Attendance & Payroll is one row, and it is not editable —
                      see SELF_SERVICE_MODULE_KEYS above. It is rendered from the
                      two underlying modules but writes neither. */}
                  {selfServiceModules.length > 0 && (
                  <AttendancePayrollCard modules={selfServiceModules} />
                  )}
                </tbody>
              </CcTable>

              <div className={cc.muted} style={{ fontSize: 11.5, marginTop: 8 }}>
                Visible means this person can open the module. The level says how much they can do inside it; Custom keeps individually chosen permissions.
                {' '}<Link href="/admin/control-center/permissions/modules" className={cc.linkBtn}>See one module across everyone <ArrowUpRight size={11} style={{ verticalAlign: '-1px' }} /></Link>
              </div>

              {/* ── Save bar ──────────────────────────────────────────────── */}
              <div className={styles.saveBar}>
                <span className={styles.saveBarText}>
                  {dirty
                    ? `${changedModuleCount} ${changedModuleCount === 1 ? 'module' : 'modules'} changed · not saved yet`
                    : 'No unsaved changes'}
                </span>
                {saveError && <span className={cc.error} style={{ marginTop: 0 }}>{saveError}</span>}
                <span className={styles.saveBarSpacer} />
                <button className="boe-btn boe-btn-ghost" onClick={discardChanges} disabled={!dirty || saving}>
                  Discard
                </button>
                <button className="boe-btn boe-btn-primary" onClick={save} disabled={!dirty || saving}>
                  {saving ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Change Access dialog ───────────────────────────────────────────── */}
      {changeModalModule && (
        <ChangeAccessModal
          mod={changeModalModule}
          currentLevel={detectAccessLevel(changeModalModule, effectiveMapForModule(changeModalModule, overrides))}
          getChoice={actionKey => overrides.get(overrideKey(changeModalModule.moduleKey, actionKey)) ?? 'inherit'}
          onChangeAction={(actionKey, choice) => changeOverride(changeModalModule.moduleKey, actionKey, choice)}
          onApplyLevel={level => applyAccessLevel(changeModalModule, level)}
          onClose={() => setChangeModalModuleKey(null)}
        />
      )}
    </>
  )
}
