'use client'

// Pricing > Training: one element of a case as one line of a sheet (24 Nov 2026 redesign). The line holds what is typed
// most (name, kind, quantity and unit, rate, amount); how it was worked out, the wood, the calculators and the reasoning
// open on the arrow. Overhead and margin are not rows here: they are the two boxes of the price build-up (boxes.ts).
// Nothing here saves anything.

import { ChevronDown, Trash2 } from 'lucide-react'
import { formatINR } from '@/lib/currency'
import { KIND_LABEL, structureRest, usesQuantity, type Kind, type Line } from '@/lib/pricing/training/doc'
import { CALC_LABEL, newCalc, type CalcType, type Size, type Worked } from '@/lib/pricing/training/calc'
import type { Metal, Wood } from '@/lib/pricing/training/api'
import { CalcEditor } from './CalcEditors'
import t from './training.module.css'

/** The ways each kind of element can be worked out besides an amount or quantity × rate. */
const WAYS: Record<Kind, CalcType[]> = { structure: ['wood', 'area'], metal: ['metal'], material: ['area'], labour: ['area', 'percent'], overhead: ['percent'], margin: ['percent'], other: ['area', 'percent'] }
/** Overhead and margin are set in the price build-up; a row of that kind is only listed so it can still be read. */
const PICKABLE: readonly Kind[] = ['structure', 'metal', 'material', 'labour', 'other']

/** A kind keeps its way of working out only when that kind allows it; a metal frame starts weighed. */
export function kindPatch(l: Line, kind: Kind): Partial<Line> {
  return { kind, calc: l.calc && WAYS[kind].includes(l.calc.type) ? l.calc : kind === 'metal' ? newCalc('metal') : null }
}

type Props = {
  i: number; line: Line; worked: Worked | undefined; size: Size; woods: Wood[]; metals: Metal[]
  open: boolean; onToggle: () => void; onChange: (patch: Partial<Line>) => void; onRemove: () => void
}

export function ElementRow({ i, line: l, worked, size, woods, metals, open, onToggle, onChange, onRemove }: Props) {
  const n = i + 1
  const detailsId = `el-more-${i}`
  const kinds = PICKABLE.includes(l.kind) ? PICKABLE : [...PICKABLE, l.kind]
  const computed = !!l.calc || usesQuantity(l)
  const amount = worked?.amount ?? 0
  const rest = structureRest(l)
  const subline = [l.material, l.reasoning].filter(Boolean).join(' · ')
  return (
    <div className={`${t.el} ${l.calc ? t.elCalc : ''}`}>
      <span className={t.n} aria-hidden>{n}</span>
      <div className={t.cName}>
        <span className={t.lbl}>Element {n}</span>
        <input className="boe-input" aria-label={`Element ${n} name`} value={l.element} onChange={e => onChange({ element: e.target.value })} placeholder="e.g. Wooden structure" maxLength={120} />
      </div>
      <div className={t.cKind}>
        <span className={t.lbl}>Kind</span>
        <select className="boe-input" aria-label={`Kind of element ${n}`} value={l.kind} onChange={e => onChange(kindPatch(l, e.target.value as Kind))}>{kinds.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>
      </div>
      {l.calc
        ? <div className={t.cCalc}><span className={t.muted}>Worked out: {CALC_LABEL[l.calc.type].toLowerCase()}</span></div>
        : <>
          <div className={t.cQty}>
            <span className={t.lbl}>Quantity</span>
            <div className={t.grp}>
              <input aria-label={`Element ${n} quantity`} inputMode="decimal" placeholder="Qty" value={l.quantity} onChange={e => onChange({ quantity: e.target.value })} />
              <input aria-label={`Element ${n} unit`} placeholder="Unit" value={l.unit} maxLength={30} onChange={e => onChange({ unit: e.target.value })} />
            </div>
          </div>
          <div className={t.cRate}>
            <span className={t.lbl}>Rate</span>
            <div className={t.fx}><span className={t.pf} aria-hidden>₹</span><input aria-label={`Element ${n} rate`} inputMode="decimal" value={l.rate} onChange={e => onChange({ rate: e.target.value })} /></div>
          </div>
        </>}
      <div className={t.cAmt}>
        <span className={t.lbl}>Amount</span>
        {computed
          ? <div className={t.out} aria-live="polite">{formatINR(amount)}</div>
          : <div className={t.fx}><span className={t.pf} aria-hidden>₹</span><input aria-label={`Element ${n} amount`} inputMode="decimal" value={l.amount} onChange={e => onChange({ amount: e.target.value })} /></div>}
      </div>
      <div className={t.cAct}>
        <button type="button" className={t.iconBtn} aria-expanded={open} aria-controls={detailsId} aria-label={`Details of element ${n}`} onClick={onToggle}><ChevronDown size={16} aria-hidden className={open ? t.flip : undefined} /></button>
        <button type="button" className={`${t.iconBtn} ${t.iconDel}`} onClick={onRemove} aria-label={`Remove element ${n}`}><Trash2 size={16} aria-hidden /></button>
      </div>
      {(subline || l.from_ai) && <div className={t.subline}>{l.from_ai && <span className={t.fromAi}>read by AI</span>}{subline && <span className={t.tx}>{subline}</span>}</div>}
      {open && (
        <div className={t.more} id={detailsId}>
          {l.kind === 'structure'
            ? <label className={t.field}><span className="boe-input-label">Wood</span><input className="boe-input" list="training-woods" value={l.material} onChange={e => onChange({ material: e.target.value })} placeholder="Pick or type a wood" maxLength={40} /></label>
            : <label className={t.field}><span className="boe-input-label">Material / what it is</span><input className="boe-input" value={l.material} onChange={e => onChange({ material: e.target.value })} maxLength={160} /></label>}
          <label className={t.field}><span className="boe-input-label">Worked out as</span>
            <select className="boe-input" value={l.calc?.type ?? ''} onChange={e => onChange({ calc: e.target.value ? newCalc(e.target.value as CalcType) : null })}>
              <option value="">An amount, or quantity × rate</option>
              {WAYS[l.kind].map(w => <option key={w} value={w}>{CALC_LABEL[w]}</option>)}
            </select>
          </label>
          <label className={`${t.field} ${t.wide}`}><span className="boe-input-label">How you worked this out</span><input className="boe-input" value={l.reasoning} onChange={e => onChange({ reasoning: e.target.value })} placeholder="e.g. Four legs, two rails, back posts, with cutting waste" maxLength={1000} /></label>
          {l.calc && <div className={t.wide}><CalcEditor calc={l.calc} onChange={calc => onChange({ calc })} worked={worked ?? { amount: 0, note: '' }} size={size} woodName={l.material} woods={woods} metals={metals} idPrefix={`el${i}`} /></div>}
          {l.kind === 'structure' && !l.calc && <>
            <label className={t.field}><span className="boe-input-label">Of which wood (₹), optional</span><input className="boe-input" inputMode="decimal" value={l.wood} onChange={e => onChange({ wood: e.target.value })} placeholder="The wood alone" /></label>
            <p className={`${t.muted} ${t.hint}`} aria-live="polite">{rest === null ? 'One price for the whole wooden structure is enough. If you also give the wood alone, the rest is counted as labour and hardware, and a price can be worked out for another wood later.' : rest < 0 ? 'The wood share is more than the structure price.' : `Labour and hardware: ${formatINR(rest)}`}</p>
          </>}
        </div>
      )}
    </div>
  )
}
