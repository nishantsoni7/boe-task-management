'use client'

import { useEffect, useRef, useState } from 'react'
import { ImagePlus } from 'lucide-react'
import { formatINR } from '@/lib/currency'
import {
  CHOICE_MAX, PACKING_TYPE_MAX, cleanCosting, costWaitingText, costingSums, lineCost,
  type LineChoice, type LineCosting, type QuoteArea, type QuoteLine,
} from '@/lib/quotations/math'
import { Pic } from './Pic'
import s from './quotations.module.css'

/**
 * The Fabric, finish and packing page of the builder (owner, 21 Nov 2026), laid out as a sheet like the Excel file: one row per product with its
 * picture. Fabric and packing are priced PER PIECE and multiplied by the product's quantity; finish has no price, only a code and a picture.
 * Everything here is the same data the client choices already hold (fabric source, name and code; finish code and picture) plus the line's
 * `costing` numbers, so the product row's Client choices panel and this page always agree. The two sums go into the totals on save.
 */
type Group = { area: QuoteArea | null; lines: QuoteLine[] }
const SOURCES: ReadonlyArray<[LineChoice['source'], string]> = [['catalog', 'From our catalog'], ['client', 'Client’s own'], ['code', 'Client’s code, we source it']]
const rupees = (n: number) => '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 })

/** A choice with nothing left in it goes away, so an emptied box leaves no "to confirm" behind. */
function tidy(c: LineChoice): LineChoice | undefined {
  const has = (v?: string) => !!(v ?? '').trim()
  return has(c.name) || has(c.code) || has(c.supplier) || has(c.used_for) || has(c.note) || c.photo ? c : undefined
}

export function CostingPage({ groups, areas, lines, editable, qtyOf, url, onChange, onUploadSwatch }: {
  groups: Group[]; areas: QuoteArea[]; lines: QuoteLine[]; editable: boolean
  qtyOf: (key: string) => number; url: (path: string) => string
  onChange: (key: string, patch: Partial<QuoteLine>) => void
  onUploadSwatch: (f: File) => Promise<string>
}) {
  const [msg, setMsg] = useState('')
  const fileFor = useRef<QuoteLine | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // The newest copy of each line, for what finishes later (a picture upload): the row it started from may have been edited meanwhile.
  const latest = useRef(lines)
  useEffect(() => { latest.current = lines })
  const fresh = (l: QuoteLine): QuoteLine => latest.current.find(x => x.key === l.key) ?? l
  const sums = costingSums(areas, lines)
  const rows = groups.flatMap(g => g.lines)
  const first = rows[0]

  const setChoice = (l: QuoteLine, kind: 'fabric' | 'finish', patch: Partial<LineChoice>) => {
    const now = fresh(l)
    const cur: LineChoice = now.choices?.[kind] ?? { source: 'catalog', status: 'to_confirm' }
    const next = tidy({ ...cur, ...patch })
    const choices = { ...now.choices }
    if (next) choices[kind] = next; else delete choices[kind]
    onChange(l.key, { choices })
  }
  const setCosting = (l: QuoteLine, part: 'fabric' | 'packing', patch: Record<string, number | string | undefined>) => {
    const cur = fresh(l).costing ?? {}
    onChange(l.key, { costing: cleanCosting({ ...cur, [part]: { ...(cur[part] ?? {}), ...patch } } as LineCosting) })
  }
  const num = (t: string) => (t === '' ? undefined : Math.max(0, Number(t)))

  const pickPicture = async (f: File | undefined) => {
    const l = fileFor.current
    if (!f || !l) return
    setMsg('Uploading the picture…')
    try { setChoice(l, 'finish', { photo: await onUploadSwatch(f) }); setMsg('Picture added. Save to keep it.') }
    catch (e) { setMsg(e instanceof Error ? e.message : 'The picture could not be uploaded') }
  }

  // Excel's "fill down": the first row's pick goes to every other row. Metres per piece are not copied (they belong to each product); a copied choice starts as to confirm.
  const fillDown = (what: 'fabric' | 'finish' | 'packing') => {
    if (!first) return
    let n = 0
    for (const l of rows.slice(1)) {
      if (what === 'packing') { onChange(l.key, { costing: cleanCosting({ ...l.costing, packing: first.costing?.packing }) }) }
      else {
        const src = first.choices?.[what]
        const choices = { ...l.choices }
        if (src) choices[what] = { ...src, status: 'to_confirm', confirmed_on: undefined }; else delete choices[what]
        onChange(l.key, what === 'fabric'
          ? { choices, costing: cleanCosting({ ...l.costing, fabric: { ...(first.costing?.fabric?.rate !== undefined ? { rate: first.costing.fabric.rate } : {}), ...(l.costing?.fabric?.metres !== undefined ? { metres: l.costing.fabric.metres } : {}) } }) }
          : { choices })
      }
      n++
    }
    setMsg(n ? `${what === 'fabric' ? 'Fabric' : what === 'finish' ? 'Finish' : 'Packing'} copied from ${first.name.trim() || 'the first product'} to ${n} other ${n === 1 ? 'product' : 'products'}.${what === 'fabric' ? ' Metres per piece were not copied.' : ''}` : '')
  }

  const fillHead = (what: 'fabric' | 'finish' | 'packing', label: string) => (
    <th key={what} scope="col" className={s.cpPick}>{label}{editable && rows.length > 1 && <button type="button" className={s.cpFill} onClick={() => fillDown(what)} title={`Copy the first product's ${label.toLowerCase()} to every other product`}>Fill down</button>}</th>
  )

  return (
    <div className={s.cpWrap}>
      <p className={s.cpHelp}>One row per product. Fabric and packing are priced <b>per piece</b> and multiplied by the product&apos;s quantity; the totals below pick them up. Finish has only a code and a picture. The sheet scrolls sideways on a small screen, and the product stays in view.</p>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={e => { void pickPicture(e.target.files?.[0]); e.target.value = '' }} />
      <div className={s.cpScroll}>
        <table className={s.cpTable}>
          <thead>
            <tr>
              <th scope="col" rowSpan={2} className={`${s.cpStick} ${s.cpHead}`}>Product</th>
              <th scope="col" rowSpan={2} className={s.cpQtyH}>Qty</th>
              <th scope="colgroup" colSpan={6} className={s.cpGrp}>Fabric</th>
              <th scope="colgroup" colSpan={2} className={s.cpGrp}>Finish</th>
              <th scope="colgroup" colSpan={2} className={s.cpGrp}>Packing</th>
              <th scope="colgroup" colSpan={2} className={s.cpGrp}>Per piece × quantity</th>
            </tr>
            <tr>
              {fillHead('fabric', 'From')}
              <th scope="col">Name</th><th scope="col">Code</th><th scope="col">Metres / pc</th><th scope="col">₹ / metre</th><th scope="col" className={s.cpCalcH}>Fabric ₹ / pc</th>
              {fillHead('finish', 'Code')}<th scope="col">Picture</th>
              {fillHead('packing', 'Type')}<th scope="col">Packing ₹ / pc</th>
              <th scope="col" className={s.cpCalcH}>Extras ₹ / pc</th><th scope="col" className={s.cpCalcH}>Total × qty</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g, gi) => g.lines.length > 0 && [
              g.area && <tr key={`a${gi}`} className={s.cpArea}><th scope="rowgroup" colSpan={13}>{g.area.name}{g.area.multiplier > 1 ? ` × ${g.area.multiplier} ${g.area.unit_label}` : ''}</th></tr>,
              ...g.lines.map(l => {
                const qty = qtyOf(l.key), c = lineCost(l, qty), label = l.name.trim() || 'this product'
                const fab = l.choices?.fabric, fin = l.choices?.finish, cf = l.costing?.fabric, cp = l.costing?.packing
                const fabricPart = c.fabric.state === 'none' ? '—' : c.fabric.state === 'wait' ? 'Price to come' : c.fabric.state === 'metres' ? 'Add metres' : rupees(c.fabric.per)
                const waiting = c.fabric.state === 'wait' || c.fabric.state === 'metres' || c.packing.state === 'wait'
                const used = c.fabric.state !== 'none' || c.packing.state !== 'none'
                return (
                  <tr key={l.key} id={`cost-${l.key}`}>
                    <th scope="row" className={`${s.cpStick} ${s.cpProd}`}>
                      <span className={s.cpProdBox}>
                        <span className={s.cpThumb}>{l.image_path ? <Pic className={s.cpThumbImg} src={url(l.image_path)} alt="" lazy /> : null}</span>
                        <span><b>{l.name.trim() || 'Untitled product'}</b><small>{qty.toLocaleString('en-IN')} {qty === 1 ? 'piece' : 'pieces'}{l.is_optional ? ' · optional, not counted' : ''}</small></span>
                      </span>
                    </th>
                    <td className={s.cpQty}>{qty.toLocaleString('en-IN')}</td>
                    <td><select aria-label={`Where the fabric of ${label} comes from`} className={s.cpIn} value={fab?.source ?? 'catalog'} disabled={!editable || !fab} onChange={e => setChoice(l, 'fabric', { source: e.target.value as LineChoice['source'] })}>
                      {SOURCES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                    </select></td>
                    <td><input aria-label={`Fabric name for ${label}`} className={s.cpIn} maxLength={CHOICE_MAX.name} placeholder={fab?.source === 'client' ? 'Their fabric' : 'e.g. Berlin velvet'} value={fab?.name ?? ''} disabled={!editable} onChange={e => setChoice(l, 'fabric', { name: e.target.value })} /></td>
                    <td><input aria-label={`Fabric code for ${label}`} className={s.cpIn} maxLength={CHOICE_MAX.code} placeholder={fab?.source === 'code' ? 'Their code' : 'F18'} value={fab?.code ?? ''} disabled={!editable} onChange={e => setChoice(l, 'fabric', { code: e.target.value })} /></td>
                    <td className={`${s.cpNum} ${c.fabric.state === 'metres' ? s.cpBad : ''}`}><input aria-label={`Metres of fabric per piece for ${label}`} className={`${s.cpIn} ${s.cpMoney}`} type="number" min={0} step={0.1} inputMode="decimal" placeholder="0" value={cf?.metres ?? ''} disabled={!editable} onChange={e => setCosting(l, 'fabric', { metres: num(e.target.value) })} /></td>
                    <td className={s.cpNum}><input aria-label={`Fabric price per metre for ${label}`} className={`${s.cpIn} ${s.cpMoney}`} type="number" min={0} inputMode="numeric" placeholder={fab?.source === 'client' ? 'No charge' : 'To come'} value={cf?.rate ?? ''} disabled={!editable} onChange={e => setCosting(l, 'fabric', { rate: num(e.target.value) })} /></td>
                    <td className={`${s.cpCalc} ${c.fabric.state === 'wait' || c.fabric.state === 'metres' ? s.cpWait : ''}`}>{c.fabric.state === 'ok' && !c.fabric.priced ? 'No charge' : fabricPart}</td>
                    <td><input aria-label={`Finish code for ${label}`} className={s.cpIn} maxLength={CHOICE_MAX.code} placeholder="e.g. W-04" value={fin?.code ?? ''} disabled={!editable} onChange={e => setChoice(l, 'finish', { code: e.target.value })} /></td>
                    <td className={s.cpPic}>
                      {fin?.photo ? <button type="button" className={s.cpPicBtn} disabled={!editable} onClick={() => { fileFor.current = l; fileRef.current?.click() }} aria-label={`Replace the finish picture of ${label}`} title="Replace the picture"><Pic className={s.cpThumbImg} src={url(fin.photo)} alt="" lazy /></button>
                        : <button type="button" className={s.cpAdd} disabled={!editable} onClick={() => { fileFor.current = l; fileRef.current?.click() }} aria-label={`Add a finish picture for ${label}`}><ImagePlus size={15} aria-hidden /> Add</button>}
                      {fin?.photo && editable && <button type="button" className={s.cpDrop} onClick={() => setChoice(l, 'finish', { photo: null })} aria-label={`Remove the finish picture of ${label}`}>Remove</button>}
                    </td>
                    <td><input aria-label={`Packing type for ${label}`} className={s.cpIn} maxLength={PACKING_TYPE_MAX} placeholder="e.g. Carton with foam" value={cp?.type ?? ''} disabled={!editable} onChange={e => setCosting(l, 'packing', { type: e.target.value })} /></td>
                    <td className={`${s.cpNum} ${c.packing.state === 'wait' ? s.cpBad : ''}`}><input aria-label={`Packing price per piece for ${label}`} className={`${s.cpIn} ${s.cpMoney}`} type="number" min={0} inputMode="numeric" placeholder="To come" value={cp?.per_piece ?? ''} disabled={!editable} onChange={e => setCosting(l, 'packing', { per_piece: num(e.target.value) })} /></td>
                    <td className={s.cpCalc}>{used ? (c.per ? rupees(c.per) : waiting ? '—' : '₹0') : '—'}</td>
                    <td className={`${s.cpCalc} ${s.cpStrong} ${waiting ? s.cpWait : ''}`}>{used ? `${formatINR(c.total)}${waiting ? ' +' : ''}` : '—'}</td>
                  </tr>
                )
              }),
            ])}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className={s.cpStick} colSpan={2}>All pieces</th>
              <td colSpan={4} />
              <td className={s.cpFoot}><b>{formatINR(sums.fabric)}</b><small>fabric × qty</small></td>
              <td colSpan={2} />
              <td />
              <td className={s.cpFoot}><b>{formatINR(sums.packing)}</b><small>packing × qty</small></td>
              <td /><td className={s.cpFoot}><b>{formatINR(sums.fabric + sums.packing)}</b><small>all extras</small></td>
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
