'use client'

// Pricing > Wood rates: each wood and what it costs per cubic foot (20270725000000). Owner rule: for another wood,
// the wood share of a wooden structure changes and the rest stays, so only the ratio between two woods is used.

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { num, shortDate } from '@/lib/pricing/training/doc'
import { fetchAccess, fetchWoods, removeWood, saveWood, trainingKeys, type TrainingError, type Wood } from '@/lib/pricing/training/api'
import t from './training.module.css'

export function WoodRates() {
  const supabase = useMemo(() => createClient(), [])
  const qc = useQueryClient()
  const access = useQuery({ queryKey: trainingKeys.access, queryFn: () => fetchAccess(supabase), retry: false })
  const woods = useQuery({ queryKey: trainingKeys.woods, queryFn: () => fetchWoods(supabase), enabled: access.isSuccess, retry: false })
  const [typed, setTyped] = useState<Record<string, string>>({})
  const [name, setName] = useState('')
  const [rate, setRate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [removed, setRemoved] = useState<Wood | null>(null)
  const may = !!access.data?.create
  const err = (access.error ?? woods.error) as TrainingError | null

  async function run(work: () => Promise<unknown>) {
    setError(''); setBusy(true)
    try { await work(); await qc.invalidateQueries({ queryKey: trainingKeys.woods }) } catch (e) { setError((e as TrainingError)?.message || 'Something went wrong. Try again.') } finally { setBusy(false) }
  }
  const add = () => {
    if (name.trim().length < 2) { setError('Give the wood a name.'); return }
    if (rate.trim() && num(rate) === null) { setError('The rate must be a number.'); return }
    return run(async () => { await saveWood(supabase, name.trim(), num(rate)); setName(''); setRate('') })
  }
  const change = (w: Wood) => {
    const v = typed[w.name]
    if (v === undefined || v.trim() === '' || num(v) === Number(w.rate)) return
    if (num(v) === null || num(v) === 0) { setError(`The rate for ${w.name} must be a number above zero.`); return }
    return run(async () => { await saveWood(supabase, w.name, num(v)); setTyped(x => { const y = { ...x }; delete y[w.name]; return y }) })
  }
  const remove = (w: Wood) => run(async () => { await removeWood(supabase, w.name); setRemoved(w) })
  const undo = () => { const w = removed; if (!w) return; setRemoved(null); return run(() => saveWood(supabase, w.name, w.rate === null ? null : Number(w.rate))) }

  return (
    <div className={t.wrap}>
      <div className={t.head}>
        <div>
          <h1 className={t.h1}>Wood rates</h1>
          <p className={t.sub}>What you pay for each wood, per cubic foot. It is used to work out a taught price in another wood: the wood share changes, the rest stays.</p>
        </div>
      </div>
      {err && <div className={`boe-callout ${err.kind === 'not_set_up' ? 'boe-callout-warning' : 'boe-callout-error'}`} role="alert">{err.message}</div>}
      {error && <div className="boe-callout boe-callout-error" role="alert">{error}</div>}
      {removed && <div className="boe-callout boe-callout-info" role="status"><span>Removed {removed.name}.</span> <button type="button" className="boe-btn boe-btn-text" onClick={undo}>Undo</button></div>}

      {woods.isSuccess && (
        <div className={t.card}>
          <div className={t.cardH}>Woods</div>
          {woods.data.length === 0 && <div className={t.cardB}><p className={t.muted} style={{ margin: 0 }}>No woods yet. Add the ones you use most, such as mango, sheesham and teak.</p></div>}
          {woods.data.map(w => (
            <div key={w.name} className={t.wood}>
              <b>{w.name}</b>
              {may
                ? <label className={t.field}><span className="boe-input-label">Rate per cu ft (₹)</span><input className="boe-input" inputMode="decimal" value={typed[w.name] ?? (w.rate === null ? '' : String(Number(w.rate)))} placeholder="Not entered yet" onChange={e => setTyped(x => ({ ...x, [w.name]: e.target.value }))} onBlur={() => change(w)} onKeyDown={e => { if (e.key === 'Enter') change(w) }} /></label>
                : <span>{w.rate === null ? 'Not entered yet' : `₹${Number(w.rate).toLocaleString('en-IN')} per cu ft`}</span>}
              <span className={t.muted}>{w.rate === null ? 'No rate yet: a price in this wood cannot be worked out' : `Changed ${shortDate(w.updated_at)}${w.updated_by_name ? ` by ${w.updated_by_name}` : ''}`}</span>
              {may && <button type="button" className={t.iconBtn} disabled={busy} onClick={() => remove(w)} aria-label={`Remove ${w.name}`}><Trash2 size={16} aria-hidden /></button>}
            </div>
          ))}
          {may && (
            <div className={t.wood}>
              <label className={t.field}><span className="boe-input-label">Add a wood</span><input className="boe-input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Sheesham" maxLength={40} /></label>
              <label className={t.field}><span className="boe-input-label">Rate per cu ft (₹)</span><input className="boe-input" inputMode="decimal" value={rate} onChange={e => setRate(e.target.value)} placeholder="Can be added later" onKeyDown={e => { if (e.key === 'Enter') add() }} /></label>
              <span />
              <button type="button" className="boe-btn boe-btn-primary" disabled={busy} onClick={add}><Plus size={16} aria-hidden /> Add</button>
            </div>
          )}
        </div>
      )}
      {access.data && !may && <div className="boe-callout boe-callout-info">You can read the wood rates. To change them, ask an admin for Create on Pricing.</div>}
    </div>
  )
}
