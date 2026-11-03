'use client'

// CONTROL CENTER → SALES TEAM. One row a person: what they are in Sales, whether leads can be given to them, and whose
// leads a senior may read.
//
// THE SCREEN GRANTS NOTHING ITSELF. The rights go through the same permission route as Access → People, so they carry
// the same audit trail. Juniors and "Can be given leads" go through set_sales_lead_juniors and set_sales_lead_holding,
// Admin only in the database. Everything is read back afterwards, so what the row shows is what the database holds.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { CcSection } from '@/components/controlCenter/CcPrimitives'
import {
  fetchSalesTeam, holdChoice, holdsByDefault, rightsFor, roleOf, saveHolding, saveJuniors, SALES_ROLES, type SalesRole, type SalesTeamMember,
} from '@/lib/salesLeads/team'

const SELECT: React.CSSProperties = { height: 36, padding: '0 8px', border: '1px solid #CFC8BF', borderRadius: 8, background: '#fff', font: '500 13px var(--boe-font-body)', color: '#303536', width: '100%' }

// hold: the choice made for this person, or null for what their job means (holdsByDefault).
type Draft = { role: SalesRole; adds: boolean; juniors: string[]; hold: boolean | null }
const draftOf = (m: SalesTeamMember): Draft => ({ role: roleOf(m), adds: m.create, juniors: m.juniors, hold: m.hold_set })

export function SalesTeamTab() {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<SalesTeamMember[] | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [added, setAdded] = useState<string[]>([])
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [messages, setMessages] = useState<Record<string, { ok: boolean; text: string }>>({})

  const load = useCallback(async () => {
    setLoadError('')
    try {
      const team = await fetchSalesTeam(supabase)
      setRows(team)
      setDrafts(Object.fromEntries(team.map(m => [m.id, draftOf(m)])))
    } catch (e) {
      setRows(null)
      setLoadError((e as Error).message)
    }
  }, [supabase])

  // The same shape the Order Visibility tab uses: the read is started from a callback.
  useEffect(() => {
    const startFetch = () => { void load() }
    startFetch()
  }, [load])

  const shown = (rows ?? []).filter(m => m.is_admin || m.view || m.candidate || added.includes(m.id))
  const others = (rows ?? []).filter(m => !shown.includes(m))
  const juniorsOf = (rows ?? []).filter(m => m.candidate && !m.is_admin)

  async function save(m: SalesTeamMember) {
    const draft = drafts[m.id]
    setBusy(m.id)
    setMessages(x => ({ ...x, [m.id]: { ok: true, text: '' } }))
    try {
      const changes = rightsFor(m, draft.role, draft.adds)
      if (changes.length > 0) {
        const { data: { session } } = await supabase.auth.getSession()
        const res = await fetch(`/api/control-center/permissions/employees/${m.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
          body: JSON.stringify({ changes }),
        })
        if (!res.ok) throw new Error('The rights could not be saved. Try again.')
      }
      await saveJuniors(supabase, m.id, draft.role === 'sales' ? draft.juniors : [])
      const hold = draft.role === 'none' ? null : draft.hold
      if (hold !== m.hold_set) await saveHolding(supabase, m.id, hold)
      await load()
      setMessages(x => ({ ...x, [m.id]: { ok: true, text: 'Saved' } }))
    } catch (e) {
      setMessages(x => ({ ...x, [m.id]: { ok: false, text: (e as Error).message } }))
    } finally {
      setBusy(null)
    }
  }

  const set = (id: string, patch: Partial<Draft>) => setDrafts(d => ({ ...d, [id]: { ...d[id], ...patch } }))
  const changed = (m: SalesTeamMember) => JSON.stringify({ ...drafts[m.id], juniors: [...drafts[m.id].juniors].sort() }) !== JSON.stringify({ ...draftOf(m), juniors: [...m.juniors].sort() })

  return (
    <CcSection title="Sales team" description="Who uses Sales, who sees everyone, and whose leads a senior can read. A salesperson always sees their own leads.">
      {loadError && <p style={{ color: '#A12438', fontSize: 13 }}>{loadError}</p>}
      {!rows && !loadError && <p style={{ color: '#686D6C', fontSize: 13 }}>Loading...</p>}
      {rows && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shown.map(m => {
            const d = drafts[m.id]
            if (!d) return null
            const msg = messages[m.id]
            return (
              <div key={m.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 1fr) minmax(190px, 1.2fr) minmax(0, 2fr) auto', alignItems: 'start', gap: 12, padding: '10px 12px', border: '1px solid #ECE7E0', borderRadius: 10 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: '#303536', paddingTop: 7 }}>{m.name}</div>
                {m.is_admin ? <div style={{ fontSize: 13, color: '#686D6C', paddingTop: 7 }}>Admin: everything</div> : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <select aria-label={`What ${m.name} is in Sales`} style={SELECT} value={d.role} onChange={e => {
                      const role = e.target.value as SalesRole
                      set(m.id, { role, hold: d.hold === null ? null : holdChoice(role, d.hold) })
                    }}>
                      {SALES_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                    <span style={{ fontSize: 12, color: '#686D6C' }}>{SALES_ROLES.find(r => r.value === d.role)?.hint}</span>
                  </div>
                )}
                {m.is_admin ? <div /> : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                    {d.role !== 'none' && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#303536', minHeight: 28 }}>
                        <input type="checkbox" checked={d.hold ?? holdsByDefault(d.role)} onChange={e => set(m.id, { hold: holdChoice(d.role, e.target.checked) })} />
                        Can be given leads
                      </label>
                    )}
                    {d.role !== 'none' && d.role !== 'lead_manager' && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#303536', minHeight: 28 }}>
                        <input type="checkbox" checked={d.adds} onChange={e => set(m.id, { adds: e.target.checked })} />Can add leads
                      </label>
                    )}
                    {d.role === 'sales' && (
                      <details>
                        <summary style={{ cursor: 'pointer', fontSize: 13, color: '#303536', minHeight: 28 }}>
                          {d.juniors.length ? `Can read the leads of ${d.juniors.length} ${d.juniors.length === 1 ? 'person' : 'people'}` : 'Senior: can read the leads of...'}
                        </summary>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 2, paddingTop: 6 }}>
                          {juniorsOf.filter(j => j.id !== m.id).map(j => (
                            <label key={j.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#303536', minHeight: 28 }}>
                              <input type="checkbox" checked={d.juniors.includes(j.id)}
                                onChange={e => set(m.id, { juniors: e.target.checked ? [...d.juniors, j.id] : d.juniors.filter(x => x !== j.id) })} />{j.name}
                            </label>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                )}
                {m.is_admin ? <div /> : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', minHeight: 36 }}>
                    {msg?.text && <span role={msg.ok ? 'status' : 'alert'} style={{ fontSize: 12.5, color: msg.ok ? '#2F7D4F' : '#A12438' }}>{msg.text}</span>}
                    <button type="button" className="boe-btn boe-btn-secondary" style={{ height: 36 }} disabled={busy === m.id || !changed(m)} onClick={() => void save(m)}>
                      {busy === m.id ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
          {others.length > 0 && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#686D6C', marginTop: 6 }}>
              Add somebody else
              <select aria-label="Add somebody else" style={{ ...SELECT, maxWidth: 260 }} value="" onChange={e => setAdded(a => [...a, e.target.value])}>
                <option value="">Choose a person</option>
                {others.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </label>
          )}
        </div>
      )}
    </CcSection>
  )
}
