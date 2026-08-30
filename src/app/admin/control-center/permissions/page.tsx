'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Search, CheckCircle2, Circle, LayoutGrid,
  ListChecks, Package, Laptop2, CalendarCheck, Wallet, QrCode, Users, TrendingUp, Landmark, Truck, MessageSquareHeart,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { ControlCenterLayout } from '@/components/layout/ControlCenterLayout'
import { LoadingScreen, EmptyState, AlertBanner, Avatar } from '@/components/ui/atoms'
import { useViewAs } from '@/hooks/useViewAs'
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
import styles from './permissions.module.css'

// Which modules the engine actually decides now lives in one shared place —
// src/lib/permissions/enforcement.ts — because the launcher, the route guards
// and this screen must not each keep their own opinion. The set that used to
// sit here said only enforced/not-enforced, which could not describe Orders
// (module entry is enforced, everything inside is still users.role) and had
// gone stale on Meetings (fully enforced since 20260814000000, still shown as
// "Prepared").

// ── Local types ───────────────────────────────────────────────────────────────

type Department = {
  id: string
  department_key: string
  department_name: string
  is_active: boolean
}

type PermissionSource = 'system_default' | 'role' | 'department' | 'employee_override'

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

// override choice per "moduleKey:actionKey" — 'inherit' means no employee override
type OverrideChoice = 'inherit' | 'allow' | 'deny'

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
// API, the tests and the capability helpers.
//
// The copy that used to sit here carried a sixth "Admin" level that granted
// EVERY action, delete and assign included — the one shape through which a
// protected permission could be handed out by picking a label off a list. It is
// gone, and PROTECTED_ACTIONS in levels.ts is what keeps it gone.
const LEVELS = ACCESS_LEVELS.map(key => ({ key, ...ACCESS_LEVEL_LABELS[key] }))

// presetAllowedActions and the level detector are imported from
// src/lib/permissions/levels.ts. detectAccessLevel here is a thin adapter that
// feeds this page's ModuleState into the shared detector, so the screen and the
// save handler can never disagree about what a level means.
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
// the launcher card and every route guard now read (canAccessManagementModule
// in src/lib/permissions/moduleVisibility.ts). The screen and the running app
// therefore cannot disagree about whether a module is on.
//
// It used to be "any action of this module is allowed". That is what let a card
// say Hidden next to the switch while still counting as accessible in the
// header tally: a leftover child grant satisfied it. Aditya's Sample Tracking
// is exactly that shape — dispatch/receive/mark_lost allowed, view denied — and
// it must read as Hidden, because it is.
//
// The stored child actions are NOT removed and are still shown inside the
// Custom modal. They are dormant, and they come back the moment view does.
const MODULE_ENTRY_ACTION = 'view'

/**
 * ONE module expresses entry with a different key, and the switch has to follow
 * it or it is a control that decides nothing.
 *
 * Customer Review Outreach registers `use` and `verify` and NO `view`
 * (src/lib/permissions/modules.ts): a holder sees only their own outreach, so a
 * separate read-only grant would name an empty screen. Without this resolution
 * its card would read Hidden however much access the employee actually held,
 * and turning the switch On would write nothing at all.
 *
 * entryActionForModule reads the module's OWN registered actions rather than a
 * key-to-key map here, so the answer comes from one place —
 * MODULE_ENTRY_ACTIONS in ./levels — and this screen, enableModuleEntry and the
 * module guard cannot drift. `view` remains the answer for every other module,
 * which is why MODULE_ENTRY_ACTION above is still the fallback.
 */
function entryActionFor(mod: ModuleState): string {
  return entryActionForModule(mod.actions.map(a => a.actionKey)) ?? MODULE_ENTRY_ACTION
}

/** Visible/Hidden including any unsaved change the administrator has made. */
function moduleIsAccessible(mod: ModuleState, overrides: Map<string, OverrideChoice>): boolean {
  return effectiveMapForModule(mod, overrides)[entryActionFor(mod)] === true
}

/** Visible/Hidden as last loaded from the server, for the employee-list counters. */
function moduleIsAccessibleAsLoaded(mod: ModuleState): boolean {
  const entry = entryActionFor(mod)
  return mod.actions.some(a => a.actionKey === entry && a.allowed)
}

function moduleIsDirty(mod: ModuleState, overrides: Map<string, OverrideChoice>, initialOverrides: Map<string, OverrideChoice>): boolean {
  return mod.actions.some(a => {
    const key = overrideKey(mod.moduleKey, a.actionKey)
    return overrides.get(key) !== initialOverrides.get(key)
  })
}

// A module counts as "accessible" for the employee-list/workspace counters when
// its parent gate is open — effective `view` — and not merely when some child
// action survives. See moduleIsAccessibleAsLoaded below.
type ModuleCount = { allowed: number; total: number }

function accessibleModuleCount(modules: ModuleState[]): ModuleCount {
  return {
    allowed: modules.filter(moduleIsAccessibleAsLoaded).length,
    total: modules.length,
  }
}

// ── Source summary (Change Access modal header) ─────────────────────────────
// Plain-language explanation of *where* a module's current access is coming
// from, separate from the existing per-action source labels (EffectiveBadge)
// which stay in place under Custom. This is a coarser, module-level rollup.

const SOURCE_SUMMARY_LABEL: Record<PermissionSource, string> = {
  employee_override: 'Employee override',
  department: 'Department default',
  role: 'Role default',
  system_default: 'System default',
}

type SourceSummary = { kind: 'single'; label: string } | { kind: 'mixed' }

// A pending choice of allow/deny (whether from Custom or from picking a
// preset) always reads as an employee override, matching how EffectiveBadge
// already treats unsaved allow/deny picks. Reverting an existing override
// back to 'inherit' can't be resolved to a real source without a save
// round-trip, so it's treated as 'unknown' and folds into "mixed" below —
// same caution EffectiveBadge takes ("Will inherit (recalculated on save)").
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
    return { kind: 'single', label: SOURCE_SUMMARY_LABEL[only] }
  }
  return { kind: 'mixed' }
}

// ── Style helpers (matches src/app/admin/control-center/page.tsx) ──────────────

const SECTION_LABEL: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.07em',
  color: '#8C94A6',
  textTransform: 'uppercase',
  marginBottom: 12,
}

const INPUT: React.CSSProperties = {
  width: '100%',
  padding: '9px 11px',
  fontSize: 13,
  border: '1.5px solid #D1D5DB',
  borderRadius: 8,
  background: '#fff',
  color: '#111318',
  outline: 'none',
  boxSizing: 'border-box',
}

const ACTION_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '11px 0',
  borderTop: '1px solid #F0F2F5',
  gap: 12,
  flexWrap: 'wrap',
}

const CHANGE_BTN: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#fff',
  background: '#1A2035',
  border: 'none',
  borderRadius: 7,
  padding: '7px 16px',
  cursor: 'pointer',
  flexShrink: 0,
}

const MODAL_OVERLAY: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.35)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: 16,
}

const MODAL_BOX: React.CSSProperties = {
  background: '#fff',
  borderRadius: 14,
  padding: '24px 26px',
  width: 520,
  maxWidth: 'calc(100vw - 32px)',
  maxHeight: '85vh',
  overflowY: 'auto',
  boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
}

const MODAL_TITLE: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  color: '#111318',
  marginBottom: 14,
}

const LEVEL_GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))',
  gap: 8,
}

const LEVEL_OPTION: React.CSSProperties = {
  textAlign: 'left',
  border: '1.5px solid #D1D5DB',
  borderRadius: 8,
  padding: '10px 12px',
  background: '#fff',
  cursor: 'pointer',
}

const LEVEL_OPTION_ACTIVE: React.CSSProperties = {
  border: '1.5px solid #1A2035',
  background: '#EEF0F4',
}

const LEVEL_OPTION_LABEL: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: '#111318',
  marginBottom: 2,
}

const LEVEL_OPTION_DESC: React.CSSProperties = {
  fontSize: 11,
  color: '#6B7384',
  lineHeight: 1.35,
}

// ── Module icons ─────────────────────────────────────────────────────────────
// Purely decorative, per-module glyphs for the card grid — matches the icon
// language already used for these same module_key values on /modules.

const MODULE_ICONS: Record<string, React.ComponentType<{ size?: number; strokeWidth?: number; color?: string }>> = {
  task_management:  ListChecks,
  sample_tracking:  Package,
  assets_access:    Laptop2,
  attendance:       CalendarCheck,
  payroll:          Wallet,
  showroom_qr:      QrCode,
  employee_records: Users,
  performance:      TrendingUp,
  finance:          Landmark,
  orders:           Truck,
  customer_review_requests: MessageSquareHeart,
}

function ModuleIcon({ moduleKey, color }: { moduleKey: string; color: string }) {
  const Icon = MODULE_ICONS[moduleKey] ?? LayoutGrid
  return <Icon size={24} strokeWidth={1.75} color={color} />
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

// THERE IS NO ENFORCEMENT BADGE ON AN EMPLOYEE'S MODULE CARD. Deliberately.
//
// "Active", "Partly active", "Prepared" and "Not used" describe how far a
// MODULE'S CODE has been cut over to the permission engine. They are a fact
// about the product, identical for every employee, and they were being rendered
// beside a per-employee switch — so a card could read "Hidden · Partly active"
// and an administrator would reasonably read the second half as a statement
// about that person's access. It is not one.
//
// The information is not lost: moduleEnforcement() still drives the banner at
// the top of the Change Access modal (ENFORCEMENT_BANNER_VARIANT below), which
// is where it belongs — the moment an administrator is choosing individual
// actions is exactly when "ticking Approve does nothing yet" is worth knowing.
//
// An employee card now says three things and no more: enabled or disabled,
// Visible or Hidden, and — when enabled — the access level.

// Protected permissions are named in plain words in the confirmation, because
// "assign" on its own does not tell an administrator what they are about to
// take away from Aditya.
const PROTECTED_ACTION_WORDS: Record<string, string> = {
  assign:                'Assign assets',
  manage:                'Manage',
  delete:                'Delete',
  admin:                 'Admin',
  dispatch:              'Dispatch',
  receive:               'Receive',
  mark_lost:             'Mark lost',
  close:                 'Close',
  // can_be_order_assignee is NOT here. It named Order Request assignees, and
  // the module no longer registers it — an entry would label an option that is
  // never offered. A grant made before the retirement is not deleted; it is
  // simply read by nothing.
  view_quotations:       'View quotations and quoted prices',
  manage_quotations:     'Manage quotations',
  // Customer Review Outreach. `use` is not protected — it is that module's
  // entry — so only the sign-off authority needs naming here.
  verify:                'Verify and close customer review requests',
  // One action key registered against two modules, so the words have to come
  // from the module being edited rather than from this map alone — see
  // protectedActionWords, which takes the module key for exactly this reason.
  view_all:              'View all records',
}

// `view_all` means something different in Orders than in Finance, and an
// administrator removing it deserves to read which one they are removing.
const MODULE_SCOPED_ACTION_WORDS: Record<string, Record<string, string>> = {
  orders:  { view_all: 'View all company orders' },
  finance: { view_all: 'View all company payments and finance information' },
}

function protectedActionWords(actionKeys: string[], moduleKey?: string): string {
  const scoped = moduleKey ? MODULE_SCOPED_ACTION_WORDS[moduleKey] : undefined
  const names = actionKeys.map(k => scoped?.[k] ?? PROTECTED_ACTION_WORDS[k] ?? k)
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

const LEVEL_BADGE_META: Record<AccessLevel, { label: string; color: string; bg: string }> = {
  no_access:   { label: 'No Access',   color: '#4B5563', bg: '#F3F4F6' },
  viewer:      { label: 'Viewer',      color: '#1E40AF', bg: '#EFF6FF' },
  contributor: { label: 'Contributor', color: '#4338CA', bg: '#EEF2FF' },
  manager:     { label: 'Manager',     color: '#0F766E', bg: '#F0FDFA' },
  custom:    { label: 'Custom',    color: '#8C6D1F', bg: '#FFFBEB' },
}

function AccessLevelBadge({ level }: { level: AccessLevel }) {
  const m = LEVEL_BADGE_META[level]
  return (
    <span style={{
      fontSize: 11, fontWeight: 700,
      color: m.color, background: m.bg,
      borderRadius: 5, padding: '2px 8px',
    }}>
      {m.label}
    </span>
  )
}

function EffectiveBadge({ choice, action }: { choice: OverrideChoice; action: ActionState }) {
  if (choice === 'inherit') {
    if (action.source !== 'employee_override') {
      return (
        <span style={{ fontSize: 12, color: action.allowed ? '#166534' : '#B0364A' }}>
          {action.allowed ? 'Allowed' : 'Denied'}
          <span style={{ color: '#8C94A6' }}> · Inherited from {action.sourceLabel}</span>
        </span>
      )
    }
    return <span style={{ fontSize: 12, color: '#8C94A6' }}>Will inherit (recalculated on save)</span>
  }
  const allowed = choice === 'allow'
  return (
    <span style={{ fontSize: 12, color: allowed ? '#166534' : '#B0364A' }}>
      {allowed ? 'Allowed' : 'Denied'}
      <span style={{ color: '#8C94A6' }}> · Employee Override</span>
    </span>
  )
}

function OverrideControl({
  value, onChange,
}: {
  value: OverrideChoice
  onChange: (v: OverrideChoice) => void
}) {
  const OPTIONS: { key: OverrideChoice; label: string }[] = [
    { key: 'inherit', label: 'Inherit' },
    { key: 'allow', label: 'Allow' },
    { key: 'deny', label: 'Deny' },
  ]
  return (
    <div style={{ display: 'flex', border: '1.5px solid #D1D5DB', borderRadius: 8, overflow: 'hidden' }}>
      {OPTIONS.map((opt, i) => {
        const active = value === opt.key
        const activeColor = opt.key === 'allow' ? '#166534' : opt.key === 'deny' ? '#B0364A' : '#1A2035'
        const activeBg = opt.key === 'allow' ? '#F0FDF4' : opt.key === 'deny' ? '#FDF1F3' : '#EEF0F4'
        return (
          <button
            key={opt.key}
            onClick={() => onChange(opt.key)}
            style={{
              padding: '5px 12px',
              fontSize: 12,
              fontWeight: 600,
              border: 'none',
              borderLeft: i > 0 ? '1.5px solid #D1D5DB' : 'none',
              background: active ? activeBg : '#fff',
              color: active ? activeColor : '#6B7384',
              cursor: 'pointer',
            }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

// ── Change Access modal ──────────────────────────────────────────────────────

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

  return (
    <div style={MODAL_OVERLAY} onClick={onClose}>
      <div style={MODAL_BOX} onClick={e => e.stopPropagation()}>
        <div style={MODAL_TITLE}>{mod.displayName} — Change Access</div>

        <div style={{ marginBottom: 16 }}>
          <AlertBanner variant={ENFORCEMENT_BANNER_VARIANT[moduleEnforcement(mod.moduleKey).state]}>
            {moduleEnforcement(mod.moduleKey).detail}
          </AlertBanner>
        </div>

        <div style={{
          marginBottom: 18, padding: '12px 14px', border: '1px solid #E8EBF0',
          borderRadius: 10, background: '#FAFBFC',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#4B5563' }}>Current access:</span>
            <AccessLevelBadge level={currentLevel} />
          </div>
          <div style={{ fontSize: 12, color: '#6B7384' }}>
            {sourceSummary.kind === 'single'
              ? `Source: ${sourceSummary.label}`
              : 'Some permissions are customized'}
          </div>
        </div>

        {pendingLevel && (
          <div
            style={{
              marginBottom: 16, padding: '12px 14px', borderRadius: 10,
              border: '1px solid #F0C36D', background: '#FFFBEB',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: '#8C6D1F', marginBottom: 6 }}>
              Changing to {ACCESS_LEVEL_LABELS[pendingLevel].label} will remove:{' '}
              {protectedActionWords(
                protectedActionsClearedByPreset(pendingLevel, actionKeys, currentlyAllowed),
                mod.moduleKey,
              )}
            </div>
            <div style={{ fontSize: 12, color: '#6B7384', marginBottom: 10 }}>
              These are kept only under Custom. Choose Custom instead if this person
              should keep them.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="boe-btn boe-btn-primary"
                style={{ fontSize: 12, padding: '5px 12px' }}
                onClick={() => { const l = pendingLevel; setPendingLevel(null); applyLevel(l) }}
              >
                Remove and continue
              </button>
              <button
                className="boe-btn boe-btn-ghost"
                style={{ fontSize: 12, padding: '5px 12px' }}
                onClick={() => { setPendingLevel(null); setMode(currentLevel) }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div style={LEVEL_GRID}>
          {LEVELS.map(l => {
            const active = mode === l.key
            return (
              <button
                key={l.key}
                onClick={() => pick(l.key)}
                style={{ ...LEVEL_OPTION, ...(active ? LEVEL_OPTION_ACTIVE : null) }}
              >
                <div style={LEVEL_OPTION_LABEL}>{l.label}</div>
                <div style={LEVEL_OPTION_DESC}>{l.description}</div>
              </button>
            )
          })}
        </div>

        {mode === 'custom' && (
          <div style={{ marginTop: 18 }}>
            {mod.actions.map(action => {
              const choice = getChoice(action.actionKey)
              return (
                <div key={action.actionKey} style={ACTION_ROW}>
                  <div style={{ minWidth: 140 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#111318' }}>{action.displayName}</div>
                    <EffectiveBadge choice={choice} action={action} />
                  </div>
                  <OverrideControl value={choice} onChange={v => onChangeAction(action.actionKey, v)} />
                </div>
              )
            })}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button style={CHANGE_BTN} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}

/**
 * How many employees' access counters are prefetched on load.
 *
 * A bound on REQUESTS, never on what the directory shows. See the note on
 * countPrefetchTargets.
 */
const COUNT_PREFETCH_LIMIT = 20

// ── Employee panel (left column) ────────────────────────────────────────────

function EmployeePanel({
  search, onSearchChange, results, selectedEmployeeId, onSelect, moduleCounts, deptLabel,
}: {
  search: string
  onSearchChange: (v: string) => void
  results: UserProfile[]
  selectedEmployeeId: string | null
  onSelect: (id: string) => void
  moduleCounts: Map<string, ModuleCount>
  deptLabel: (key: string | null | undefined) => string
}) {
  return (
    <div className={styles.employeePanel}>
      <div style={SECTION_LABEL}>Employees</div>

      <div style={{ position: 'relative' }}>
        <Search
          size={14} strokeWidth={2}
          style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#8C94A6', pointerEvents: 'none' }}
        />
        <input
          style={{ ...INPUT, paddingLeft: 30 }}
          placeholder="Search by name, department, or role…"
          aria-label="Search employees"
          value={search}
          onChange={e => onSearchChange(e.target.value)}
        />
      </div>

      {/* A plain count, so an administrator can see the list is the whole
          directory rather than a window onto it. This panel used to show the
          first twenty people and say nothing about the rest. */}
      {results.length > 0 && (
        <div style={{ padding: '6px 4px 2px', fontSize: 11.5, color: '#8C94A6' }}>
          {results.length} {results.length === 1 ? 'employee' : 'employees'}
        </div>
      )}

      <div className={styles.employeeList}>
        {results.length === 0 && (
          <div style={{ padding: '14px 4px', fontSize: 13, color: '#8C94A6' }}>No matches.</div>
        )}
        {results.map(m => {
          const selected = m.id === selectedEmployeeId
          const count = moduleCounts.get(m.id)
          return (
            <button
              key={m.id}
              type="button"
              className={`${styles.empRow}${selected ? ` ${styles.selected}` : ''}`}
              aria-pressed={selected}
              onClick={() => onSelect(m.id)}
            >
              <Avatar name={m.full_name} size={32} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{
                  fontSize: 13, fontWeight: 600, color: '#111318',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {m.full_name}
                </div>
                <div style={{
                  fontSize: 11.5, color: '#8C94A6',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {deptLabel(m.team)} · <span style={{ textTransform: 'capitalize' }}>{m.role}</span>
                </div>
              </div>
              <div style={{ fontSize: 11, color: '#8C94A6', fontWeight: 600, flexShrink: 0, textAlign: 'right', whiteSpace: 'nowrap' }}>
                {count ? `${count.allowed} of ${count.total}` : '···'}
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
  const total = tree.modules.length
  const accessible = tree.modules.filter(mod => moduleIsAccessible(mod, overrides)).length
  const noAccess = total - accessible

  return (
    <div style={{ background: '#fff', border: '1px solid #E8EBF0', borderRadius: 14, padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Avatar name={tree.employee.name} size={40} />
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#111318' }}>{tree.employee.name}</div>
            <div style={{ fontSize: 12, color: '#6B7384', marginTop: 2 }}>
              {tree.employee.department ?? '—'} · <span style={{ textTransform: 'capitalize' }}>{tree.employee.role}</span>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 20 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#166534' }}>{accessible}</div>
            <div style={{ fontSize: 10.5, color: '#8C94A6', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Accessible</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#4B5563' }}>{noAccess}</div>
            <div style={{ fontSize: 10.5, color: '#8C94A6', textTransform: 'uppercase', letterSpacing: '0.04em' }}>No Access</div>
          </div>
        </div>
      </div>
      <div style={{ marginTop: 12, fontSize: 12, color: '#6B7384' }}>
        Green modules are accessible. White modules are not accessible.
      </div>
    </div>
  )
}

// ── Module card ──────────────────────────────────────────────────────────────

function ModuleCard({
  mod, level, accessible, unsaved, locked, onToggle, open, onOpen,
}: {
  mod: ModuleState
  level: AccessLevel
  accessible: boolean
  unsaved: boolean
  /** True for a system Administrator — the row is read-only. */
  locked: boolean
  onToggle: (on: boolean) => void
  open: boolean
  onOpen: () => void
}) {
  return (
    <div
      className={`${styles.moduleCard}${accessible ? ` ${styles.granted}` : ''}${open ? ` ${styles.open}` : ''}`}
      style={locked ? { opacity: 0.6 } : undefined}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <ModuleIcon moduleKey={mod.moduleKey} color={accessible ? '#166534' : '#8C94A6'} />
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          {unsaved && (
            <span style={{ fontSize: 9.5, fontWeight: 700, color: '#8C6D1F', letterSpacing: '0.03em' }}>UNSAVED</span>
          )}
        </div>
      </div>

      <div>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: '#111318', marginBottom: level !== 'no_access' ? 6 : 0 }}>
          {mod.displayName}
        </div>
        {level !== 'no_access' && <AccessLevelBadge level={level} />}
      </div>

      {/* ONE control, two halves. The switch says whether the module is on;
          the button underneath says how much. Both write the same per-action
          state, so there is no second setting to reconcile. */}
      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            cursor: locked ? 'default' : 'pointer',
          }}
        >
          <input
            type="checkbox"
            role="switch"
            checked={accessible}
            disabled={locked}
            onChange={e => onToggle(e.target.checked)}
            aria-label={`Module access for ${mod.displayName}`}
            style={{ width: 16, height: 16, cursor: locked ? 'default' : 'pointer' }}
          />
          <span style={{ fontSize: 11, fontWeight: 600, color: '#6B7384' }}>Module access</span>
          <span
            style={{
              fontSize: 11, fontWeight: 700,
              color: accessible ? '#166534' : '#6B7384',
              display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            {accessible
              ? <CheckCircle2 size={13} strokeWidth={2} color="#166534" />
              : <Circle size={13} strokeWidth={2} color="#B7BEC9" />}
            {accessible ? 'Visible' : 'Hidden'}
          </span>
        </label>

        <button
          type="button"
          onClick={onOpen}
          disabled={locked}
          aria-haspopup="dialog"
          aria-label={`Change access level for ${mod.displayName}`}
          style={{
            fontSize: 11.5, fontWeight: 600, color: locked ? '#A0A9BE' : '#1A2035',
            background: 'transparent', border: '1px solid #E8EBF0', borderRadius: 7,
            padding: '4px 9px', cursor: locked ? 'default' : 'pointer', textAlign: 'left',
          }}
        >
          {accessible ? 'Change level or permissions' : 'Choose access level'}
        </button>
      </div>
    </div>
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
    <div className={styles.moduleCard} style={{ cursor: 'default' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <ModuleIcon moduleKey="attendance" color="#8C94A6" />
      </div>

      <div>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: '#111318', marginBottom: 6 }}>
          {COMBINED_ATTENDANCE_PAYROLL_LABEL}
        </div>
        <span
          style={{
            fontSize: 10, fontWeight: 700, color: '#1E40AF', background: '#EFF6FF',
            borderRadius: 5, padding: '2px 7px',
          }}
        >
          Self-service
        </span>
      </div>

      <div style={{ marginTop: 'auto', fontSize: 11.5, color: '#6B7384', lineHeight: 1.5 }}>
        Employees can view their own attendance and payroll and raise issues.
        <br />
        Management access is restricted to system administrators.
      </div>

      {strayOverrides.length > 0 && (
        <div
          style={{
            marginTop: 8, fontSize: 11, color: '#8C6D1F',
            background: '#FFFBEB', border: '1px solid #F0C36D',
            borderRadius: 7, padding: '6px 8px', lineHeight: 1.45,
          }}
        >
          <strong>Unused permissions on record:</strong> {strayOverrides.join(', ')}.
          These grant nothing — management access is admin-only — and have been
          left exactly as they are.
        </div>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PermissionsPage() {
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { viewAsUserId, exitViewMode } = useViewAs()

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [token,   setToken]   = useState('')
  const [loading, setLoading] = useState(true)

  const [members, setMembers] = useState<UserProfile[]>([])
  const [depts,   setDepts]   = useState<Department[]>([])

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

  // Per-employee "X of Y modules" counters shown in the employee list.
  // Lazily filled in by re-using the same per-employee tree endpoint the
  // workspace already calls on selection — no new API, just more reads of
  // the existing one, bounded to whatever's currently visible in the list.
  const [moduleCounts, setModuleCounts] = useState<Map<string, ModuleCount>>(new Map())

  // Every employee id ever requested (by either the list effect below or
  // loadTree), regardless of outcome. Never cleared, so each employee is
  // asked for at most once per page session — a failed request is not
  // retried just because the same row scrolls back into a search result.
  const requestedCountIds = useRef<Set<string>>(new Set())

  // ── Init ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: p } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, is_active, created_at')
        .eq('id', session.user.id)
        .single()

      if (p?.role !== 'admin') { router.push('/dashboard'); return }
      if (viewAsUserId) { exitViewMode(); router.push('/dashboard'); return }

      setProfile(p as UserProfile)
      setToken(session.access_token)

      const hdrs = { Authorization: `Bearer ${session.access_token}` }

      const [membersRes, deptsRes] = await Promise.all([
        fetch('/api/admin-members',              { headers: hdrs }).then(r => r.json()),
        fetch('/api/control-center/departments', { headers: hdrs }).then(r => r.json()),
      ])

      if (Array.isArray(membersRes?.members))   setMembers(membersRes.members)
      if (Array.isArray(deptsRes?.departments)) setDepts(deptsRes.departments)

      setLoading(false)
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
   * THE DEFECT THIS FIXES. Both branches used to end in `.slice(0, 20)`, so the
   * panel showed the first twenty people by name and silently dropped the rest.
   * There was no counter, no "showing 20 of 60", nothing — an administrator
   * scanning the list for somebody late in the alphabet concluded, reasonably,
   * that the account did not exist, and could not grant them anything. A real
   * Sales account that could sign in was invisible here for exactly that reason.
   *
   * A directory that hides people is worse than a long one. The panel scrolls,
   * the search box narrows it, and neither needs the list to be secretly
   * truncated — so nothing is truncated now.
   *
   * WHAT IS STILL EXCLUDED, and deliberately: soft-deleted accounts. Nothing
   * else. Inactive accounts remain listed because an administrator has to be
   * able to see and adjust what a deactivated person would regain, and because
   * hiding them here is how somebody becomes unassignable. Names are never
   * filtered on content — "test", "dummy" or anything else — since an account
   * that can authenticate is an account that can hold permissions.
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

  /**
   * The rows whose "x of y modules" counter is prefetched.
   *
   * The counter costs one request per employee, so it stays bounded exactly as
   * it was before the cap was lifted — the visible list is now complete, while
   * the request volume on load is unchanged. Rows past this window keep the
   * "···" placeholder they already show until a search brings them into it, and
   * the row is fully usable either way: the counter is decoration, not
   * information anybody acts on.
   */
  const countPrefetchTargets = useMemo(
    () => searchResults.slice(0, COUNT_PREFETCH_LIMIT),
    [searchResults],
  )

  // ── Load an employee's permission tree ──────────────────────────────────
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
    await loadTree(id)
  }

  async function loadTree(id: string) {
    // Marked up front so the list-count effect below never issues a
    // redundant request for an employee whose tree we're already fetching.
    requestedCountIds.current.add(id)
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
      setModuleCounts(prev => {
        const next = new Map(prev)
        next.set(id, accessibleModuleCount(data.modules))
        return next
      })

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

  // ── Employee-list access counters ───────────────────────────────────────
  // Fetches counts only for the bounded prefetch window above — the employee
  // list itself is complete, but asking the server for one tree per person in a
  // company-wide directory would be a burst of requests for a decorative
  // number. requestedCountIds gates this to at most one request per employee per
  // page session — searching only ever re-derives membership, never re-requests
  // an id already marked (whether it succeeded or failed), so there's no loop.
  useEffect(() => {
    if (!token) return
    const toFetch = countPrefetchTargets.filter(m => !requestedCountIds.current.has(m.id))
    if (toFetch.length === 0) return

    // No mount-cancellation guard here: requestedCountIds already makes
    // this idempotent (each id is marked, and thus fetched, at most once
    // for the life of the page), and React 19 safely no-ops a setState
    // from a component that's since unmounted. A cancellation flag tied to
    // this effect's own cleanup would instead get flipped by React's
    // dev-mode Strict Mode double-invoke before these fetches resolve,
    // silently discarding every result — that bug is why this is written
    // without one.
    toFetch.forEach(m => requestedCountIds.current.add(m.id))

    toFetch.forEach(async m => {
      try {
        const res = await fetch(`/api/control-center/permissions/employees/${m.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return
        const data = await res.json() as EmployeePermissionTree
        setModuleCounts(prev => {
          const next = new Map(prev)
          next.set(m.id, accessibleModuleCount(data.modules))
          return next
        })
      } catch {
        // Network error — this employee's row just keeps showing the
        // "···" placeholder; already marked in requestedCountIds so it
        // won't be retried this session, and the row stays fully usable.
      }
    })
  }, [countPrefetchTargets, token])

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
  // checkbox share a write path while holding genuinely different intentions: a
  // level states every action, the checkbox states only `view`.
  //
  // The current map is read from `prev` INSIDE the updater rather than from the
  // `overrides` closure, so two edits applied in the same tick cannot read a
  // stale map and undo one another.
  //
  // Writes explicit overrides — except for actions that have no employee
  // override today (source !== 'employee_override') whose inherited value
  // already matches what is wanted. Those are left as 'inherit' so re-applying
  // an already-matching state doesn't create needless
  // employee_permission_overrides rows on save; save() already no-ops any choice
  // that ends up equal to its initialOverrides entry.
  function applyDesiredActions(
    mod: ModuleState,
    deriveDesired: (current: Record<string, boolean>) => Record<string, boolean>,
  ) {
    setOverrides(prev => {
      const desired = deriveDesired(effectiveMapForModule(mod, prev))
      const next = new Map(prev)
      for (const action of mod.actions) {
        const key = overrideKey(mod.moduleKey, action.actionKey)
        const want = desired[action.actionKey] === true
        const hasExistingOverride = action.source === 'employee_override'
        if (!hasExistingOverride && want === action.allowed) {
          next.set(key, 'inherit')
        } else {
          next.set(key, want ? 'allow' : 'deny')
        }
      }
      return next
    })
  }

  // Picking a standard level. A preset is a COMPLETE statement about the module,
  // so it ignores what is currently held — that is the whole point of choosing
  // "Viewer", and it is why moving somebody down to it revokes what they had.
  // Deliberately unchanged by the Module access fix below.
  function applyAccessLevel(mod: ModuleState, level: PresetLevel) {
    const actionKeys = mod.actions.map(a => a.actionKey)
    applyDesiredActions(mod, () => presetAllowedActions(level, actionKeys))
  }

  /**
   * PART 1 — Module access, on or off.
   *
   * The toggle is NOT a second authority. It is a shortcut into the same
   * per-action override state the level selector writes:
   *
   *   Off  →  no_access            (every action for this module set to deny)
   *   On   →  enableModuleEntry    (`view` true, every other action untouched)
   *
   * Because both controls write the same state and the level is derived back
   * out of it by detectAccessLevel, the two can never disagree — there is no
   * separate visibility boolean, and nothing extra is saved.
   *
   * THE TWO DIRECTIONS ARE NOT SYMMETRICAL, on purpose.
   *
   * OFF is a complete statement — no access means no access — so it applies the
   * no_access preset, and because that removes things it asks first and names
   * them.
   *
   * ON is the smallest possible statement: let this person in. It says nothing
   * about what they may do once inside, so it must not decide that for them.
   * It used to apply the Viewer preset, which wrote an explicit deny over every
   * child action the employee held — that is what erased Aditya's Sample
   * Tracking dispatch, receive and mark_lost, silently, because the
   * destructive-action confirmation only ever ran on the OFF path.
   *
   * There is deliberately NO confirmation on ON. Enabling a module can no longer
   * remove anything, so there is nothing to warn about; adding a prompt here
   * would train administrators to click through the one on OFF, which still
   * matters.
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

  if (loading) return <LoadingScreen />

  const changeModalModule = changeModalModuleKey
    ? tree?.modules.find(m => m.moduleKey === changeModalModuleKey) ?? null
    : null

  const adminLocked = isSystemAdmin(tree)
  const selfServiceModules = tree?.modules.filter(m => isSelfServiceModuleKey(m.moduleKey)) ?? []
  const editableModules = tree?.modules.filter(m => !isSelfServiceModuleKey(m.moduleKey)) ?? []

  return (
    <ControlCenterLayout
      profile={profile}
      title="Access Control"
      subtitle="Manage what each employee can access, module by module"
      onSignOut={async () => { await supabase.auth.signOut(); router.replace('/login') }}
    >
      <div className={styles.layout}>

        <EmployeePanel
          search={search}
          onSearchChange={setSearch}
          results={searchResults}
          selectedEmployeeId={selectedEmployeeId}
          onSelect={selectEmployee}
          moduleCounts={moduleCounts}
          deptLabel={deptLabel}
        />

        <div className={styles.workspace}>
          {!selectedEmployeeId && (
            <EmptyState message="Select an employee to manage their permissions." />
          )}

          {selectedEmployeeId && treeLoading && <LoadingScreen message="Loading permissions…" />}

          {selectedEmployeeId && !treeLoading && treeError && (
            <div style={{ fontSize: 13, color: '#B0364A' }}>{treeError}</div>
          )}

          {selectedEmployeeId && !treeLoading && tree && (
            <>
              <WorkspaceHeader tree={tree} overrides={overrides} />

              {adminLocked && (
                <div style={{ marginTop: 16 }}>
                  <AlertBanner variant="amber">
                    <strong>System Administrator.</strong> Module access is controlled by
                    this person&apos;s system role, not by the settings below. An override
                    saved here could neither add to their authority nor reduce it.
                  </AlertBanner>
                </div>
              )}

              <div className={styles.moduleGrid} style={{ marginTop: 16 }}>
                {/* Attendance & Payroll is one row, and it is not editable —
                    see SELF_SERVICE_MODULE_KEYS above. It is rendered from the
                    two underlying modules but writes neither. */}
                {selfServiceModules.length > 0 && (
                  <AttendancePayrollCard modules={selfServiceModules} />
                )}

                {editableModules.map(mod => {
                  const effective = effectiveMapForModule(mod, overrides)
                  const level = detectAccessLevel(mod, effective)
                  const accessible = moduleIsAccessible(mod, overrides)
                  const unsaved = moduleIsDirty(mod, overrides, initialOverrides)
                  return (
                    <ModuleCard
                      key={mod.moduleKey}
                      mod={mod}
                      level={level}
                      accessible={accessible}
                      unsaved={unsaved}
                      locked={adminLocked}
                      onToggle={on => toggleModuleAccess(mod, on)}
                      open={changeModalModuleKey === mod.moduleKey}
                      onOpen={() => { if (!adminLocked) setChangeModalModuleKey(mod.moduleKey) }}
                    />
                  )
                })}
              </div>

              {/* ── Save bar ──────────────────────────────────────────────── */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 20 }}>
                <button
                  onClick={save}
                  disabled={!dirty || saving}
                  style={{
                    padding: '9px 20px', fontSize: 13, fontWeight: 600, color: '#fff',
                    background: dirty ? '#1A2035' : '#C7CBD4',
                    border: 'none', borderRadius: 8, cursor: dirty ? 'pointer' : 'default',
                  }}
                >
                  {saving ? 'Saving…' : 'Save Changes'}
                </button>
                {dirty && !saving && (
                  <span style={{ fontSize: 12, color: '#8C94A6' }}>Unsaved changes</span>
                )}
                {saveError && <span style={{ fontSize: 12, color: '#B0364A' }}>{saveError}</span>}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Change Access modal ────────────────────────────────────────────── */}
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
    </ControlCenterLayout>
  )
}
