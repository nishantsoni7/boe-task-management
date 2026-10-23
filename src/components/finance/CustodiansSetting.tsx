'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { readHandoverRecipients, type HandoverRecipient } from '@/lib/finance/handover'
import { useCashJourneyActions } from '@/hooks/queries/useCashJourneys'

/**
 * Who receives cash for the company. A payment's journey closes when its money
 * reaches one of these people. Administrators change it; set_finance_cash_custodians
 * refuses anybody else and refuses an empty list.
 */
export function CustodiansSetting({ current, isAdmin }: { current: { id: string; fullName: string }[]; isAdmin: boolean }) {
  const [editing, setEditing] = useState(false)
  const [people, setPeople] = useState<HandoverRecipient[]>([])
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const { setCustodians } = useCashJourneyActions()

  useEffect(() => {
    if (!editing) return
    let live = true
    void createClient().rpc('finance_handover_recipients').then((res: { data: unknown }) => {
      if (live) setPeople(readHandoverRecipients(res.data))
    })
    return () => { live = false }
  }, [editing])

  // The editor lists everyone but the admin themselves (that is what the
  // recipients door returns), so the current custodians are added back in.
  const everyone = [...current.filter(c => !people.some(p => p.id === c.id)), ...people]
    .sort((a, b) => a.fullName.localeCompare(b.fullName))

  const save = async () => {
    setError(null)
    try { await setCustodians.mutateAsync([...chosen]); setEditing(false) }
    catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.') }
  }

  return (
    <section className="boe-cj-footer" aria-label="Who receives cash for the company">
      <span>
        <strong>Receives cash for the company:</strong>{' '}
        {current.length ? current.map(c => c.fullName).join(', ') : 'nobody set'}. A journey closes when its money reaches them.
      </span>
      {isAdmin && !editing && (
        <button type="button" className="boe-btn boe-btn-text" style={{ minHeight: 28, padding: '2px 8px', marginLeft: 'auto' }} onClick={() => { setChosen(new Set(current.map(c => c.id))); setEditing(true) }}>
          Change
        </button>
      )}
      {editing && (
        <div style={{ flex: '1 1 100%' }}>
          <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid #E4DED7', borderRadius: 8, marginBottom: 10 }}>
            {everyone.map(p => (
              <label key={p.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 12px', fontSize: 14, cursor: 'pointer' }}>
                <input type="checkbox" checked={chosen.has(p.id)}
                  onChange={() => setChosen(prev => { const n = new Set(prev); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n })} />
                {p.fullName}
              </label>
            ))}
          </div>
          {error && <div className="boe-handover-error" role="alert" style={{ marginBottom: 8 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="boe-btn boe-btn-secondary" onClick={() => setEditing(false)} disabled={setCustodians.isPending}>Cancel</button>
            <button type="button" className="boe-btn boe-btn-primary" onClick={() => void save()} disabled={setCustodians.isPending || chosen.size === 0}>
              {setCustodians.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
