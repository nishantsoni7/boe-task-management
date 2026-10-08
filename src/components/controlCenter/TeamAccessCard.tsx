'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cc, CcSection } from '@/components/controlCenter/CcPrimitives'
import { useModuleTeamAccess, type TeamAccessDepartment } from '@/hooks/queries/useControlCenterData'
import {
  TEAM_ACCESS_LABELS, TEAM_ACCESS_STATES, describeTeamRules, type TeamAccessState,
} from '@/lib/permissions/departmentAccess'

// Control Center › Access › By Module › Team access.
//
// One row per department: Allowed / Not set / Blocked for this module's entry
// permission. It is the quick way to give a whole sales team (or any other
// team) the module; the table below it adds or removes INDIVIDUALS, and an
// individual's own setting always wins over their team's. A system
// Administrator's access is their role and is not affected either way.

export function TeamAccessCard({ moduleKey, moduleName, onSaved }: {
  moduleKey: string
  moduleName: string
  /** Called after a successful save, so the people table below re-reads who now has access. */
  onSaved: () => void
}) {
  const q = useModuleTeamAccess(moduleKey)
  const [pending, setPending] = useState<Record<string, TeamAccessState>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  if (q.isPending) return null
  if (q.isError) {
    // A module with no single entry permission cannot be granted to a team; that is
    // a normal answer, not a failure to alarm anyone with.
    return (
      <CcSection title="Team access">
        <div className={cc.muted} style={{ fontSize: 12.5 }}>{(q.error as Error).message}</div>
      </CcSection>
    )
  }

  const depts = q.data.departments
  const stateOf = (d: TeamAccessDepartment): TeamAccessState => pending[d.departmentKey] ?? d.state
  const dirtyKeys = Object.keys(pending).filter(k => pending[k] !== depts.find(d => d.departmentKey === k)?.state)

  function choose(d: TeamAccessDepartment, next: TeamAccessState) {
    setSaved(false)
    setPending(prev => {
      const copy = { ...prev }
      if (next === d.state) delete copy[d.departmentKey]
      else copy[d.departmentKey] = next
      return copy
    })
  }

  async function save() {
    setSaving(true); setError(''); setSaved(false)
    try {
      const { data: { session } } = await createClient().auth.getSession()
      if (!session) throw new Error('Your session has expired. Sign in again.')
      const res = await fetch(`/api/control-center/permissions/modules/${moduleKey}/departments`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ changes: dirtyKeys.map(k => ({ departmentKey: k, state: pending[k] })) }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.error ?? 'Save failed')
      setPending({})
      await q.refetch()
      setSaved(true)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed. Check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <CcSection
      title="Team access"
      description={`Give a whole team access to ${moduleName}. Anyone you set individually below still wins over their team.`}
    >
      <div role="group" aria-label={`Team access to ${moduleName}`} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {depts.map(d => {
          const state = stateOf(d)
          const unsaved = pending[d.departmentKey] !== undefined
          return (
            <div
              key={d.departmentKey}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 10px',
                border: '1px solid rgba(0,0,0,0.08)', borderRadius: 8, background: unsaved ? '#FFFBEB' : '#fff',
              }}
            >
              <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                <div className={cc.personName}>
                  {d.departmentName}
                  {!d.isActive && <span className={cc.muted} style={{ marginLeft: 6, fontSize: 11 }}>inactive</span>}
                  {unsaved && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: '#B45309' }}>Unsaved</span>}
                </div>
                <div className={cc.personSub}>{d.people} {d.people === 1 ? 'person' : 'people'}</div>
              </div>
              <select
                className={`${cc.control} ${cc.inlineSelect}`}
                aria-label={`${d.departmentName}: access to ${moduleName}`}
                value={state}
                onChange={e => choose(d, e.target.value as TeamAccessState)}
                title={TEAM_ACCESS_LABELS[state].hint}
              >
                {TEAM_ACCESS_STATES.map(s => <option key={s} value={s}>{TEAM_ACCESS_LABELS[s].label}</option>)}
              </select>
            </div>
          )
        })}
      </div>

      <div className={cc.muted} style={{ fontSize: 12, margin: '8px 2px 0' }}>
        {describeTeamRules(depts.map(d => ({ name: d.departmentName, state: d.state })))}
        {' '}Allowed = the team can open it · Blocked = it cannot, unless given access individually · Not set = the default decides.
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
        <button type="button" className="boe-btn boe-btn-primary" disabled={saving || dirtyKeys.length === 0} onClick={save}>
          {saving ? 'Saving…' : dirtyKeys.length ? `Save team access (${dirtyKeys.length})` : 'Save team access'}
        </button>
        {dirtyKeys.length > 0 && !saving && (
          <button type="button" className="boe-btn" onClick={() => { setPending({}); setError('') }}>Discard</button>
        )}
        {saved && <span role="status" style={{ fontSize: 12.5, color: '#166534', fontWeight: 600 }}>Saved.</span>}
        {error && <span role="alert" style={{ fontSize: 12.5, color: '#B3121F', fontWeight: 600 }}>{error}</span>}
      </div>
    </CcSection>
  )
}
