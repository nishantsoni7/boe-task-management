'use client'

// Price learning, step 2: each PI as it was read, next to its totals. A person fixes what looks wrong, unticks lines that should
// not be learned (a sample piece, a one-off), and chooses which PIs to learn. Nothing is saved here.

import { useState } from 'react'
import { Check, Pencil } from 'lucide-react'
import { formatINR } from '@/lib/currency'
import { blockers, countsOf, factsOf, kept, learned, type ReviewPi } from '@/lib/pricing/learning/batch'
import type { LineFlag, PiLine } from '@/lib/pricing/learning/readPi'
import { subtotalMatches } from '@/lib/pricing/learning/readPi'
import { CLIENT_TYPES } from '@/lib/quotations/api'
import { dateIN, inNum } from './common'
import s from '@/components/quotations/quotations.module.css'
import l from './learning.module.css'

const FLAG_TEXT: Record<LineFlag, string> = {
  price_derived: 'Price worked out from the total ÷ quantity',
  qty_derived: 'Quantity worked out from the total ÷ price',
  total_differs: 'The file\'s total differs from quantity × price',
  size_unreadable: 'Size not understood: priced at a typical size',
  qty_fraction: 'Quantity is not a whole number',
  price_unusual: 'The price looks unusual',
  name_short: 'The name is very short',
}
const WORRY: LineFlag[] = ['total_differs', 'qty_fraction', 'price_unusual', 'name_short']

export type LineEdit = Partial<Pick<PiLine, 'name' | 'size' | 'material' | 'qty' | 'price'>>

const dotOf = (p: ReviewPi) => (!learned(p) ? l.dotIdle : p.file.verdict.status === 'check' ? l.dotWarn : l.dotOk)

export function StepCheck({ pis, selected, busy, error, onSelect, onPi, onEditLine, onKeep, onBack, onNext }: {
  pis: ReviewPi[]; selected: string | null; busy: boolean; error: string | null
  onSelect: (id: string) => void
  onPi: (id: string, patch: Partial<Pick<ReviewPi, 'learn' | 'date' | 'dateSource' | 'clientType'>>) => void
  onEditLine: (id: string, idx: number, edit: LineEdit) => void
  onKeep: (id: string, idx: number, keep: boolean) => void
  onBack: () => void; onNext: () => void
}) {
  const [filter, setFilter] = useState<'all' | 'check' | 'out'>('all')
  const [editing, setEditing] = useState<Set<string>>(new Set())
  const counts = countsOf(pis)
  const stop = blockers(pis)
  const list = pis.filter(p => (filter === 'all' ? true : filter === 'check' ? learned(p) && p.file.verdict.status === 'check' : !learned(p)))
  const pi = pis.find(p => p.id === selected) ?? pis[0]
  const facts = pi ? factsOf(pi) : null
  const sub = pi ? subtotalMatches(pi.file.reading) : null
  const fixed = pi?.seen !== null || pi?.file.reading.currency === 'USD' || pi?.file.reading.lines.length === 0
  const toggleEdit = (k: string) => setEditing(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })

  return (
    <>
      <div className={l.review}>
        <section className={s.card} style={{ alignSelf: 'start' }}>
          <div className={s.cardHead}><h2>{pis.length} PIs</h2><span className={s.spacer} />
            {(['all', 'check', 'out'] as const).map(f => <button key={f} type="button" className={s.fchip} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === 'all' ? 'All' : f === 'check' ? `To check ${counts.check}` : `Left out ${counts.leftOut}`}</button>)}
          </div>
          <div className={l.piList}>
            {list.length === 0 && <div className={s.empty}>None here.</div>}
            {list.map(p => {
              const f = factsOf(p)
              return (
                <button key={p.id} type="button" className={`${l.pi} ${pi?.id === p.id ? l.piOn : ''}`} onClick={() => onSelect(p.id)} aria-current={pi?.id === p.id}>
                  <span className={`${l.dot} ${dotOf(p)}`} aria-hidden />
                  <span style={{ minWidth: 0 }}><span style={{ display: 'block', fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.file.label.replace(/\.(xlsx|xls)$/i, '')}</span>
                    <span style={{ fontSize: 12, color: '#686D6C' }}>{p.date ? dateIN(p.date) : 'no date'} · {p.lines.length} lines{!learned(p) ? ' · left out' : ''}</span></span>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{f.valueBeforeGst > 0 ? formatINR(f.valueBeforeGst) : ''}</span>
                </button>
              )
            })}
          </div>
        </section>

        {pi && facts && (
          <div style={{ minWidth: 0, display: 'grid', gap: 16 }}>
            <section className={s.card}>
              <div className={s.cardHead}><h2 style={{ overflowWrap: 'anywhere' }}>{pi.file.label}</h2><span className={s.spacer} />
                {!learned(pi) ? <span className={`${s.pill} ${s.st_draft}`}>Left out</span> : pi.file.verdict.status === 'check' ? <span className={`${s.pill} ${s.st_negotiating}`}>To check</span> : <span className={`${s.pill} ${s.st_confirmed}`}>Will be learned</span>}
              </div>
              <div className={l.facts5}>
                <div><div className={l.factLbl}>PI date</div>
                  <input type="date" className={s.input} aria-label="PI date" value={pi.date} max={new Date().toISOString().slice(0, 10)} onChange={e => onPi(pi.id, { date: e.target.value, dateSource: 'typed' })} />
                  <div className={l.factSub}>{pi.dateSource === 'file' ? 'from the file' : pi.dateSource === 'saved' ? 'not in the file: the date it was saved. Change it if wrong.' : 'typed by you'}</div></div>
                <div><div className={l.factLbl}>Client type</div>
                  <select className={s.input} aria-label="Client type" value={pi.clientType ?? ''} onChange={e => onPi(pi.id, { clientType: e.target.value || null })}>
                    <option value="">Not specified</option>{CLIENT_TYPES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></div>
                <div><div className={l.factLbl}>Pieces</div><div className={l.factVal}>{inNum(facts.pieces)}</div><div className={l.factSub}>ticked lines</div></div>
                <div><div className={l.factLbl}>Designs</div><div className={l.factVal}>{facts.designs}</div><div className={l.factSub}>different products</div></div>
                <div><div className={l.factLbl}>Value before GST</div><div className={l.factVal}>{formatINR(facts.valueBeforeGst)}</div>
                  <div className={l.factSub} style={sub === false ? { color: '#805B0D' } : sub ? { color: '#276247' } : undefined}>
                    {sub === true && <><Check size={12} aria-hidden /> adds up to the file&apos;s Sub Total</>}
                    {sub === false && <>the file&apos;s Sub Total is {formatINR(pi.file.reading.footer.subtotal ?? 0)}</>}
                    {sub === null && 'the file has no Sub Total to check against'}
                    {facts.discount ? ` · after a ${formatINR(facts.discount)} discount` : ''}</div></div>
              </div>
              <div className={s.cardBody} style={{ borderTop: '1px solid #ECE7E0', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 600 }}>
                  <input type="checkbox" checked={pi.learn && !fixed} disabled={fixed} onChange={e => onPi(pi.id, { learn: e.target.checked })} /> Learn this PI
                </label>
                {!learned(pi) && pi.leftOutReason && <span className={`${s.small} ${s.muted}`}>{pi.leftOutReason}</span>}
                {pi.learn && pi.file.verdict.status === 'check' && pi.file.verdict.reasons.map(r => <span key={r} className={`${s.small}`} style={{ color: '#805B0D' }}>{r}</span>)}
              </div>
            </section>

            <section className={s.card}>
              <div className={s.cardHead}><h2>Lines</h2><span className={s.chip}>{kept(pi).length} of {pi.lines.length} ticked</span><span className={s.spacer} /><span className={`${s.small} ${s.muted}`}>Tick = learn this line</span></div>
              <div className={s.tableWrap}>
                <table className={s.table}>
                  <thead><tr><th>#</th><th>Product</th><th>Size</th><th>Material</th><th className={s.right}>Qty</th><th className={s.right}>Price per piece</th><th className={s.right}>Line total</th><th className={s.right}>Learn</th><th /></tr></thead>
                  <tbody>{pi.lines.map(({ line, keep }, i) => {
                    const key = `${pi.id}:${i}`, edit = editing.has(key)
                    const worry = line.flags.some(f => WORRY.includes(f))
                    const set = (e: LineEdit) => onEditLine(pi.id, i, e)
                    return (
                      <tr key={key} className={!keep ? l.lineLeft : undefined} style={{ cursor: 'default' }}>
                        <td className={s.muted}>{i + 1}</td>
                        <td>{edit ? <input className={l.cellIn} aria-label={`Name, line ${i + 1}`} value={line.name} onChange={e => set({ name: e.target.value })} /> : <div className={l.cellName}>{line.name}</div>}
                          {line.customization && <div className={l.cellSub}>{line.customization}</div>}
                          {line.sample && <div className={l.cellSub}><span className={`${s.pill} ${s.st_sent}`}>A sample price: left out</span></div>}
                          {line.flags.map(f => <div key={f} className={l.hint} style={WORRY.includes(f) ? undefined : { color: '#686D6C' }}>{FLAG_TEXT[f]}</div>)}</td>
                        <td className={worry ? undefined : l.nw}>{edit ? <input className={l.cellIn} aria-label={`Size, line ${i + 1}`} value={line.size} onChange={e => set({ size: e.target.value })} /> : (line.size || <span className={s.muted}>–</span>)}</td>
                        <td>{edit ? <input className={l.cellIn} aria-label={`Material, line ${i + 1}`} value={line.material} onChange={e => set({ material: e.target.value })} /> : (line.material || <span className={s.muted}>–</span>)}</td>
                        <td className={s.right}>{edit ? <input className={`${l.cellIn} ${l.cellNum}`} type="number" min={0} step="any" aria-label={`Quantity, line ${i + 1}`} value={line.qty} onChange={e => set({ qty: Number(e.target.value) })} /> : line.qty}</td>
                        <td className={`${s.right} ${l.nw}`}>{edit ? <input className={`${l.cellIn} ${l.cellNum}`} type="number" min={0} step="any" aria-label={`Price per piece, line ${i + 1}`} value={line.price} onChange={e => set({ price: Number(e.target.value) })} /> : formatINR(line.price)}</td>
                        <td className={`${s.right} ${l.nw}`}>{formatINR(line.total)}</td>
                        <td className={s.right}><input type="checkbox" checked={keep} onChange={e => onKeep(pi.id, i, e.target.checked)} aria-label={`Learn line ${i + 1}: ${line.name}`} /></td>
                        <td className={s.right}><button type="button" className={s.iconBtn} aria-pressed={edit} aria-label={edit ? `Finish editing line ${i + 1}` : `Edit line ${i + 1}`} onClick={() => toggleEdit(key)}>{edit ? <Check size={15} aria-hidden /> : <Pencil size={14} aria-hidden />}</button></td>
                      </tr>
                    )
                  })}</tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </div>

      <div className={l.foot}>
        <span><b>{counts.learn}</b> to learn · <b>{counts.check}</b> need a look · <b>{counts.leftOut}</b> not learning</span>
        {stop.map(m => <span key={m} className={s.small} style={{ color: '#A12438' }}>{m}</span>)}
        {error && <span className={s.small} style={{ color: '#A12438' }} role="alert">{error}</span>}
        <span className={l.footSpacer} />
        <button type="button" className={s.btn} onClick={onBack}>Back</button>
        <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={busy || stop.length > 0} onClick={onNext}>{busy ? 'Pricing the batch…' : `Test blind, then learn ${counts.learn} PI${counts.learn === 1 ? '' : 's'} →`}</button>
      </div>
    </>
  )
}
