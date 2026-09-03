'use client'

// Access › By Module.
//
// One module across everyone: the resolver's answer per employee, the level it
// amounts to, and where it comes from. Reads come from the read-only matrix
// route (/api/control-center/permissions/modules/[key]/employees); every
// change is saved through the SAME per-employee PUT By Employee uses, with the
// per-action override choices derived by the SAME shared rule
// (src/lib/permissions/accessControlChanges.ts). The two views therefore store
// identical rows for identical intentions and can never disagree.
//
// What this screen will not do: hand out protected permissions. Its level
// control offers the four presets; "Custom" — individually chosen actions,
// protected ones included — opens the person in By Employee, where each
// action is named and confirmed.

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Search } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { ControlCenterSkeleton } from '@/components/layout/ControlCenterSkeleton'
import { AlertBanner, Avatar } from '@/components/ui/atoms'
import { cc, CcBadge, CcEmpty, CcTable, CcToolbar, ActiveBadge, type CcTone } from '@/components/controlCenter/CcPrimitives'
import {
  ACCESS_LEVEL_LABELS,
  PRESET_LEVELS,
  presetAllowedActions,
  enableModuleEntry,
  protectedActionsClearedByPreset,
  type AccessLevel,
  type PresetLevel,
} from '@/lib/permissions/levels'
import { moduleEnforcement, ENFORCEMENT_BADGE_LABEL } from '@/lib/permissions/enforcement'
import { isSelfServiceModule } from '@/lib/moduleAccess'
import {
  choicesForDesired,
  changesBetween,
  initialChoices,
  effectiveMap,
  levelOf,
  moduleEntryAction,
  summarizeSources,
  protectedActionWords,
  type PermissionSource,
  type SourceSummary,
} from '@/lib/permissions/accessControlChanges'
import styles from '../permissions.module.css'
import {
  usePermissionModules, useModuleAccessMatrix, useDepartments,
  NO_DEPARTMENTS, NO_PERMISSION_MODULES,
  type ModuleMatrixEmployee,
} from '@/hooks/queries/useControlCenterData'

const BY_EMPLOYEE_PATH = '/admin/control-center/permissions'
const UNSAVED_PROMPT = 'You have unsaved access changes. Leave without saving?'

const LEVEL_TONE: Record<AccessLevel, CcTone> = {
  no_access: 'gray', viewer: 'blue', contributor: 'blue', manager: 'green', custom: 'amber',
}

const SOURCE_TONE: Record<PermissionSource, CcTone> = {
  employee_override: 'violet', department: 'blue', role: 'blue', system_default: 'gray',
}

function SourceBadge({ summary }: { summary: SourceSummary }) {
  if (summary.kind === 'mixed') return <CcBadge tone="amber">Mixed</CcBadge>
  return <CcBadge tone={SOURCE_TONE[summary.source]}>{summary.label.replace(' default', '')}</CcBadge>
}

/** A pending desired map per employee id. Absent means "as loaded". */
type Pending = Map<string, Record<string, boolean>>

function sameMap(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if ((a[k] === true) !== (b[k] === true)) return false
  return true
}

export default function ByModulePage() {
  return (
    <Suspense fallback={<ControlCenterSkeleton />}>
      <ByModulePageInner />
    </Suspense>
  )
}

function ByModulePageInner() {
  const supabase = useMemo(() => createClient(), [])
  const router   = useRouter()
  const pathname = usePathname()
  const moduleParam = useSearchParams().get('module')

  const [token, setToken] = useState('')

  const modulesQuery = usePermissionModules()
  const deptsQuery   = useDepartments()
  const modules = modulesQuery.data ?? NO_PERMISSION_MODULES
  const depts   = deptsQuery.data   ?? NO_DEPARTMENTS

  // Attendance and Payroll are admin-only by product decision; a matrix of
  // grants that decide nothing would be a lie, so they are not offered here.
  const listed = useMemo(() => modules.filter(m => !isSelfServiceModule(m.moduleKey)), [modules])
  const selectedKey = moduleParam && listed.some(m => m.moduleKey === moduleParam) ? moduleParam : null
  const selected = listed.find(m => m.moduleKey === selectedKey) ?? null

  const matrixQuery = useModuleAccessMatrix(selectedKey)
  const matrix = matrixQuery.data ?? null

  const [pending, setPending] = useState<Pending>(new Map())
  const [saving, setSaving]   = useState(false)
  const [saveError, setSaveError] = useState('')

  const [search, setSearch]             = useState('')
  const [deptFilter, setDeptFilter]     = useState('')
  const [levelFilter, setLevelFilter]   = useState<'' | AccessLevel>('')
  const [overridesOnly, setOverridesOnly] = useState(false)
  const [includeInactive, setIncludeInactive] = useState(true)

  useEffect(() => {
    const init = async () => {
      // Identity is the layout's. The stored session is read only for the
      // bearer token the save PUTs need.
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return
      setToken(session.access_token)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dirty = pending.size > 0

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const deptLabel = (key: string | null | undefined) => {
    if (!key) return '—'
    return depts.find(d => d.department_key === key)?.department_name ?? key
  }

  function selectModule(key: string) {
    if (key === selectedKey) return
    if (dirty && !window.confirm(UNSAVED_PROMPT)) return
    setPending(new Map())
    setSaveError('')
    router.replace(`${pathname}?module=${key}`)
  }

  // ── Per-row derivation ───────────────────────────────────────────────────

  const actionKeys = matrix?.module.actions.map(a => a.actionKey) ?? []
  const entryAction = moduleEntryAction(actionKeys)

  type RowState = {
    emp: ModuleMatrixEmployee
    base: Record<string, boolean>
    desired: Record<string, boolean>
    level: AccessLevel
    visible: boolean
    source: SourceSummary
    unsaved: boolean
    locked: boolean
  }

  function rowState(emp: ModuleMatrixEmployee): RowState {
    const initial = initialChoices(emp.actions)
    const base = effectiveMap(emp.actions, initial)
    const desired = pending.get(emp.id) ?? base
    const choices = pending.has(emp.id) ? choicesForDesired(emp.actions, desired) : initial
    return {
      emp,
      base,
      desired,
      level: levelOf(emp.actions, desired),
      visible: desired[entryAction] === true,
      source: summarizeSources(emp.actions, k => choices.get(k) ?? 'inherit'),
      unsaved: pending.has(emp.id),
      // A system Administrator's authority is users.role; an override here
      // could neither add to it nor take it away. Same lock as By Employee.
      locked: emp.role === 'admin',
    }
  }

  function setDesired(row: RowState, desired: Record<string, boolean>) {
    setPending(prev => {
      const next = new Map(prev)
      if (sameMap(desired, row.base)) next.delete(row.emp.id)
      else next.set(row.emp.id, desired)
      return next
    })
  }

  function toggle(row: RowState, on: boolean) {
    if (!on) {
      const cleared = protectedActionsClearedByPreset('no_access', actionKeys, row.desired)
      if (cleared.length > 0) {
        const message =
          `Turning off ${matrix?.module.displayName} for ${row.emp.name} will remove: ${protectedActionWords(cleared, selectedKey ?? undefined)}.\n\n` +
          'Continue?'
        if (!window.confirm(message)) return
      }
      setDesired(row, presetAllowedActions('no_access', actionKeys))
      return
    }
    // Entry only: every child action keeps exactly the value it already had.
    setDesired(row, enableModuleEntry(actionKeys, row.desired))
  }

  function chooseLevel(row: RowState, value: string) {
    if (value === 'custom') {
      // Individually chosen actions, protected ones included, are named and
      // confirmed one by one in By Employee — never picked off a list here.
      if (dirty && !window.confirm(UNSAVED_PROMPT)) return
      router.push(`${BY_EMPLOYEE_PATH}?employee=${row.emp.id}`)
      return
    }
    const level = value as PresetLevel
    const cleared = protectedActionsClearedByPreset(level, actionKeys, row.desired)
    if (cleared.length > 0) {
      const message =
        `Changing ${row.emp.name} to ${ACCESS_LEVEL_LABELS[level].label} will remove: ${protectedActionWords(cleared, selectedKey ?? undefined)}.\n\n` +
        'These are kept only under Custom. Continue?'
      if (!window.confirm(message)) return
    }
    setDesired(row, presetAllowedActions(level, actionKeys))
  }

  // ── Save ─────────────────────────────────────────────────────────────────

  async function save() {
    if (!matrix || !selectedKey || pending.size === 0) return
    setSaving(true)
    setSaveError('')
    const failures: string[] = []
    const saved: string[] = []
    try {
      await Promise.all([...pending.entries()].map(async ([id, desired]) => {
        const emp = matrix.employees.find(e => e.id === id)
        if (!emp || emp.role === 'admin') return
        const changes = changesBetween(selectedKey, emp.actions, initialChoices(emp.actions), choicesForDesired(emp.actions, desired))
        if (changes.length === 0) { saved.push(id); return }
        try {
          const res = await fetch(`/api/control-center/permissions/employees/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ changes }),
          })
          const json = await res.json().catch(() => null)
          if (!res.ok) { failures.push(`${emp.name}: ${json?.error ?? 'Save failed'}`); return }
          saved.push(id)
        } catch {
          failures.push(`${emp.name}: Save failed. Check your connection and try again.`)
        }
      }))
      // Employees that saved leave the pending set; a failed one keeps its
      // pending state so nothing the administrator chose is lost.
      setPending(prev => {
        const next = new Map(prev)
        for (const id of saved) next.delete(id)
        return next
      })
      if (failures.length > 0) setSaveError(failures.join(' · '))
      await matrixQuery.refetch()
    } finally {
      setSaving(false)
    }
  }

  function discardChanges() {
    setPending(new Map())
    setSaveError('')
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (modulesQuery.isPending || deptsQuery.isPending) return <ControlCenterSkeleton />

  const rows = matrix ? matrix.employees.map(rowState) : []
  const q = search.trim().toLowerCase()
  const visibleRows = rows.filter(r =>
    (includeInactive || r.emp.is_active) &&
    (!q || r.emp.name.toLowerCase().includes(q) || r.emp.email.toLowerCase().includes(q)) &&
    (!deptFilter || r.emp.team === deptFilter) &&
    (!levelFilter || r.level === levelFilter) &&
    (!overridesOnly || r.emp.actions.some(a => a.source === 'employee_override')),
  )
  const visibleCount = rows.filter(r => r.visible).length
  const enforcement = selectedKey ? moduleEnforcement(selectedKey) : null

  return (
    <div className={styles.layout}>

      {/* ── Module list ──────────────────────────────────────────────────── */}
      <div className={styles.panel}>
        <div className={styles.panelHead}>
          <span>Modules</span>
          <span className={styles.panelCount}>{listed.length}</span>
        </div>
        <div className={styles.panelList}>
          {listed.map(m => {
            const e = moduleEnforcement(m.moduleKey)
            const isSelected = m.moduleKey === selectedKey
            return (
              <button
                key={m.moduleKey}
                type="button"
                className={`${styles.row}${isSelected ? ` ${styles.rowSelected}` : ''}`}
                aria-pressed={isSelected}
                onClick={() => selectModule(m.moduleKey)}
              >
                <div className={styles.rowText}>
                  <div className={styles.rowName}>{m.displayName}</div>
                  <div className={styles.rowSub}>
                    {m.actions.length} {m.actions.length === 1 ? 'permission' : 'permissions'}
                    {e.state !== 'enforced' && ` · ${ENFORCEMENT_BADGE_LABEL[e.state]}`}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
        <div className={cc.muted} style={{ fontSize: 11.5, lineHeight: 1.45, padding: '0 2px' }}>
          Attendance &amp; Payroll are self-service; their management access is restricted to system administrators and is not granted here.
        </div>
      </div>

      {/* ── Matrix ───────────────────────────────────────────────────────── */}
      <div className={styles.workspace}>
        {!selectedKey && (
          <CcEmpty
            message="Select a module to see who can open it and what each person can do."
            hint="Levels here are the same four presets as By Employee; Custom opens the person there."
          />
        )}

        {selectedKey && matrixQuery.isPending && <ControlCenterSkeleton />}

        {selectedKey && matrixQuery.isError && (
          <div className={cc.error}>{(matrixQuery.error as Error).message}</div>
        )}

        {selectedKey && matrix && selected && enforcement && (
          <>
            <div className={styles.header}>
              <div style={{ minWidth: 0 }}>
                <div className={styles.headerName}>{matrix.module.displayName}</div>
                <div className={styles.headerSub}>
                  {matrix.module.actions.map(a => a.displayName).join(' · ')}
                </div>
              </div>
              <div className={styles.headerStats}>
                <div className={styles.headerStat}>
                  <div className={styles.headerStatValue} style={{ color: '#166534' }}>{visibleCount}</div>
                  <div className={styles.headerStatLabel}>Visible</div>
                </div>
                <div className={styles.headerStat}>
                  <div className={styles.headerStatValue} style={{ color: '#4B5563' }}>{rows.length - visibleCount}</div>
                  <div className={styles.headerStatLabel}>Hidden</div>
                </div>
              </div>
            </div>

            {enforcement.state !== 'enforced' && (
              <div style={{ marginBottom: 12 }}>
                <AlertBanner variant="amber">
                  <strong>{ENFORCEMENT_BADGE_LABEL[enforcement.state]}.</strong> {enforcement.detail}
                </AlertBanner>
              </div>
            )}

            <CcToolbar>
              <div className={cc.search}>
                <Search size={13} strokeWidth={2} />
                <input
                  className={cc.control}
                  placeholder="Search name or email"
                  aria-label="Search employees"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              <select className={cc.control} aria-label="Department" value={deptFilter} onChange={e => setDeptFilter(e.target.value)}>
                <option value="">All departments</option>
                {depts.map(d => <option key={d.department_key} value={d.department_key}>{d.department_name}</option>)}
              </select>
              <select className={cc.control} aria-label="Level" value={levelFilter} onChange={e => setLevelFilter(e.target.value as '' | AccessLevel)}>
                <option value="">All levels</option>
                {(['no_access', 'viewer', 'contributor', 'manager', 'custom'] as AccessLevel[]).map(l => (
                  <option key={l} value={l}>{ACCESS_LEVEL_LABELS[l].label}</option>
                ))}
              </select>
              <label className={cc.check} style={{ fontSize: 12 }}>
                <input type="checkbox" checked={overridesOnly} onChange={e => setOverridesOnly(e.target.checked)} />
                Overrides only
              </label>
              <label className={cc.check} style={{ fontSize: 12 }}>
                <input type="checkbox" checked={includeInactive} onChange={e => setIncludeInactive(e.target.checked)} />
                Include inactive
              </label>
              <span className={cc.count}>
                {visibleRows.length === rows.length ? `${rows.length} employees` : `${visibleRows.length} of ${rows.length}`}
              </span>
            </CcToolbar>

            {visibleRows.length === 0 ? (
              <CcEmpty message="No employees match these filters." />
            ) : (
              <CcTable>
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Department</th>
                    <th>Access</th>
                    <th>Level</th>
                    <th>Source</th>
                    <th className={cc.right}></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map(row => (
                    <tr key={row.emp.id}>
                      <td>
                        <div className={cc.person}>
                          <Avatar name={row.emp.name} size={26} />
                          <div style={{ minWidth: 0 }}>
                            <div className={cc.personName}>
                              {row.emp.name}
                              {row.unsaved && <span className={styles.unsaved}>Unsaved</span>}
                            </div>
                            <div className={cc.personSub}>
                              <span className={cc.cap}>{row.emp.role}</span> · {row.emp.email}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className={row.emp.team ? undefined : cc.faint}>
                        {deptLabel(row.emp.team)}
                        {!row.emp.is_active && <span style={{ marginLeft: 8 }}><ActiveBadge active={false} /></span>}
                      </td>
                      <td>
                        {row.locked ? (
                          <span className={`${styles.switchWord} ${styles.switchOn}`}>Visible</span>
                        ) : (
                          <label className={styles.switch}>
                            <input
                              type="checkbox"
                              role="switch"
                              checked={row.visible}
                              onChange={e => toggle(row, e.target.checked)}
                              aria-label={`Module access for ${row.emp.name}`}
                            />
                            <span className={`${styles.switchWord} ${row.visible ? styles.switchOn : styles.switchOff}`}>
                              {row.visible ? 'Visible' : 'Hidden'}
                            </span>
                          </label>
                        )}
                      </td>
                      <td>
                        {row.locked ? (
                          <CcBadge tone="gray">All · system role</CcBadge>
                        ) : (
                          <select
                            className={`${cc.control} ${styles.levelSelect}`}
                            aria-label={`Access level for ${row.emp.name}`}
                            value={row.level}
                            onChange={e => chooseLevel(row, e.target.value)}
                          >
                            {PRESET_LEVELS.map(l => (
                              <option key={l} value={l}>{ACCESS_LEVEL_LABELS[l].label}</option>
                            ))}
                            <option value="custom">{row.level === 'custom' ? 'Custom' : 'Custom… (open By Employee)'}</option>
                          </select>
                        )}
                      </td>
                      <td>
                        {row.locked
                          ? <CcBadge tone="gray">System role</CcBadge>
                          : <>
                              <SourceBadge summary={row.source} />
                              {row.level === 'custom' && <span className={cc.muted} style={{ fontSize: 11.5, marginLeft: 6 }}><CcBadge tone={LEVEL_TONE.custom}>Custom</CcBadge></span>}
                            </>}
                      </td>
                      <td className={cc.right}>
                        <Link href={`${BY_EMPLOYEE_PATH}?employee=${row.emp.id}`} className={cc.linkBtn}>Open</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </CcTable>
            )}

            <div className={styles.saveBar}>
              <span className={styles.saveBarText}>
                {dirty
                  ? `${pending.size} ${pending.size === 1 ? 'employee' : 'employees'} changed · not saved yet`
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
  )
}
