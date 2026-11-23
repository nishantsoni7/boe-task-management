'use client'

// Pricing > Rates: each wood and what it costs per cubic foot (20270725000000), each metal with its density and what it
// costs per kg, and every rate ever set (20270823000000). Owner rule: for another wood, the wood share of a wooden
// structure changes and the rest stays. A rate is never lost when it changes: the history keeps it with its date.

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { num, shortDate } from '@/lib/pricing/training/doc'
import { fetchAccess, fetchMetals, fetchRateHistory, fetchWoods, removeMetal, removeWood, saveMetal, saveWood, trainingKeys, type Metal, type TrainingError, type Wood } from '@/lib/pricing/training/api'
import t from './training.module.css'

const inr = (v: number) => `₹${v.toLocaleString('en-IN')}`

export function WoodRates() {
  const supabase = useMemo(() => createClient(), [])
  const qc = useQueryClient()
  const access = useQuery({ queryKey: trainingKeys.access, queryFn: () => fetchAccess(supabase), retry: false })
  const woods = useQuery({ queryKey: trainingKeys.woods, queryFn: () => fetchWoods(supabase), enabled: access.isSuccess, retry: false })
  const metals = useQuery({ queryKey: trainingKeys.metals, queryFn: () => fetchMetals(supabase), enabled: access.isSuccess, retry: false })
  const history = useQuery({ queryKey: trainingKeys.rateHistory, queryFn: () => fetchRateHistory(supabase), enabled: access.isSuccess, retry: false })
  const [typed, setTyped] = useState<Record<string, string>>({})
  const [name, setName] = useState('')
  const [rate, setRate] = useState('')
  const [metal, setMetal] = useState({ name: '', density: '7850', rate: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [removed, setRemoved] = useState<{ wood: Wood } | { metal: Metal } | null>(null)
  const may = !!access.data?.create
  const err = (access.error ?? woods.error) as TrainingError | null

  async function run(work: () => Promise<unknown>) {
    setError(''); setBusy(true)
    try {
      await work()
      await Promise.all([trainingKeys.woods, trainingKeys.metals, trainingKeys.rateHistory].map(queryKey => qc.invalidateQueries({ queryKey })))
    } catch (e) { setError((e as TrainingError)?.message || 'Something went wrong. Try again.') } finally { setBusy(false) }
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
  const remove = (w: Wood) => run(async () => { await removeWood(supabase, w.name); setRemoved({ wood: w }) })

  // Metals: the typed boxes are keyed "<name>|density" and "<name>|rate".
  const metalKey = (m: Metal, k: 'density' | 'rate') => `metal:${m.name}|${k}`
  const changeMetal = (m: Metal, k: 'density' | 'rate') => {
    const v = typed[metalKey(m, k)]
    if (v === undefined || v.trim() === '' || num(v) === Number(m[k])) return
    if (num(v) === null || num(v) === 0) { setError(`The ${k === 'rate' ? 'rate' : 'density'} for ${m.name} must be a number above zero.`); return }
    return run(async () => {
      await saveMetal(supabase, m.name, k === 'density' ? num(v) : null, k === 'rate' ? num(v) : null)
      setTyped(x => { const y = { ...x }; delete y[metalKey(m, k)]; return y })
    })
  }
  const addMetal = () => {
    if (metal.name.trim().length < 2) { setError('Give the metal a name, such as MS tube and pipe.'); return }
    if (num(metal.density) === null) { setError('The density must be a number, such as 7850 for mild steel.'); return }
    if (metal.rate.trim() && num(metal.rate) === null) { setError('The rate must be a number.'); return }
    return run(async () => { await saveMetal(supabase, metal.name.trim(), num(metal.density)!, num(metal.rate)); setMetal({ name: '', density: '7850', rate: '' }) })
  }
  const dropMetal = (m: Metal) => run(async () => { await removeMetal(supabase, m.name); setRemoved({ metal: m }) })
  const undo = () => {
    const r = removed
    if (!r) return
    setRemoved(null)
    return 'wood' in r
      ? run(() => saveWood(supabase, r.wood.name, r.wood.rate === null ? null : Number(r.wood.rate)))
      : run(() => saveMetal(supabase, r.metal.name, Number(r.metal.density), r.metal.rate === null ? null : Number(r.metal.rate)))
  }

  return (
    <div className={t.wrap}>
      <div className={t.head}>
        <div>
          <h1 className={t.h1}>Wood and metal rates</h1>
          <p className={t.sub}>What you pay for each wood per cubic foot and for each metal per kg. Training uses them to work out a cut list or a metal frame; a taught price in another wood changes only its wood share. Every change is kept with its date.</p>
        </div>
      </div>
      {err && <div className={`boe-callout ${err.kind === 'not_set_up' ? 'boe-callout-warning' : 'boe-callout-error'}`} role="alert">{err.message}</div>}
      {error && <div className="boe-callout boe-callout-error" role="alert">{error}</div>}
      {removed && <div className="boe-callout boe-callout-info" role="status"><span>Removed {'wood' in removed ? removed.wood.name : removed.metal.name}.</span> <button type="button" className="boe-btn boe-btn-text" onClick={undo}>Undo</button></div>}

      {woods.isSuccess && (
        <div className={t.card}>
          <div className={t.cardH}>Woods</div>
          {woods.data.length === 0 && <div className={t.cardB}><p className={t.muted} style={{ margin: 0 }}>No woods yet. Add the ones you use most, such as mango, sheesham and teak.</p></div>}
          {woods.data.map(w => (
            <div key={w.name} className={t.wood}>
              <b>{w.name}</b>
              {may
                ? <label className={t.field}><span className="boe-input-label">Rate per cu ft (₹)</span><input className="boe-input" inputMode="decimal" value={typed[w.name] ?? (w.rate === null ? '' : String(Number(w.rate)))} placeholder="Not entered yet" onChange={e => setTyped(x => ({ ...x, [w.name]: e.target.value }))} onBlur={() => change(w)} onKeyDown={e => { if (e.key === 'Enter') change(w) }} /></label>
                : <span>{w.rate === null ? 'Not entered yet' : `${inr(Number(w.rate))} per cu ft`}</span>}
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

      {metals.isSuccess && (
        <div className={t.card}>
          <div className={t.cardH}>Metals</div>
          <div className={t.cardB}><p className={t.muted} style={{ margin: 0 }}>Weights follow galaluminium.in and maiak-m.bg: mild steel is 7,850 kg/m³, stainless steel 7,900, aluminium 2,700, brass 8,500. One rate per kind of profile is enough, such as tube and pipe, bar and flat, sheet.</p></div>
          {metals.data.map(m => (
            <div key={m.name} className={t.metal}>
              <b>{m.name}</b>
              {may
                ? <label className={t.field}><span className="boe-input-label">Density (kg/m³)</span><input className="boe-input" inputMode="decimal" value={typed[metalKey(m, 'density')] ?? String(Number(m.density))} onChange={e => setTyped(x => ({ ...x, [metalKey(m, 'density')]: e.target.value }))} onBlur={() => changeMetal(m, 'density')} onKeyDown={e => { if (e.key === 'Enter') changeMetal(m, 'density') }} /></label>
                : <span>{Number(m.density).toLocaleString('en-IN')} kg/m³</span>}
              {may
                ? <label className={t.field}><span className="boe-input-label">Rate per kg (₹)</span><input className="boe-input" inputMode="decimal" value={typed[metalKey(m, 'rate')] ?? (m.rate === null ? '' : String(Number(m.rate)))} placeholder="Not entered yet" onChange={e => setTyped(x => ({ ...x, [metalKey(m, 'rate')]: e.target.value }))} onBlur={() => changeMetal(m, 'rate')} onKeyDown={e => { if (e.key === 'Enter') changeMetal(m, 'rate') }} /></label>
                : <span>{m.rate === null ? 'Not entered yet' : `${inr(Number(m.rate))} per kg`}</span>}
              <span className={t.muted}>{m.rate === null ? 'No rate yet' : `Changed ${shortDate(m.updated_at)}${m.updated_by_name ? ` by ${m.updated_by_name}` : ''}`}</span>
              {may && <button type="button" className={t.iconBtn} disabled={busy} onClick={() => dropMetal(m)} aria-label={`Remove ${m.name}`}><Trash2 size={16} aria-hidden /></button>}
            </div>
          ))}
          {may && (
            <div className={t.metal}>
              <label className={t.field}><span className="boe-input-label">Add a metal</span><input className="boe-input" value={metal.name} onChange={e => setMetal(x => ({ ...x, name: e.target.value }))} placeholder="e.g. SS 304 tube" maxLength={60} /></label>
              <label className={t.field}><span className="boe-input-label">Density (kg/m³)</span><input className="boe-input" inputMode="decimal" value={metal.density} onChange={e => setMetal(x => ({ ...x, density: e.target.value }))} /></label>
              <label className={t.field}><span className="boe-input-label">Rate per kg (₹)</span><input className="boe-input" inputMode="decimal" value={metal.rate} onChange={e => setMetal(x => ({ ...x, rate: e.target.value }))} placeholder="Can be added later" onKeyDown={e => { if (e.key === 'Enter') addMetal() }} /></label>
              <span />
              <button type="button" className="boe-btn boe-btn-primary" disabled={busy} onClick={addMetal}><Plus size={16} aria-hidden /> Add</button>
            </div>
          )}
        </div>
      )}

      {history.isSuccess && history.data.length > 0 && (
        <div className={t.card}>
          <div className={t.cardH}>Every rate change</div>
          <div className={t.cardB}>
            <div>{history.data.slice(0, 40).map((h, i) => (
              <div key={i} className={t.msg}><span><b>{h.name}</b> {inr(Number(h.rate))} per {h.kind === 'wood' ? 'cu ft' : 'kg'} <span className={t.muted}>from {shortDate(h.set_at)}{h.set_by_name ? `, set by ${h.set_by_name}` : ''}</span></span></div>
            ))}</div>
          </div>
        </div>
      )}
      {access.data && !may && <div className="boe-callout boe-callout-info">You can read the rates. To change them, ask an admin for Create on Pricing.</div>}
    </div>
  )
}
