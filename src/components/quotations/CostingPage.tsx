'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine } from 'lucide-react'
import { formatINR } from '@/lib/currency'
import {
  PACKING_TYPE_MAX, cleanCosting, costWaitingText, costingSums, lineCost,
  type LineChoice, type LineCosting, type QuoteArea, type QuoteLine,
} from '@/lib/quotations/math'
import { tintStyle } from './areaTint'
import { Pic } from './Pic'
import s from './quotations.module.css'

/**
 * The Fabric and packing tab of the builder (owner, 21 Nov 2026; simplified 25 Nov 2026, version 2): one row per product WITH its picture, like
 * the Excel file, and only the calculations. Fabric and finish are CHOSEN under each product (its Client choices); here the chosen fabric is
 * shown under the product's name, read only, and priced: metres per piece × rupees per metre = fabric per piece, × quantity; packing per piece,
 * × quantity. Finish has no price, so it is not here. The two sums go into the totals on save.
 */
type Group = { area: QuoteArea | null; lines: QuoteLine[] }
const rupees = (n: number) => '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 })

/** The chosen fabric in a few words: "Berlin velvet F18", "Client's own: linen", "Client's code RW-22, we source it". */
export function fabricLine(f: LineChoice | undefined): string {
  if (!f) return ''
  const name = (f.name ?? '').trim(), code = (f.code ?? '').trim()
  if (f.source === 'code') return `Client’s code${code ? ` ${code}` : ''}, we source it`
  if (f.source === 'client') return `Client’s own${name ? `: ${name}` : ''}`
  return [name, code].filter(Boolean).join(' ') || 'Not named yet'
}

export function CostingPage({ groups, areas, lines, editable, qtyOf, url, onChange }: {
  groups: Group[]; areas: QuoteArea[]; lines: QuoteLine[]; editable: boolean
  qtyOf: (key: string) => number; url: (path: string) => string
  onChange: (key: string, patch: Partial<QuoteLine>) => void
}) {
  const [msg, setMsg] = useState('')
  // The newest copy of each line, for an edit that lands after another one in the same row.
  const latest = useRef(lines)
  useEffect(() => { latest.current = lines })
  const fresh = (l: QuoteLine): QuoteLine => latest.current.find(x => x.key === l.key) ?? l
  const sums = costingSums(areas, lines)
  const rows = groups.flatMap(g => g.lines)
  const first = rows[0]

  const setCosting = (l: QuoteLine, part: 'fabric' | 'packing', patch: Record<string, number | string | undefined>) => {
    const cur = fresh(l).costing ?? {}
    onChange(l.key, { costing: cleanCosting({ ...cur, [part]: { ...(cur[part] ?? {}), ...patch } } as LineCosting) })
  }
  const num = (t: string) => (t === '' ? undefined : Math.max(0, Number(t)))

  // Excel's "fill down" for the packing: the first row's packing type and price go to every other row.
  const fillDown = () => {
    if (!first) return
    let n = 0
    for (const l of rows.slice(1)) { onChange(l.key, { costing: cleanCosting({ ...l.costing, packing: first.costing?.packing }) }); n++ }
    setMsg(n ? `Packing copied from ${first.name.trim() || 'the first product'} to ${n} other ${n === 1 ? 'product' : 'products'}.` : '')
  }

  return (
    <div className={s.cpWrap}>
      <p className={s.cpHelp}>Fabric and finish are chosen under each product (Client choices). Here you price them: the fabric&apos;s metres and rate per metre, and packing, all <b>per piece</b> and multiplied by the product&apos;s quantity. The totals below pick them up.</p>
      <div className={s.cpScroll}>
        <table className={s.cpTable}>
          <colgroup><col className={s.cpColProd} /><col className={s.cpColQty} /><col /><col /><col /><col className={s.cpColTot} /><col className={s.cpColType} /><col /><col className={s.cpColTot} /></colgroup>
          <thead>
            <tr>
              <th scope="col" rowSpan={2} className={`${s.cpStick} ${s.cpHead}`}>Product and its fabric</th>
              <th scope="col" rowSpan={2} className={s.cpQtyH}>Qty</th>
              <th scope="colgroup" colSpan={4} className={s.cpGrp}>Fabric</th>
              <th scope="colgroup" colSpan={3} className={s.cpGrp}>Packing</th>
            </tr>
            <tr>
              <th scope="col" className={s.cpCalcH}>Metres / pc</th><th scope="col" className={s.cpCalcH}>₹ / metre</th><th scope="col" className={s.cpCalcH}>Fabric / pc</th><th scope="col" className={s.cpCalcH}>Fabric × qty</th>
              <th scope="col" className={s.cpPick}>Type{editable && rows.length > 1 && <button type="button" className={s.cpFill} onClick={fillDown} title="Fill down: copy the first product's packing to every other product" aria-label="Fill down the packing"><ArrowDownToLine size={14} aria-hidden /></button>}</th>
              <th scope="col" className={s.cpCalcH}>Packing / pc</th><th scope="col" className={s.cpCalcH}>Packing × qty</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g, gi) => g.lines.length > 0 && [
              g.area && <tr key={`a${gi}`} className={s.cpArea} style={tintStyle(areas.findIndex(a => a.key === g.area!.key))}><th scope="rowgroup" colSpan={9}>{g.area.name}{g.area.multiplier > 1 ? ` × ${g.area.multiplier} ${g.area.unit_label}` : ''}</th></tr>,
              ...g.lines.map(l => {
                const qty = qtyOf(l.key), c = lineCost(l, qty), label = l.name.trim() || 'this product'
                const fab = l.choices?.fabric, cf = l.costing?.fabric, cp = l.costing?.packing
                const fabricPart = c.fabric.state === 'none' ? '—' : c.fabric.state === 'wait' ? 'Price to come' : c.fabric.state === 'metres' ? 'Add metres' : rupees(c.fabric.per)
                const fabOk = c.fabric.state === 'ok', packOk = c.packing.state === 'ok'
                return (
                  <tr key={l.key} id={`cost-${l.key}`}>
                    <th scope="row" className={`${s.cpStick} ${s.cpProd}`}>
                      <span className={s.cpProdBox}>
                        <span className={s.cpThumb}>{l.image_path ? <Pic className={s.cpThumbImg} src={url(l.image_path)} alt="" lazy /> : null}</span>
                        <span><b>{l.name.trim() || 'Untitled product'}</b><small>{qty.toLocaleString('en-IN')} {qty === 1 ? 'piece' : 'pieces'}{l.is_optional ? ' · optional, not counted' : ''}</small>
                          <small className={s.cpFabric}>{fab ? fabricLine(fab) : 'No fabric chosen'}</small></span>
                      </span>
                    </th>
                    <td className={s.cpQty}>{qty.toLocaleString('en-IN')}</td>
                    <td className={`${s.cpNum} ${c.fabric.state === 'metres' ? s.cpBad : ''}`}><input aria-label={`Metres of fabric per piece for ${label}`} className={`${s.cpIn} ${s.cpMoney}`} type="number" min={0} step={0.1} inputMode="decimal" placeholder="0" value={cf?.metres ?? ''} disabled={!editable} onChange={e => setCosting(l, 'fabric', { metres: num(e.target.value) })} /></td>
                    <td className={s.cpNum}><input aria-label={`Fabric price per metre for ${label}`} className={`${s.cpIn} ${s.cpMoney}`} type="number" min={0} inputMode="numeric" placeholder={fab?.source === 'client' ? 'No charge' : 'To come'} value={cf?.rate ?? ''} disabled={!editable} onChange={e => setCosting(l, 'fabric', { rate: num(e.target.value) })} /></td>
                    <td className={`${s.cpCalc} ${c.fabric.state === 'wait' || c.fabric.state === 'metres' ? s.cpWait : ''}`}>{c.fabric.state === 'ok' && !c.fabric.priced ? 'No charge' : fabricPart}</td>
                    <td className={`${s.cpCalc} ${s.cpStrong}`}>{fabOk && c.fabric.priced ? formatINR(c.fabric.total) : '—'}</td>
                    <td><input aria-label={`Packing type for ${label}`} className={s.cpIn} maxLength={PACKING_TYPE_MAX} placeholder="e.g. Carton with foam" value={cp?.type ?? ''} disabled={!editable} onChange={e => setCosting(l, 'packing', { type: e.target.value })} /></td>
                    <td className={`${s.cpNum} ${c.packing.state === 'wait' ? s.cpBad : ''}`}><input aria-label={`Packing price per piece for ${label}`} className={`${s.cpIn} ${s.cpMoney}`} type="number" min={0} inputMode="numeric" placeholder="To come" value={cp?.per_piece ?? ''} disabled={!editable} onChange={e => setCosting(l, 'packing', { per_piece: num(e.target.value) })} /></td>
                    <td className={`${s.cpCalc} ${s.cpStrong}`}>{packOk ? formatINR(c.packing.total) : '—'}</td>
                  </tr>
                )
              }),
            ])}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className={s.cpStick} colSpan={2}>All pieces</th>
              <td colSpan={3} />
              <td className={s.cpFoot}><b>{formatINR(sums.fabric)}</b><small>all fabric</small></td>
              <td colSpan={2} />
              <td className={s.cpFoot}><b>{formatINR(sums.packing)}</b><small>all packing</small></td>
            </tr>
          </tfoot>
        </table>
      </div>
      {msg && <p className={`${s.small} ${s.muted}`} role="status">{msg}</p>}
      <p className={s.cpSum}>
        {sums.any ? <>Added to the totals below: fabric <b>{formatINR(sums.fabric)}</b>, packing <b>{formatINR(sums.packing)}</b> (before GST).</> : <>Nothing is priced yet, so the Fabric and Packing boxes below stay as they were typed.</>}
        {sums.waiting.length > 0 && <span className={s.cpPend}> Not counted yet: {sums.waiting.map(costWaitingText).join(', ')}.</span>}
      </p>
    </div>
  )
}
