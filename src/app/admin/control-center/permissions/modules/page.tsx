'use client'

// Access › Modules.
//
// One module across everyone: who can open it, at what level, and who holds
// its authorities. Reads come from the access matrix (one request for the
// whole Access hub); every change is a pending edit over it, saved through
// the SAME per-employee PUT People uses, with the per-action override choices
// derived by the SAME shared rule (src/lib/permissions/accessControlChanges.ts,
// via src/components/controlCenter/accessEdits.ts). The three screens
// therefore store identical rows for identical intentions and can never
// disagree.
//
// The row is the same control People draws for one person: a level, and the
// authorities as chips. A system Administrator's row is read-only except for
// the authorities granted per person (orders.approve_order), which the shared
// hook alone lets through to the save.

import { Suspense, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Search } from 'lucide-react'
import { ControlCenterSkeleton } from '@/components/layout/ControlCenterSkeleton'
import { Avatar } from '@/components/ui/atoms'
import { cc, CcBadge, CcEmpty, CcToolbar, ActiveBadge } from '@/components/controlCenter/CcPrimitives'
import { TeamAccessCard } from '@/components/controlCenter/TeamAccessCard'
import { ModuleIcon } from '@/components/modules/ModuleIcons'
import {
  AuthorityChips, AuthorityPicker, LevelControl, OffConfirm, setByText,
} from '@/components/controlCenter/AccessRow'
import { entryActionForModule } from '@/lib/permissions/levels'
import {
  authoritiesClearedByOff,
  authoritiesFor,
  desiredForLevel,
  desiredWithAuthority,
  detectOfferedLevel,
  hiddenActions,
  isModuleOfferedTo,
  isSelfServiceModuleKey,
  moduleWords,
  type OfferedLevel,
} from '@/lib/permissions/accessCatalog'
import { useAccessMatrixEdits, blurbFor } from '@/components/controlCenter/accessEdits'
import styles from '../permissions.module.css'
import {
  useAccessMatrix, useDepartments, NO_DEPARTMENTS,
  type AccessMatrixEmployee, type PermissionModuleRef,
} from '@/hooks/queries/useControlCenterData'

const UNSAVED_PROMPT = 'You have unsaved access changes. Leave without saving?'

export default function ByModulePage() {
  return (
    <Suspense fallback={<ControlCenterSkeleton />}>
      <ByModulePageInner />
    </Suspense>
  )
}

function ByModulePageInner() {
  const router   = useRouter()
  const pathname = usePathname()
  const moduleParam = useSearchParams().get('module')

  const matrixQuery = useAccessMatrix()
  const deptsQuery  = useDepartments()
  const matrix = matrixQuery.data ?? null
  const depts  = deptsQuery.data ?? NO_DEPARTMENTS
  const edits = useAccessMatrixEdits(matrix)

  // Attendance and Payroll are admin-only by product decision, and Employee
  // Records is offered on an Administrator only; a matrix of grants that decide
  // nothing would be a lie, so they are not listed here (accessCatalog.ts).
  const listed = useMemo(
    () => (matrix?.modules ?? []).filter(m => !isSelfServiceModuleKey(m.moduleKey) && isModuleOfferedTo(m.moduleKey, 'member')),
    [matrix],
  )
  const selectedKey = moduleParam && listed.some(m => m.moduleKey === moduleParam) ? moduleParam : null
  const selected = listed.find(m => m.moduleKey === selectedKey) ?? null

  const [search, setSearch]             = useState('')
  const [deptFilter, setDeptFilter]     = useState('')
  const [includeInactive, setIncludeInactive] = useState(true)
  const [picker, setPicker] = useState<string | null>(null)
  const [offConfirm, setOffConfirm] = useState<{ employeeId: string; cleared: string[] } | null>(null)

  const dirty = edits.pending.size > 0

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
    edits.discard()
    setPicker(null)
    setOffConfirm(null)
    router.replace(`${pathname}?module=${key}`)
  }

  // ── Per-row derivation ───────────────────────────────────────────────────

  const actionKeys = selected?.actions.map(a => a.actionKey) ?? []
  const entryAction = entryActionForModule(actionKeys)
  const words = selectedKey ? moduleWords(selectedKey) : null

  const isOpen = (emp: AccessMatrixEmployee) =>
    emp.role === 'admin' || (!!entryAction && edits.effectiveOf(emp.id, selectedKey ?? '')[entryAction] === true)

  function changeLevel(emp: AccessMatrixEmployee, level: OfferedLevel | 'off') {
    if (!selectedKey) return
    const current = edits.effectiveOf(emp.id, selectedKey)
    if (level === 'off') {
      const cleared = authoritiesClearedByOff(selectedKey, actionKeys, current)
      if (cleared.length > 0) { setOffConfirm({ employeeId: emp.id, cleared }); setPicker(null); return }
    }
    edits.setDesired(emp.id, selectedKey, desiredForLevel(selectedKey, actionKeys, level, current))
    setOffConfirm(null)
  }

  function confirmOff(emp: AccessMatrixEmployee) {
    if (!selectedKey) return
    edits.setDesired(emp.id, selectedKey, desiredForLevel(selectedKey, actionKeys, 'off', edits.effectiveOf(emp.id, selectedKey)))
    setOffConfirm(null)
  }

  function toggleAuthority(emp: AccessMatrixEmployee, actionKey: string, on: boolean) {
    if (!selectedKey) return
    edits.setDesired(emp.id, selectedKey, desiredWithAuthority(selectedKey, actionKeys, actionKey, on, edits.effectiveOf(emp.id, selectedKey)))
    if (on) setPicker(null)
  }

  /** First names of the OTHER people holding an authority — the picker's "Also held by". */
  const holdersOf = (except: string) => (actionKey: string) =>
    (matrix?.employees ?? [])
      .filter(e => e.id !== except && e.role !== 'admin' && edits.effectiveOf(e.id, selectedKey ?? '')[actionKey] === true)
      .map(e => e.name.split(' ')[0])

  // ── Render ────────────────────────────────────────────────────────────────

  if (matrixQuery.isPending || deptsQuery.isPending) return <ControlCenterSkeleton />

  const employees = matrix?.employees ?? []
  const q = search.trim().toLowerCase()
  const visible = employees.filter(e =>
    (includeInactive || e.is_active) &&
    (!q || e.name.toLowerCase().includes(q)) &&
    (!deptFilter || e.team === deptFilter),
  )
  const canOpen = visible.filter(isOpen)
  const cannot = visible.filter(e => !isOpen(e))
  const openCount = employees.filter(e => e.role !== 'admin' && isOpen(e)).length
  const authoritiesGranted = selectedKey
    ? employees.reduce((n, e) => n + authoritiesFor(selectedKey, actionKeys).filter(a => edits.effectiveOf(e.id, selectedKey)[a.actionKey] === true && (a.perPerson || e.role !== 'admin')).length, 0)
    : 0
  const hidden = selectedKey ? hiddenActions(selectedKey, actionKeys) : []
  const hiddenNames = (mod: PermissionModuleRef) => hidden.map(k => mod.actions.find(a => a.actionKey === k)?.displayName ?? k)

  const row = (emp: AccessMatrixEmployee) => {
    if (!selectedKey) return null
    const effective = edits.effectiveOf(emp.id, selectedKey)
    const base = edits.baseOf(emp.id, selectedKey)
    const locked = emp.role === 'admin'
    const level = locked ? 'viewer' : detectOfferedLevel(selectedKey, actionKeys, effective)
    const unsaved = edits.isDirty(emp.id, selectedKey)
    const pickerOpen = picker === emp.id
    const confirmOpen = offConfirm?.employeeId === emp.id
    return (
      <div key={emp.id} className={`${styles.mrow}${unsaved ? ` ${styles.mrowChanged}` : ''}`}>
        <div className={styles.cellPerson}>
          <Avatar name={emp.name} size={32} />
          <div style={{ minWidth: 0 }}>
            <div className={styles.mrowName}>
              {emp.name}
              {locked && <CcBadge tone="gray">Admin</CcBadge>}
              {!emp.is_active && <ActiveBadge active={false} />}
              {unsaved && <span className={styles.unsaved}>Unsaved</span>}
            </div>
            <div className={styles.rowNote} style={{ marginTop: 1 }}>{deptLabel(emp.team)}</div>
          </div>
        </div>
        <div className={styles.mrowRight}>
          <LevelControl
            moduleKey={selectedKey}
            moduleName={selected?.displayName ?? selectedKey}
            personName={emp.name}
            actionKeys={actionKeys}
            level={level}
            locked={locked}
            onChange={lv => changeLevel(emp, lv)}
          />
          <div className={styles.setBy}>
            {setByText(emp.modules[selectedKey] ?? [], entryAction, emp.role, { defaultOn: words?.defaultOn, unsaved })}
          </div>
        </div>
        <div className={styles.mrowAuth}>
          <span className={styles.mrowAuthLabel}>Authorities</span>
          <AuthorityChips
            moduleKey={selectedKey}
            actionKeys={actionKeys}
            effective={effective}
            baseEffective={base}
            locked={locked}
            perPersonOnly={locked}
            canAdd={isOpen(emp)}
            pickerOpen={pickerOpen}
            onRemove={actionKey => toggleAuthority(emp, actionKey, false)}
            onOpenPicker={() => { setPicker(p => p === emp.id ? null : emp.id); setOffConfirm(null) }}
          />
        </div>
        {pickerOpen && (
          <div className={styles.mrowWide}>
            <AuthorityPicker
              moduleKey={selectedKey}
              moduleName={selected?.displayName ?? selectedKey}
              personName={emp.name}
              actionKeys={actionKeys}
              effective={effective}
              perPersonOnly={locked}
              holdersOf={holdersOf(emp.id)}
              onAdd={a => toggleAuthority(emp, a.actionKey, true)}
              onClose={() => setPicker(null)}
            />
          </div>
        )}
        {confirmOpen && (
          <div className={styles.mrowWide}>
            <OffConfirm
              moduleName={selected?.displayName ?? selectedKey}
              personName={emp.name}
              cleared={offConfirm.cleared}
              onConfirm={() => confirmOff(emp)}
              onCancel={() => setOffConfirm(null)}
            />
          </div>
        )}
      </div>
    )
  }

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
            const keys = m.actions.map(a => a.actionKey)
            const entry = entryActionForModule(keys)
            const n = employees.filter(e => e.role !== 'admin' && !!entry && edits.effectiveOf(e.id, m.moduleKey)[entry] === true).length
            const auths = employees.reduce((s, e) => s + authoritiesFor(m.moduleKey, keys).filter(a => edits.effectiveOf(e.id, m.moduleKey)[a.actionKey] === true && (a.perPerson || e.role !== 'admin')).length, 0)
            const isSelected = m.moduleKey === selectedKey
            return (
              <button
                key={m.moduleKey}
                type="button"
                className={`${styles.row}${isSelected ? ` ${styles.rowSelected}` : ''}`}
                aria-pressed={isSelected}
                onClick={() => selectModule(m.moduleKey)}
              >
                <span className={styles.rowIcon}><ModuleIcon moduleKey={m.moduleKey} size={15} /></span>
                <div className={styles.rowText}>
                  <div className={styles.rowName}>{m.displayName}</div>
                  <div className={styles.rowSub}>
                    {n} can open{auths ? ` · ${auths} ${auths === 1 ? 'authority' : 'authorities'} granted` : ''}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
        <div className={cc.muted} style={{ fontSize: 12, lineHeight: 1.45, padding: '0 2px' }}>
          Attendance &amp; Payroll are self-service; their management access is restricted to system administrators and is not granted here.
        </div>
      </div>

      {/* ── Workspace ────────────────────────────────────────────────────── */}
      <div className={styles.workspace}>
        {!selectedKey && (
          <CcEmpty
            message="Select a module to see who can open it and what each person can do."
            hint="The same control as People: Off or a level, and the authorities as chips."
          />
        )}

        {matrixQuery.isError && (
          <div className={cc.error}>{(matrixQuery.error as Error).message}</div>
        )}

        {selectedKey && selected && (
          <>
            <div className={styles.header}>
              <div className={styles.headerIdentity}>
                <span className={styles.headerIcon}><ModuleIcon moduleKey={selectedKey} size={22} /></span>
                <div style={{ minWidth: 0 }}>
                  <div className={styles.headerName}>{selected.displayName}</div>
                  <div className={styles.headerSub}>{blurbFor(selectedKey, selected.description)}</div>
                </div>
              </div>
              <div className={styles.headerStats}>
                <div className={styles.headerStat}>
                  <div className={styles.headerStatValue}>{openCount}</div>
                  <div className={styles.headerStatLabel}>Can open</div>
                </div>
                <div className={styles.headerStat}>
                  <div className={styles.headerStatValue}>{authoritiesGranted}</div>
                  <div className={styles.headerStatLabel}>Authorities granted</div>
                </div>
                <div className={styles.headerStat}>
                  <div className={styles.headerStatValue}>{authoritiesFor(selectedKey, actionKeys).length}</div>
                  <div className={styles.headerStatLabel}>Authorities available</div>
                </div>
              </div>
              {(hidden.length > 0 || words?.note) && (
                <div className={styles.headerRole} style={{ display: 'block' }}>
                  {hidden.length > 0 && (
                    <div className={cc.muted} style={{ fontSize: 12 }}>
                      Not offered: {hiddenNames(selected).join(', ')} — stored in the database but read by nothing.
                    </div>
                  )}
                  {words?.note && <div className={styles.rowNote}>{words.note}</div>}
                </div>
              )}
            </div>

            {/* A whole team in one move; the people below are individuals and win over their team. */}
            <TeamAccessCard
              moduleKey={selectedKey}
              moduleName={selected.displayName}
              onSaved={() => { void matrixQuery.refetch() }}
            />

            <CcToolbar>
              <div className={cc.search}>
                <Search size={13} strokeWidth={2} />
                <input
                  className={cc.control}
                  placeholder="Search name"
                  aria-label="Search employees"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              <select className={cc.control} aria-label="Department" value={deptFilter} onChange={e => setDeptFilter(e.target.value)}>
                <option value="">All departments</option>
                {depts.map(d => <option key={d.department_key} value={d.department_key}>{d.department_name}</option>)}
              </select>
              <label className={cc.check} style={{ fontSize: 12 }}>
                <input type="checkbox" checked={includeInactive} onChange={e => setIncludeInactive(e.target.checked)} />
                Include inactive
              </label>
              <span className={cc.count}>
                {visible.length === employees.length ? `${employees.length} employees` : `${visible.length} of ${employees.length}`}
              </span>
            </CcToolbar>

            {visible.length === 0 ? (
              <CcEmpty message="No employees match these filters." />
            ) : (
              <div className={styles.cards}>
                <div className={styles.sectionHead}><span className={styles.sectionTitle}>Can open <small>{canOpen.length}</small></span></div>
                {canOpen.map(row)}
                {cannot.length > 0 && (
                  <>
                    <div className={styles.sectionHead}><span className={styles.sectionTitle}>Cannot open <small>{cannot.length}</small></span></div>
                    {cannot.map(row)}
                  </>
                )}
              </div>
            )}

            <div className={styles.saveBar}>
              <div className={styles.saveBarText}>
                {dirty
                  ? <>
                      <b>{edits.changes().length} {edits.changes().length === 1 ? 'change' : 'changes'}</b> · not saved yet
                      <ul className={styles.saveBarList}>{edits.changes().map(c => <li key={`${c.employeeId}:${c.moduleKey}`}>{c.text}</li>)}</ul>
                    </>
                  : 'No unsaved changes'}
              </div>
              {edits.saveError && <span className={cc.error} style={{ marginTop: 0 }}>{edits.saveError}</span>}
              <button className="boe-btn boe-btn-ghost" onClick={() => { edits.discard(); setOffConfirm(null) }} disabled={!dirty || edits.saving}>
                Discard
              </button>
              <button className="boe-btn boe-btn-primary" onClick={() => void edits.save(() => matrixQuery.refetch())} disabled={!dirty || edits.saving}>
                {edits.saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
