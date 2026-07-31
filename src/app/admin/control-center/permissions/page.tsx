'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Search, CheckCircle2, Circle, LayoutGrid,
  ListChecks, Package, Laptop2, CalendarCheck, Wallet, QrCode, Users, TrendingUp, Landmark, Truck,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { ControlCenterLayout } from '@/components/layout/ControlCenterLayout'
import { LoadingScreen, EmptyState, AlertBanner, Avatar } from '@/components/ui/atoms'
import { useViewAs } from '@/hooks/useViewAs'
import styles from './permissions.module.css'

// Modules whose permissions are actually enforced by the resolver today.
// Everything else is prepared (overrides save, resolver computes an
// effective value) but no app code or RLS policy checks it yet.
// Keep in sync with src/lib/permissions/modules.ts comments as modules cut over.
//
// 'orders': the 'view' action gates the module — src/app/orders/layout.tsx
// and the /modules launcher card both call resolve_permission('orders','view')
// before letting a non-admin in. Other orders actions (create/edit/delete/
// approve/export/manage) are registered for the Access Control UI's presets
// but aren't independently checked anywhere yet — orders RLS still governs
// row-level access by team/ownership, unchanged. Same partial-enforcement
// shape as 'sample_tracking' above (view-adjacent actions enforced, the
// rest prepared).
//
// 'assets_access': fully enforced, unlike the two above. Every action is
// checked in three places that agree with each other — the RLS policies on
// assets / employee_assets (20260721000000, corrected by 20260723000000), the
// custody RPCs assign_asset / return_asset / mark_asset_lost, which resolve
// their action through assert_asset_custody_permission (20260725000000), and
// the capability derivation in src/lib/permissions/assetsAccess.ts that
// AssetsLayout gates the screen on. Granting 'assign' here really does hand
// someone the Assign button, so the prepared-but-not-enforced warning would
// be actively misleading on this module.
const ENFORCED_MODULE_KEYS = new Set(['sample_tracking', 'orders', 'assets_access'])

const ENFORCEMENT_COPY = {
  active: 'Permissions are enforced in this module.',
  prepared: 'Permissions are saved but not enforced in this module yet.',
}

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

// override choice per "moduleKey:actionKey" — 'inherit' means no employee override
type OverrideChoice = 'inherit' | 'allow' | 'deny'

// Understandable access levels shown to admins. These are a UI-only layer
// over the granular action engine — 'custom' just means "don't apply a
// preset, let the admin set each action manually" (the old behavior).
type AccessLevel = 'no_access' | 'viewer' | 'editor' | 'manager' | 'admin' | 'custom'
type PresetLevel = Exclude<AccessLevel, 'custom'>

const LEVELS: { key: AccessLevel; label: string; description: string }[] = [
  { key: 'no_access', label: 'No Access', description: 'Cannot view or use this module.' },
  { key: 'viewer',     label: 'Viewer',    description: 'Can view only.' },
  { key: 'editor',     label: 'Editor',    description: 'Can view, create, and edit.' },
  { key: 'manager',    label: 'Manager',   description: 'Can view, create, edit, approve, and manage.' },
  { key: 'admin',      label: 'Admin',     description: 'Full access to every action in this module.' },
  { key: 'custom',     label: 'Custom',    description: 'Manual action-level access.' },
]

// Local mapping from access level -> which actions should be allowed, for a
// given module's action set. Only actions the module actually has are ever
// touched. Manager intentionally does not grant delete/export/admin or any
// module-specific lifecycle action (e.g. Sample Tracking's dispatch/receive/
// mark_lost/close) — those stay reachable via Admin or Custom only.
function presetAllowedActions(level: PresetLevel, actionKeys: string[]): Record<string, boolean> {
  const has = (key: string) => actionKeys.includes(key)
  const allowed: Record<string, boolean> = {}
  for (const key of actionKeys) allowed[key] = false

  if (level === 'admin') {
    for (const key of actionKeys) allowed[key] = true
    return allowed
  }
  if (level === 'no_access') return allowed

  if (level === 'viewer' || level === 'editor' || level === 'manager') {
    if (has('view')) allowed.view = true
  }
  if (level === 'editor' || level === 'manager') {
    if (has('create')) allowed.create = true
    if (has('edit')) allowed.edit = true
  }
  if (level === 'manager') {
    if (has('approve')) allowed.approve = true
    if (has('manage')) allowed.manage = true
  }
  return allowed
}

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

// Matches the module's current effective state against each preset, in
// increasing order of privilege, so an ambiguous match prefers the more
// conservative label. Falls back to 'custom' when nothing matches exactly.
function detectAccessLevel(mod: ModuleState, effective: Record<string, boolean>): AccessLevel {
  const actionKeys = mod.actions.map(a => a.actionKey)
  const order: PresetLevel[] = ['no_access', 'viewer', 'editor', 'manager', 'admin']
  for (const level of order) {
    const preset = presetAllowedActions(level, actionKeys)
    if (actionKeys.every(key => !!preset[key] === !!effective[key])) return level
  }
  return 'custom'
}

function moduleIsDirty(mod: ModuleState, overrides: Map<string, OverrideChoice>, initialOverrides: Map<string, OverrideChoice>): boolean {
  return mod.actions.some(a => {
    const key = overrideKey(mod.moduleKey, a.actionKey)
    return overrides.get(key) !== initialOverrides.get(key)
  })
}

// A module counts as "accessible" for the employee-list/workspace counters
// whenever at least one of its actions is allowed — same notion of access
// summarizeModule already uses for the "No access granted" line.
type ModuleCount = { allowed: number; total: number }

function accessibleModuleCount(modules: ModuleState[]): ModuleCount {
  return {
    allowed: modules.filter(mod => mod.actions.some(a => a.allowed)).length,
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
}

function ModuleIcon({ moduleKey, color }: { moduleKey: string; color: string }) {
  const Icon = MODULE_ICONS[moduleKey] ?? LayoutGrid
  return <Icon size={24} strokeWidth={1.75} color={color} />
}

// ── Badges ───────────────────────────────────────────────────────────────────

function EnforcementBadge({ moduleKey }: { moduleKey: string }) {
  const enforced = ENFORCED_MODULE_KEYS.has(moduleKey)
  return (
    <span
      title={enforced ? ENFORCEMENT_COPY.active : ENFORCEMENT_COPY.prepared}
      style={{
        fontSize: 10, fontWeight: 700,
        color: enforced ? '#166534' : '#8C6D1F',
        background: enforced ? '#F0FDF4' : '#FFFBEB',
        borderRadius: 5, padding: '2px 7px',
      }}
    >
      {enforced ? 'Active' : 'Prepared'}
    </span>
  )
}

const LEVEL_BADGE_META: Record<AccessLevel, { label: string; color: string; bg: string }> = {
  no_access: { label: 'No Access', color: '#4B5563', bg: '#F3F4F6' },
  viewer:    { label: 'Viewer',    color: '#1E40AF', bg: '#EFF6FF' },
  editor:    { label: 'Editor',    color: '#4338CA', bg: '#EEF2FF' },
  manager:   { label: 'Manager',   color: '#0F766E', bg: '#F0FDFA' },
  admin:     { label: 'Admin',     color: '#DC1F2E', bg: 'rgba(220,31,46,0.08)' },
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
  mod, enforced, currentLevel, getChoice, onChangeAction, onApplyLevel, onClose,
}: {
  mod: ModuleState
  enforced: boolean
  currentLevel: AccessLevel
  getChoice: (actionKey: string) => OverrideChoice
  onChangeAction: (actionKey: string, choice: OverrideChoice) => void
  onApplyLevel: (level: PresetLevel) => void
  onClose: () => void
}) {
  const [mode, setMode] = useState<AccessLevel>(currentLevel)

  function pick(level: AccessLevel) {
    setMode(level)
    if (level === 'custom') return
    onApplyLevel(level)
    onClose()
  }

  const sourceSummary = summarizeSource(mod, getChoice)

  return (
    <div style={MODAL_OVERLAY} onClick={onClose}>
      <div style={MODAL_BOX} onClick={e => e.stopPropagation()}>
        <div style={MODAL_TITLE}>{mod.displayName} — Change Access</div>

        <div style={{ marginBottom: 16 }}>
          <AlertBanner variant={enforced ? 'green' : 'amber'}>
            {enforced ? ENFORCEMENT_COPY.active : ENFORCEMENT_COPY.prepared}
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
  const accessible = tree.modules.filter(mod => {
    const effective = effectiveMapForModule(mod, overrides)
    return mod.actions.some(a => effective[a.actionKey])
  }).length
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
  mod, level, accessible, unsaved, open, onOpen,
}: {
  mod: ModuleState
  level: AccessLevel
  accessible: boolean
  unsaved: boolean
  open: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      className={`${styles.moduleCard}${accessible ? ` ${styles.granted}` : ''}${open ? ` ${styles.open}` : ''}`}
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`${mod.displayName} — ${accessible ? 'Access enabled' : 'No access'}. Click to change.`}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <ModuleIcon moduleKey={mod.moduleKey} color={accessible ? '#166534' : '#8C94A6'} />
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <EnforcementBadge moduleKey={mod.moduleKey} />
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

      <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
        {accessible
          ? <CheckCircle2 size={15} strokeWidth={2} color="#166534" />
          : <Circle size={15} strokeWidth={2} color="#B7BEC9" />}
        <span style={{ fontSize: 12, fontWeight: 600, color: accessible ? '#166534' : '#6B7384' }}>
          {accessible ? 'Access enabled' : 'No access'}
        </span>
      </div>
    </button>
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

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    const pool = members.filter(m => !m.is_deleted)
    if (!q) return pool.slice(0, 20)
    return pool.filter(m =>
      m.full_name?.toLowerCase().includes(q) ||
      m.email?.toLowerCase().includes(q) ||
      deptLabel(m.team).toLowerCase().includes(q) ||
      m.role?.toLowerCase().includes(q)
    ).slice(0, 20)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, members, depts])

  // ── Load an employee's permission tree ──────────────────────────────────
  async function selectEmployee(id: string) {
    setSelectedEmployeeId(id)
    setSaveError('')
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
  // Fetches counts only for employees currently visible in the (already
  // 20-capped) search results. requestedCountIds gates this to at most one
  // request per employee per page session — search/clear-search only ever
  // re-derives the same searchResults membership, never re-requests an id
  // already marked (whether it succeeded or failed), so there's no loop.
  useEffect(() => {
    if (!token) return
    const toFetch = searchResults.filter(m => !requestedCountIds.current.has(m.id))
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
  }, [searchResults, token])

  function changeOverride(moduleKey: string, actionKey: string, choice: OverrideChoice) {
    setOverrides(prev => {
      const next = new Map(prev)
      next.set(overrideKey(moduleKey, actionKey), choice)
      return next
    })
  }

  // Applies a preset by writing explicit overrides — except for actions that
  // have no employee override today (source !== 'employee_override') whose
  // inherited value already matches the preset. Those are left as 'inherit'
  // so re-picking an already-matching level doesn't create needless
  // employee_permission_overrides rows on save; save() already no-ops any
  // choice that ends up equal to its initialOverrides entry.
  function applyAccessLevel(mod: ModuleState, level: PresetLevel) {
    const actionKeys = mod.actions.map(a => a.actionKey)
    const preset = presetAllowedActions(level, actionKeys)
    setOverrides(prev => {
      const next = new Map(prev)
      for (const action of mod.actions) {
        const key = overrideKey(mod.moduleKey, action.actionKey)
        const desired = preset[action.actionKey]
        const hasExistingOverride = action.source === 'employee_override'
        if (!hasExistingOverride && desired === action.allowed) {
          next.set(key, 'inherit')
        } else {
          next.set(key, desired ? 'allow' : 'deny')
        }
      }
      return next
    })
  }

  const dirty = useMemo(() => {
    for (const [key, choice] of overrides) {
      if (initialOverrides.get(key) !== choice) return true
    }
    return false
  }, [overrides, initialOverrides])

  // ── Save ─────────────────────────────────────────────────────────────────
  async function save() {
    if (!selectedEmployeeId || !tree) return

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

              <div className={styles.moduleGrid} style={{ marginTop: 16 }}>
                {tree.modules.map(mod => {
                  const effective = effectiveMapForModule(mod, overrides)
                  const level = detectAccessLevel(mod, effective)
                  const accessible = mod.actions.some(a => effective[a.actionKey])
                  const unsaved = moduleIsDirty(mod, overrides, initialOverrides)
                  return (
                    <ModuleCard
                      key={mod.moduleKey}
                      mod={mod}
                      level={level}
                      accessible={accessible}
                      unsaved={unsaved}
                      open={changeModalModuleKey === mod.moduleKey}
                      onOpen={() => setChangeModalModuleKey(mod.moduleKey)}
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
          enforced={ENFORCED_MODULE_KEYS.has(changeModalModule.moduleKey)}
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
