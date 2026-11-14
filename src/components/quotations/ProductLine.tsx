'use client'

import { useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Copy, ImagePlus, Maximize2, Trash2 } from 'lucide-react'
import { formatINR } from '@/lib/currency'
import type { PriceHint } from '@/lib/quotations/api'
import { sizeInInches, type DimensionUnit, type QuoteArea, type QuoteLine } from '@/lib/quotations/math'
import type { ModelSuggestion } from '@/lib/pricing/model'
import { PriceHintLine } from './PricingDesk'
import { Pic } from './Pic'
import s from './quotations.module.css'

/**
 * One product on the builder (layout B, owner-approved 13 Nov 2026): its picture (click to see it large), the boxes, and the
 * numbers. GST is not here: a quotation has one GST rate, in the totals (each product still stores it).
 * There is no Finish box (owner, 13 Nov 2026: not needed). `finish` stays in the line's data, stored and re-sent on every save,
 * because the database rewrites the lines and a missing key would wipe it; words typed into Material and Remarks still reach the price model.
 */
export function LineRow({ l, area, unit, editable, qty, total, first, last, url, onChange, onUpload, onImprove, onView, hint, model, feedbackCtx, onRemove, onMove, onDuplicate }: {
  l: QuoteLine; area: QuoteArea | null; unit: DimensionUnit; editable: boolean; qty: number; total: number; first: boolean; last: boolean
  url: (p: string) => string; onChange: (p: Partial<QuoteLine>) => void; onUpload: (f: File | undefined) => void; onImprove: () => void; onView: () => void
  hint?: PriceHint; model?: ModelSuggestion | null
  /** Who and what the price feedback is about; given by the builder, which knows the quotation. */
  feedbackCtx?: { clientType: string | null; quotationId: string | null; isDesk: boolean }
  onRemove: () => void; onMove: (d: -1 | 1) => void; onDuplicate: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [noteOpen, setNoteOpen] = useState(!!l.internal_note)
  const inches = unit === 'in' ? sizeInInches(l.size_text) : null
  const perUnit = l.qty_mode === 'per_unit' && !!area
  const label = l.name.trim() || 'this product'
  return (
    <div className={s.pl}>
      <div className={s.plPic}>
        {l.image_path
          ? <button type="button" className={s.plPicBtn} onClick={onView} aria-label={`View the picture of ${label}`}><Pic className={s.plPicImg} src={url(l.image_path)} alt="" /><span className={s.plZoom}><Maximize2 size={14} aria-hidden /></span></button>
          : <button type="button" className={s.plPicEmpty} onClick={() => fileRef.current?.click()} disabled={!editable}><ImagePlus size={22} aria-hidden /><span>Add picture</span></button>}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={e => { onUpload(e.target.files?.[0]); e.target.value = '' }} />
        {editable && l.image_path && (
          <div className={s.plLinks}>
            <button type="button" className={s.improve} onClick={onImprove}>Improve picture</button>
            <span className={s.two}>
              <button type="button" className={s.improve} onClick={() => fileRef.current?.click()}>Replace</button>
              <button type="button" className={s.plRm} onClick={() => onChange({ image_path: null })}>Remove</button>
            </span>
          </div>
        )}
      </div>
      <div className={s.plMid}>
        <label className={`${s.field} ${s.c7}`}><span>Product</span><input aria-label="Product name" className={s.input} style={{ fontWeight: 600 }} placeholder="Product name, e.g. Bed" value={l.name} onChange={e => onChange({ name: e.target.value })} disabled={!editable} /></label>
        <label className={`${s.field} ${s.c5}`}><span>Dimensions ({unit})</span>
          <span className={s.unitWrap}><input aria-label="Dimensions" className={s.input} placeholder="e.g. 83 × 68 × 18" value={l.size_text} onChange={e => onChange({ size_text: e.target.value })} disabled={!editable} /><span className={s.unitTag} aria-hidden>{unit}</span></span>
          {inches && <span className={`${s.small} ${s.muted} ${s.num}`}>= {inches.join(' × ')} in</span>}
        </label>
        <label className={`${s.field} ${s.c5}`}><span>Material</span><textarea aria-label="Material" className={`${s.input} ${s.t3}`} rows={3} maxLength={120} placeholder="e.g. Ash wood" value={l.material} onChange={e => onChange({ material: e.target.value })} disabled={!editable} /></label>
        <label className={`${s.field} ${s.c7}`}><span>Remarks / customization</span><textarea aria-label="Remarks / customization" className={`${s.input} ${s.t3}`} rows={3} maxLength={1600} placeholder="What the client reads under the product" value={l.spec} onChange={e => onChange({ spec: e.target.value })} disabled={!editable} /></label>
        <div className={s.c12}>
          {noteOpen || l.internal_note
            ? <label className={s.field}><span>Internal note (never shown to the client)</span><input aria-label="Internal note" className={s.input} maxLength={1000} value={l.internal_note} onChange={e => onChange({ internal_note: e.target.value })} disabled={!editable} /></label>
            : editable && <button type="button" className={s.intNote} onClick={() => setNoteOpen(true)}>+ Internal note <span className={`${s.small} ${s.muted}`} style={{ fontWeight: 400 }}>(never shown to the client)</span></button>}
        </div>
      </div>
      <div className={s.plRight}>
        <div className={s.field}><span>Quantity</span>
          <div className={s.qtyRow}>
            <input aria-label={perUnit ? `Quantity per ${area!.unit_label.replace(/s$/, '')}` : 'Quantity'} className={`${s.input} ${s.money}`} type="number" min={0} step="any" value={l.qty ?? ''} onChange={e => onChange({ qty: e.target.value === '' ? null : Number(e.target.value) })} disabled={!editable} />
            {area ? (
              <select aria-label="Quantity is" className={s.input} value={l.qty_mode} onChange={e => onChange({ qty_mode: e.target.value as QuoteLine['qty_mode'] })} disabled={!editable}>
                <option value="per_unit">per {area.unit_label.replace(/s$/, '')}</option>
                <option value="fixed">in total</option>
              </select>
            ) : <span className={`${s.small} ${s.muted}`} style={{ alignSelf: 'center' }}>pieces</span>}
          </div>
        </div>
        <label className={s.field}><span>Price ₹ before GST</span><input aria-label="Unit price (₹, before GST)" className={`${s.input} ${s.money}`} type="number" min={0} placeholder="Price ₹" value={l.unit_price ?? ''} onChange={e => onChange({ unit_price: e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value))) })} disabled={!editable} /></label>
        <PriceHintLine hint={hint} model={model} price={l.unit_price} editable={editable} onUse={p => onChange({ unit_price: Math.round(p) })}
          feedback={feedbackCtx && { line: { name: l.name, size: l.size_text, material: l.material, finish: [l.finish, l.spec].filter(Boolean).join(' ') || null, qty }, ...feedbackCtx }} />
        <div className={s.row} style={{ justifyContent: 'space-between' }}>
          <label className={s.optLab}><input type="checkbox" checked={l.is_optional} onChange={e => onChange({ is_optional: e.target.checked })} disabled={!editable} /> Optional</label>
          <div className={s.plTotal}>{l.unit_price === null ? <span className={s.muted}>No price</span> : formatINR(total)}<div className={`${s.small} ${s.muted}`} style={{ fontWeight: 400 }}>{l.is_optional ? 'not in the total' : `${qty.toLocaleString('en-IN')} ${qty === 1 ? 'piece' : 'pieces'}`}</div></div>
        </div>
        {editable && (
          <div className={s.plTools}>
            <button className={s.iconBtn} onClick={() => onMove(-1)} disabled={first} aria-label="Move up"><ArrowUp size={15} /></button>
            <button className={s.iconBtn} onClick={() => onMove(1)} disabled={last} aria-label="Move down"><ArrowDown size={15} /></button>
            <button className={s.iconBtn} onClick={onDuplicate} aria-label="Duplicate"><Copy size={15} /></button>
            <button className={s.iconBtn} onClick={onRemove} aria-label="Remove product"><Trash2 size={15} /></button>
          </div>
        )}
      </div>
    </div>
  )
}
