'use client'

// The PI sheet of an old order, as a list (orders 300 and up): product picture, code, name, size,
// material, quantity, rate, total, then the totals. The route reads the stored Excel; nothing is
// saved. PiSheetCard is the drawing alone, so a test can render it without a fetch.

import { useEffect, useState } from 'react'
import { formatINR } from '@/lib/currency'
import { piSheetApplies, type PiSheetView } from '@/lib/orders/clickupPiSheet'
import { whenIst, type DraftOrder } from '@/lib/orders/clickupDrafts'
import { callDrafts } from './callDrafts'
import styles from './clickupDrafts.module.css'

export type PiSheetReply = {
  applies: boolean
  files: { id: string; name: string; uploaded_at: string | null }[]
  current: string | null
  sheet: PiSheetView | null
  reason: string | null
}

const money = (n: number | null) => (n === null ? '—' : formatINR(n))

export function PiSheetCard({ reply, onPick }: { reply: PiSheetReply; onPick?: (fileId: string) => void }) {
  const { sheet, files, current } = reply
  const party = (title: string, p: PiSheetView['billTo']) =>
    p.name || p.phone || p.address ? (
      <div className={styles.fact}>
        <dt>{title}</dt>
        <dd>{[p.name, p.phone, p.address].filter(Boolean).join('\n')}</dd>
      </div>
    ) : null

  return (
    <section className={styles.card} aria-label="PI sheet">
      <h3 className={styles.cardTitle}>PI sheet</h3>
      {files.length > 1 && (
        <label className={styles.meta}>
          Excel{' '}
          <select className={styles.pick} value={current ?? ''} onChange={e => onPick?.(e.target.value)}>
            {files.map(f => <option key={f.id} value={f.id}>{f.name} · {whenIst(f.uploaded_at)}</option>)}
          </select>
        </label>
      )}
      {!sheet && <p className="opp-note">{reply.reason ?? 'This Excel could not be read as a PI.'} The Excel is under Files below.</p>}
      {sheet && (
        <>
          <p className={styles.meta}>
            {[sheet.piNo && `PI ${sheet.piNo}`, sheet.date, sheet.salesperson && `by ${sheet.salesperson}`].filter(Boolean).join(' · ')}
            {files.length === 1 ? ` · read from ${files[0].name}` : ''}
          </p>
          {sheet.problems.length > 0 && (
            <div className="opp-warn" role="alert">
              Check the Excel: it could not be read fully.
              <ul className={styles.checklist}>{sheet.problems.map(p => <li key={p}>{p}</li>)}</ul>
            </div>
          )}
          {(sheet.billTo.name || sheet.billTo.address || sheet.shipTo.name || sheet.shipTo.address) && (
            <dl className={styles.facts}>{party('Bill to', sheet.billTo)}{party('Ship to', sheet.shipTo)}</dl>
          )}
          <div className="opp-scroll">
            <table className="opp-table">
              <thead>
                <tr>
                  <th>Picture</th><th>Code</th><th>Product</th><th className="opp-num">Qty</th><th>Size</th><th>Material</th>
                  <th className="opp-num">Rate</th><th className="opp-num">Total</th>
                  {sheet.lines.some(l => l.customization) && <th>Customization</th>}
                </tr>
              </thead>
              <tbody>
                {sheet.lines.map(l => (
                  <tr key={l.row}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- a small data URL from the route; next/image would only add a loader hop */}
                    <td>{l.picture ? <img className={styles.thumb} src={l.picture} alt={l.name ?? 'Product'} /> : <span className={styles.meta}>—</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{l.code ?? '—'}</td>
                    <td style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{l.name ?? '—'}</td>
                    <td className="opp-num">{l.quantity ?? '—'}</td>
                    <td style={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>{l.size ?? '—'}</td>
                    <td style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{l.material ?? '—'}</td>
                    <td className="opp-num">{money(l.rate)}</td>
                    <td className="opp-num">{money(l.total)}</td>
                    {sheet.lines.some(x => x.customization) && <td style={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>{l.customization ?? ''}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sheet.totals.length > 0 && (
            <dl className={styles.totals}>
              {sheet.totals.map(t => (
                <div key={t.label} className={styles.totalRow}><dt>{t.label}</dt><dd>{t.value}</dd></div>
              ))}
            </dl>
          )}
          {sheet.missingPictures > 0 && (
            <p className="opp-note">{sheet.missingPictures} of {sheet.lines.length} lines have no picture in the sheet.</p>
          )}
        </>
      )}
    </section>
  )
}

export function PiSheetSection({ order }: { order: DraftOrder }) {
  const [reply, setReply] = useState<PiSheetReply | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const applies = piSheetApplies(order.order_no)

  useEffect(() => {
    if (!applies) return
    let live = true
    void callDrafts<PiSheetReply>(`/api/orders/clickup-drafts/${order.id}/pi-sheet${file ? `?file=${encodeURIComponent(file)}` : ''}`).then(r => {
      if (!live) return
      if (r.ok) { setReply(r.body); setProblem(null) } else setProblem(r.message)
    })
    return () => { live = false }
  }, [applies, order.id, file])

  if (!applies) return null
  if (problem) return <section className={styles.card} aria-label="PI sheet"><h3 className={styles.cardTitle}>PI sheet</h3><p className="opp-warn" role="alert">{problem}</p></section>
  if (!reply) return <section className={styles.card} aria-label="PI sheet"><h3 className={styles.cardTitle}>PI sheet</h3><p className="opp-note" role="status">Reading the PI Excel…</p></section>
  if (!reply.applies) return null
  return <PiSheetCard reply={reply} onPick={setFile} />
}
