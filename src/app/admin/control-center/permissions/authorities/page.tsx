'use client'

// Access › Authorities.
//
// Every decision that is granted to a named person, in one list: who can
// approve a PI, see every payment, move money, run every meeting. This is the
// screen for "who can…?" questions. Each row is one protected, enforced
// action from the catalogue (src/lib/permissions/accessCatalog.ts) with its
// meaning, what it needs, and the people who hold it; Administrators hold
// every one of them by role except the ones granted per person.
//
// Reads come from the access matrix; adding or removing a person writes a
// pending edit over it and saves through the same per-employee PUT People
// uses, with the same shared rule, so this screen can never store something
// People or Modules would not.
//
// The Order Setup settings that decide access-like things (who reviews PI
// handoffs, whose orders a salesperson sees, who is told when an Order
// changes) stay where they are and are linked from here — the owner's
// decision of 2026-10-29.

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { ControlCenterSkeleton } from '@/components/layout/ControlCenterSkeleton'
import { Avatar } from '@/components/ui/atoms'
import { cc, CcEmpty } from '@/components/controlCenter/CcPrimitives'
import { useAccessMatrix, useAdminMembers, NO_MEMBERS, type AccessMatrixEmployee } from '@/hooks/queries/useControlCenterData'
import { useAccessMatrixEdits } from '@/components/controlCenter/accessEdits'
import {
  MODULE_WORDS,
  authoritiesFor,
  desiredWithAuthority,
  isSelfServiceModuleKey,
  type CatalogAuthority,
} from '@/lib/permissions/accessCatalog'
import styles from '../permissions.module.css'

type Group = 'Orders' | 'Money' | 'Work' | 'Sales' | 'Sourcing' | 'People & assets'
const GROUPS: Group[] = ['Orders', 'Money', 'Work', 'Sales', 'Sourcing', 'People & assets']
const CC = '/admin/control-center'

type SettingRow = {
  group: Group
  label: string
  meaning: string
  needs: string
  where: string
  href: string
  value: string
}

export default function AuthoritiesPage() {
  return (
    <Suspense fallback={<ControlCenterSkeleton />}>
      <AuthoritiesPageInner />
    </Suspense>
  )
}

function AuthoritiesPageInner() {
  const supabase = useMemo(() => createClient(), [])
  const matrixQuery = useAccessMatrix()
  const matrix = matrixQuery.data ?? null
  const members = useAdminMembers().data ?? NO_MEMBERS
  const edits = useAccessMatrixEdits(matrix)

  const [search, setSearch] = useState('')
  const [group, setGroup] = useState<'all' | Group>('all')
  const [picker, setPicker] = useState<{ moduleKey: string; actionKey: string } | null>(null)

  // The one Order Setup value worth reading here: the person who accepts PI
  // handoffs. The same admin-only read Order Setup › Operations Handoff makes.
  const [reviewerId, setReviewerId] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from('order_operations_reviewers')
        .select('user_id')
        .eq('duty', 'pi_handoff')
        .maybeSingle()
      setReviewerId((data as { user_id: string | null } | null)?.user_id ?? null)
    }
    void load()
  }, [supabase])

  const dirty = edits.pending.size > 0
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  if (matrixQuery.isPending) return <ControlCenterSkeleton />
  if (matrixQuery.isError || !matrix) return <div className={cc.error}>{(matrixQuery.error as Error)?.message ?? 'Could not read access.'}</div>

  const employees = matrix.employees
  const admins = employees.filter(e => e.role === 'admin')
  const nameOf = (id: string | null) => (id ? employees.find(e => e.id === id)?.name ?? null : null)
  const first = (e: AccessMatrixEmployee) => e.name.split(' ')[0]

  const holdersOf = (moduleKey: string, a: CatalogAuthority) =>
    employees.filter(e => (a.perPerson || e.role !== 'admin') && edits.effectiveOf(e.id, moduleKey)[a.actionKey] === true)

  const q = search.trim().toLowerCase()
  const matches = (...texts: string[]) => !q || texts.some(t => t.toLowerCase().includes(q))

  const settings: SettingRow[] = [
    {
      group: 'Orders', label: 'Reviews PI handoffs for Operations',
      meaning: 'One person accepts each approved PI version for production, or asks for clarification.',
      needs: 'Open Order Management', where: 'Order Setup › Operations Handoff', href: `${CC}?tab=operations-handoff`,
      value: reviewerId === undefined ? 'Loading…' : (nameOf(reviewerId) ?? 'Nobody assigned'),
    },
    {
      group: 'Orders', label: 'Whose orders a salesperson sees',
      meaning: 'Per sales candidate: their own, selected colleagues’, or every sales candidate’s orders. Only the owner account can change it.',
      needs: 'Open Order Management', where: 'Order Setup › Order Visibility', href: `${CC}?tab=order-visibility`, value: 'Per salesperson',
    },
    {
      group: 'Orders', label: 'Who is told when an Order changes',
      meaning: 'Four switches: Super Admin level, Administrators, the salesperson on the Order, the BDM department. A switchboard, not a permission.',
      needs: '—', where: 'Order Setup › Notifications', href: `${CC}?tab=order-notifications`, value: 'Four switches',
    },
    {
      group: 'People & assets', label: 'Included in Performance',
      meaning: 'Whether a person is measured and ranked. Not an access decision; listed because it is often confused with one.',
      needs: '—', where: 'People › Employee', href: `${CC}/people`,
      value: `${members.filter(m => !m.is_deleted && m.is_active && m.performance_tracking_enabled !== false).length} people measured`,
    },
  ]

  const visibleGroups = GROUPS.filter(g => group === 'all' || group === g)

  return (
    <div className={styles.register}>
      <div className={cc.toolbar}>
        <div className={cc.search}>
          <Search size={13} strokeWidth={2} />
          <input
            className={cc.control}
            placeholder="Who can approve a PI? Who sees all payments?"
            aria-label="Search authorities"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className={styles.filters} role="group" aria-label="Area">
          {(['all', ...GROUPS] as const).map(g => (
            <button
              key={g}
              type="button"
              className={`${styles.filterBtn}${group === g ? ` ${styles.filterBtnOn}` : ''}`}
              aria-pressed={group === g}
              onClick={() => setGroup(g)}
            >
              {g === 'all' ? 'All' : g}
            </button>
          ))}
        </div>
      </div>

      <div className={cc.note}>
        Every decision that is given to a named person, in one place. <strong>Administrators hold all of these by role</strong>, except
        the ones marked <em>per person</em>, which are granted to anyone, Administrators included.
      </div>

      {visibleGroups.map(g => {
        const mods = matrix.modules
          .filter(m => !isSelfServiceModuleKey(m.moduleKey) && MODULE_WORDS[m.moduleKey]?.group === g)
        const rows = mods.flatMap(m => authoritiesFor(m.moduleKey, m.actions.map(a => a.actionKey)).map(a => ({ m, a })))
          .filter(({ m, a }) => matches(a.label, a.meaning, m.displayName))
        const sets = settings.filter(s => s.group === g && matches(s.label, s.meaning))
        if (rows.length === 0 && sets.length === 0) return null
        return (
          <div key={g}>
            <div className={styles.groupHead}>
              <span className={styles.groupTitle}>{g}</span>
              <span className={styles.groupSub}>{mods.map(m => m.displayName).join(' · ')}</span>
            </div>
            <div className={styles.aList}>
              {rows.map(({ m, a }) => {
                const actionKeys = m.actions.map(x => x.actionKey)
                const holders = holdersOf(m.moduleKey, a)
                const roleHolders = a.perPerson ? [] : admins
                const open = picker?.moduleKey === m.moduleKey && picker.actionKey === a.actionKey
                const candidates = employees.filter(e => !holders.includes(e) && (a.perPerson || e.role !== 'admin'))
                return (
                  <div key={`${m.moduleKey}:${a.actionKey}`} className={styles.aRow}>
                    <div>
                      <div className={styles.aName}>{a.label}</div>
                      <div className={styles.aModule}>{m.displayName}{a.perPerson ? ' · per person' : ''}</div>
                    </div>
                    <div className={styles.aMeaning}>
                      {a.meaning}
                      <span className={styles.aNeeds}>Needs: {a.needs}</span>
                    </div>
                    <div className={styles.aHolders}>
                      {roleHolders.map(e => (
                        <span key={e.id} className={`${styles.personChip} ${styles.personChipRole}`} title="By role">
                          <Avatar name={e.name} size={18} />{first(e)}
                        </span>
                      ))}
                      {holders.map(e => {
                        const isNew = edits.baseOf(e.id, m.moduleKey)[a.actionKey] !== true
                        return (
                          <span key={e.id} className={`${styles.personChip}${isNew ? ` ${styles.personChipNew}` : ''}`}>
                            <Avatar name={e.name} size={18} />{first(e)}
                            <button
                              type="button"
                              className={styles.personChipX}
                              aria-label={`Remove ${a.label} from ${e.name}`}
                              onClick={() => edits.setDesired(e.id, m.moduleKey, desiredWithAuthority(m.moduleKey, actionKeys, a.actionKey, false, edits.effectiveOf(e.id, m.moduleKey)))}
                            >×</button>
                          </span>
                        )
                      })}
                      {holders.length === 0 && roleHolders.length === 0 && <span className={styles.aNone}>nobody</span>}
                      {candidates.length > 0 && (
                        <button type="button" className={styles.chipAdd} aria-expanded={open} onClick={() => setPicker(open ? null : { moduleKey: m.moduleKey, actionKey: a.actionKey })}>
                          + Add person
                        </button>
                      )}
                    </div>
                    {open && (
                      <div className={styles.picker} style={{ gridColumn: '1 / -1' }} role="group" aria-label={`Give ${a.label} to…`}>
                        <div className={styles.pickerHead}>
                          <span>Give “{a.label}” to…</span>
                          <button type="button" className={cc.linkBtn} onClick={() => setPicker(null)}>Close</button>
                        </div>
                        <div className={styles.pickerPeople}>
                          {candidates.map(e => {
                            const opens = edits.effectiveOf(e.id, m.moduleKey)[actionKeys.includes('view') ? 'view' : 'use'] !== true && e.role !== 'admin'
                            return (
                              <button
                                key={e.id}
                                type="button"
                                className="boe-btn boe-btn-ghost"
                                title={opens ? `Will also open ${m.displayName} for them` : undefined}
                                onClick={() => {
                                  edits.setDesired(e.id, m.moduleKey, desiredWithAuthority(m.moduleKey, actionKeys, a.actionKey, true, edits.effectiveOf(e.id, m.moduleKey)))
                                  setPicker(null)
                                }}
                              >
                                <Avatar name={e.name} size={18} />
                                <span style={{ marginLeft: 6 }}>{e.name}</span>
                                {!e.is_active && <span className={cc.muted} style={{ marginLeft: 6, fontSize: 12 }}>· inactive</span>}
                                {opens && <span className={cc.muted} style={{ marginLeft: 6, fontSize: 12 }}>· opens module</span>}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
              {sets.map(s => (
                <div key={s.label} className={styles.aRow}>
                  <div>
                    <div className={styles.aName}>{s.label}</div>
                    <div className={styles.aModule}>Setting · {s.where}</div>
                  </div>
                  <div className={styles.aMeaning}>
                    {s.meaning}
                    <span className={styles.aNeeds}>Needs: {s.needs}</span>
                  </div>
                  <div className={styles.aHolders}>
                    <span className={`${styles.personChip} ${styles.personChipSetting}`}>{s.value}</span>
                    <Link href={s.href} className="boe-btn boe-btn-ghost" style={{ textDecoration: 'none' }}>Open</Link>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })}

      {visibleGroups.every(g => {
        const mods = matrix.modules.filter(m => MODULE_WORDS[m.moduleKey]?.group === g)
        const rows = mods.flatMap(m => authoritiesFor(m.moduleKey, m.actions.map(a => a.actionKey)).map(a => ({ m, a }))).filter(({ m, a }) => matches(a.label, a.meaning, m.displayName))
        return rows.length === 0 && settings.filter(s => s.group === g && matches(s.label, s.meaning)).length === 0
      }) && <CcEmpty message="No authority matches that." />}

      {/* ── Save bar ─────────────────────────────────────────────────────── */}
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
        <button className="boe-btn boe-btn-ghost" onClick={edits.discard} disabled={!dirty || edits.saving}>Discard</button>
        <button className="boe-btn boe-btn-primary" onClick={() => void edits.save(() => matrixQuery.refetch())} disabled={!dirty || edits.saving}>
          {edits.saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}
