'use client'

// The PI sheet of an old order, as a list (orders 300 and up): the product (picture, name, code), quantity,
// size, material, rate, total, then the totals. A quotation's Excel (the nine orders that were never a PI) uses
// the same card with a Description column and "Unit price". Redesigned 2026-11-17: ONE fixed-layout table whose
// columns each have a width (the product cell is the card's title on a phone, where the table becomes cards),
// 72px pictures, numbers on the right. The route reads the stored Excel; nothing is saved. PiSheetCard is the
// drawing alone, so a test can render it without a fetch.

import { useEffect, useState } from 'react'
import { formatINR } from '@/lib/currency'
import { PhoneTableCards } from '@/components/ui/PhoneTableCards'
import { piSheetApplies, type PiSheetLine, type PiSheetView } from '@/lib/orders/clickupPiSheet'
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

type Column = { key: 'product' | 'qty' | 'size' | 'material' | 'notes' | 'rate' | 'total'; label: string; width: number; num?: boolean }

/** Percent of the table, 100 in all; a column with nothing in it (Notes, Customization) is left out and its share goes to the text columns. */
function columnsFor(isQuotation: boolean, withNotes: boolean): Column[] {
  if (isQuotation) {
    return [
      { key: 'product', label: 'Product', width: withNotes ? 30 : 34 },
      { key: 'qty', label: 'Qty', width: withNotes ? 6 : 7, num: true },
      { key: 'size', label: 'Description', width: withNotes ? 30 : 37 },
      ...(withNotes ? [{ key: 'notes' as const, label: 'Notes', width: 12 }] : []),
      { key: 'rate', label: 'Unit price', width: 10, num: true },
      { key: 'total', label: 'Total', width: 12, num: true },
    ]
  }
  return [
    { key: 'product', label: 'Product', width: withNotes ? 27 : 32 },
    { key: 'qty', label: 'Qty', width: withNotes ? 6 : 7, num: true },
    { key: 'size', label: 'Size', width: withNotes ? 17 : 22 },
    { key: 'material', label: 'Material', width: withNotes ? 14 : 17 },
    ...(withNotes ? [{ key: 'notes' as const, label: 'Customization', width: 14 }] : []),
    { key: 'rate', label: 'Rate', width: 10, num: true },
    { key: 'total', label: 'Total', width: 12, num: true },
  ]
}

function Cell({ col, line }: { col: Column['key']; line: PiSheetLine }) {
  switch (col) {
    case 'product':
      return (
        <div className={styles.prodCell}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a small data URL from the route; next/image would only add a loader hop */}
          {line.picture ? <img className={styles.thumb} src={line.picture} alt={line.name ?? 'Product'} /> : <span className={styles.noPic} aria-hidden="true">No picture</span>}
          <span className={styles.prodText}>
            <span className={styles.prodName}>{line.name ?? '—'}</span>
            {line.code && <span className={styles.prodCode}>{line.code}</span>}
          </span>
        </div>
      )
    case 'qty': return <>{line.quantity ?? '—'}</>
    case 'size': return <>{line.size ?? '—'}</>
    case 'material': return <>{line.material ?? '—'}</>
    case 'notes': return <>{line.customization ?? '—'}</>
    case 'rate': return <>{money(line.rate)}</>
    case 'total': return <>{money(line.total)}</>
  }
}

export function PiSheetCard({ reply, onPick }: { reply: PiSheetReply; onPick?: (fileId: string) => void }) {
  const { sheet, files, current } = reply
  const isQuotation = sheet?.kind === 'quotation'
  const heading = isQuotation ? 'Quotation' : 'PI sheet'
  const party = (title: string, p: PiSheetView['billTo']) =>
    p.name || p.phone || p.address ? (
      <div className={styles.partyBlock}>
        <dt>{title}</dt>
        <dd>{[p.name, p.phone, p.address].filter(Boolean).join('\n')}</dd>
      </div>
    ) : null
  const columns = sheet ? columnsFor(isQuotation, sheet.lines.some(l => l.customization)) : []

  return (
    <section className={styles.card} aria-label={heading}>
      <h3 className={styles.cardTitle}>{heading}</h3>
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
            {[sheet.title, sheet.piNo && `${isQuotation ? 'Ref' : 'PI'} ${sheet.piNo}`, sheet.date, sheet.salesperson && `by ${sheet.salesperson}`].filter(Boolean).join(' · ')}
            {files.length === 1 ? ` · read from ${files[0].name}` : ''}
          </p>
          {isQuotation && (
            <p className="opp-note">This is the quotation sheet, not a PI. The totals are as printed on the sheet.</p>
          )}
          {sheet.problems.length > 0 && (
            <div className="opp-warn" role="alert">
              Check the Excel: it could not be read fully.
              <ul className={styles.checklist}>{sheet.problems.map(p => <li key={p}>{p}</li>)}</ul>
            </div>
          )}
          {(sheet.billTo.name || sheet.billTo.address || sheet.shipTo.name || sheet.shipTo.address) && (
            <dl className={styles.parties}>{party(isQuotation ? 'Client' : 'Bill to', sheet.billTo)}{party('Ship to', sheet.shipTo)}</dl>
          )}
          <div className="fin-table-wrap">
            <PhoneTableCards>
              <table className={`fin-table ${styles.sheetTable}`}>
                <colgroup>{columns.map(c => <col key={c.key} style={{ width: `${c.width}%` }} />)}</colgroup>
                <thead>
                  <tr>{columns.map(c => <th key={c.key} className={c.num ? 'fin-num' : undefined}>{c.label}</th>)}</tr>
                </thead>
                <tbody>
                  {sheet.lines.map(l => (
                    <tr key={l.row}>
                      {columns.map(c => (
                        <td key={c.key} className={[c.num ? 'fin-num' : '', c.num ? '' : styles.wrap].filter(Boolean).join(' ') || undefined}>
                          <Cell col={c.key} line={l} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </PhoneTableCards>
          </div>
          {sheet.totals.length > 0 && (
            <dl className={styles.totals}>
              {sheet.totals.map(t => (
                <div key={t.label} className={styles.totalRow}><dt>{t.label}</dt><dd>{t.value}</dd></div>
              ))}
            </dl>
          )}
          {sheet.footnotes.map(n => <p key={n} className={styles.meta}>{n}</p>)}
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
  if (!reply) return <section className={styles.card} aria-label="PI sheet"><h3 className={styles.cardTitle}>PI sheet</h3><p className="opp-note" role="status">Reading the Excel…</p></section>
  if (!reply.applies) return null
  return <PiSheetCard reply={reply} onPick={setFile} />
}
