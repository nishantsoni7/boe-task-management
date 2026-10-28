'use client'

import type { ReactNode } from 'react'
import { cc } from '@/components/controlCenter/CcPrimitives'
import type { MatrixAction } from '@/hooks/queries/useControlCenterData'
import {
  authoritiesFor,
  heldAuthorities,
  isEntryOnly,
  levelLabel,
  offeredLevels,
  joinWords,
  type CatalogAuthority,
  type DetectedLevel,
  type OfferedLevel,
} from '@/lib/permissions/accessCatalog'
import styles from '@/app/admin/control-center/permissions/permissions.module.css'

// ── The pieces every Access screen draws for one person × one module ────────
//
// People lays them out as a card per module; Modules as cells of a row per
// person; Authorities uses the picker and the chips. Keeping them here is what
// lets the three screens show the same control for the same fact — and makes
// it impossible for one screen to offer a level or an authority another would
// not. Every piece is presentational: the screens own the pending state and
// the save.

/** An effective allow/deny map, folding pending choices over the resolver's answer. */
export function effectiveOf(
  actions: readonly MatrixAction[],
  pending?: Readonly<Record<string, boolean>>,
): Record<string, boolean> {
  if (pending) return { ...pending }
  const map: Record<string, boolean> = {}
  for (const a of actions) map[a.actionKey] = a.allowed
  return map
}

// ── Level control: one control, every state ─────────────────────────────────

export function LevelControl({
  moduleKey, moduleName, personName, actionKeys, level, locked, onChange,
}: {
  moduleKey: string
  moduleName: string
  personName: string
  actionKeys: readonly string[]
  level: DetectedLevel
  /** A system Administrator: access is the role's, so the control is read-only. */
  locked: boolean
  onChange: (level: OfferedLevel | 'off') => void
}) {
  if (locked) {
    return <span className={`${cc.badge} ${cc.badgeGray}`} title="An Administrator’s access comes from the system role">Everything · by role</span>
  }
  const options: (OfferedLevel | 'off')[] = ['off', ...offeredLevels(moduleKey, actionKeys)]
  return (
    <span className={styles.levelWrap}>
      <span className={styles.seg} role="radiogroup" aria-label={`Access to ${moduleName} for ${personName}`}>
        {options.map(option => {
          const checked = level === option
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={checked}
              className={`${styles.segBtn}${checked ? (option === 'off' ? ` ${styles.segOff}` : ` ${styles.segOn}`) : ''}`}
              onClick={() => { if (!checked) onChange(option) }}
            >
              {levelLabel(moduleKey, actionKeys, option)}
            </button>
          )
        })}
      </span>
      {level === 'custom' && (
        <span className={`${cc.badge} ${cc.badgeAmber}`} title="A hand-picked mix of permissions. Choose a level to tidy it.">Custom mix</span>
      )}
    </span>
  )
}

// ── Authorities: chips, and the picker that adds one ────────────────────────

export type HolderLookup = (actionKey: string) => string[]

export function AuthorityChips({
  moduleKey, actionKeys, effective, baseEffective, locked, perPersonOnly, canAdd, pickerOpen,
  onRemove, onOpenPicker,
}: {
  moduleKey: string
  actionKeys: readonly string[]
  effective: Readonly<Record<string, boolean>>
  /** What the resolver said on load, so a chip added but not yet saved reads as new. */
  baseEffective: Readonly<Record<string, boolean>>
  locked: boolean
  /** On an Administrator: only the per-person authorities are offered or removable. */
  perPersonOnly: boolean
  /** False while the module is Off for a non-admin: a chip on a closed module decides nothing. */
  canAdd: boolean
  pickerOpen: boolean
  onRemove: (actionKey: string) => void
  onOpenPicker: () => void
}) {
  const held = heldAuthorities(moduleKey, actionKeys, effective).filter(a => !perPersonOnly || a.perPerson)
  const available = authoritiesFor(moduleKey, actionKeys)
    .filter(a => effective[a.actionKey] !== true && (!perPersonOnly || a.perPerson))
  if (held.length === 0 && (available.length === 0 || !canAdd || locked && !perPersonOnly)) return null
  return (
    <span className={styles.chips}>
      {held.map(a => (
        <span key={a.actionKey} className={`${styles.chip}${baseEffective[a.actionKey] === true ? '' : ` ${styles.chipNew}`}`} title={a.meaning}>
          {a.label}
          {(!locked || a.perPerson) && (
            <button type="button" className={styles.chipX} aria-label={`Remove ${a.label}`} onClick={() => onRemove(a.actionKey)}>×</button>
          )}
        </span>
      ))}
      {available.length > 0 && canAdd && (!locked || perPersonOnly) && (
        <button type="button" className={styles.chipAdd} onClick={onOpenPicker} aria-expanded={pickerOpen}>+ Add authority</button>
      )}
    </span>
  )
}

export function AuthorityPicker({
  moduleKey, moduleName, personName, actionKeys, effective, perPersonOnly, holdersOf, onAdd, onClose,
}: {
  moduleKey: string
  moduleName: string
  personName: string
  actionKeys: readonly string[]
  effective: Readonly<Record<string, boolean>>
  perPersonOnly: boolean
  /** First names of the other people who hold an authority, for "Also held by". */
  holdersOf?: HolderLookup
  onAdd: (authority: CatalogAuthority) => void
  onClose: () => void
}) {
  const available = authoritiesFor(moduleKey, actionKeys)
    .filter(a => effective[a.actionKey] !== true && (!perPersonOnly || a.perPerson))
  return (
    <div className={styles.picker} role="group" aria-label={`Give ${personName} an authority in ${moduleName}`}>
      <div className={styles.pickerHead}>
        <span>Give {personName} an authority in {moduleName}</span>
        <button type="button" className={cc.linkBtn} onClick={onClose}>Close</button>
      </div>
      {available.length === 0 && <div className={cc.muted} style={{ fontSize: 12.5, padding: '6px 0' }}>Nothing left to add.</div>}
      {available.map(a => {
        const others = holdersOf?.(a.actionKey) ?? []
        return (
          <div key={a.actionKey} className={styles.pickerOpt}>
            <div style={{ minWidth: 0 }}>
              <div className={styles.pickerName}>{a.label}</div>
              <div className={styles.pickerMeaning}>{a.meaning}</div>
              <div className={styles.pickerHint}>
                Needs: {a.needs}
                {' · '}
                {others.length ? `Also held by ${others.join(', ')}` : 'Nobody else holds this'}
                {a.perPerson ? ' · Granted per person, Administrators included' : ''}
              </div>
            </div>
            <button type="button" className="boe-btn boe-btn-ghost" onClick={() => onAdd(a)}>Add</button>
          </div>
        )
      })}
    </div>
  )
}

// ── Turning a module Off: an inline confirmation that names what goes ───────

export function OffConfirm({
  moduleName, personName, cleared, onConfirm, onCancel,
}: {
  moduleName: string
  personName: string
  cleared: readonly string[]
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className={styles.confirm} role="alert">
      <span>
        Turning <strong>{moduleName}</strong> off for {personName} also removes: <strong>{joinWords(cleared)}</strong>.
      </span>
      <button type="button" className="boe-btn boe-btn-danger" onClick={onConfirm}>Turn off and remove</button>
      <button type="button" className="boe-btn boe-btn-ghost" onClick={onCancel}>Keep as is</button>
    </div>
  )
}

// ── Where a person's access to a module comes from, in one phrase ───────────

const DATE_FMT = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })

export function setByText(
  actions: readonly MatrixAction[],
  entryAction: string | null,
  role: string,
  opts: { defaultOn?: boolean; unsaved?: boolean } = {},
): string {
  if (role === 'admin') return 'By role'
  if (opts.unsaved) return 'Not saved yet'
  const entry = entryAction ? actions.find(a => a.actionKey === entryAction) : undefined
  // The newest active override in the module is the last decision somebody made here.
  const latest = actions
    .filter(a => a.source === 'employee_override' && a.grantedAt)
    .sort((a, b) => (b.grantedAt ?? '').localeCompare(a.grantedAt ?? ''))[0]
  if (latest?.grantedAt) {
    const who = latest.grantedBy?.name?.split(' ')[0] ?? 'an administrator'
    const when = DATE_FMT.format(new Date(latest.grantedAt))
    return entry?.allowed === false && entry.source === 'employee_override' ? `Turned off by ${who} · ${when}` : `Set by ${who} · ${when}`
  }
  if (entry?.allowed && entry.source === 'department') return 'Team rule'
  if (entry?.allowed && entry.source === 'role') return 'By role'
  if (entry?.allowed && entry.source === 'system_default' && opts.defaultOn) return 'Default · everyone'
  if (entry?.allowed) return 'Default'
  return 'Not granted'
}

/** A short line under a module name, kept to one sentence. */
export function RowNote({ children }: { children: ReactNode }) {
  return <div className={styles.rowNote}>{children}</div>
}

/** Whether a module reads Off / On rather than a ladder, for callers laying out cells. */
export function isTwoState(moduleKey: string, actionKeys: readonly string[]): boolean {
  return isEntryOnly(moduleKey, actionKeys)
}
