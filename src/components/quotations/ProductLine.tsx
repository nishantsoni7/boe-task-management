'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Copy, ImagePlus, Maximize2, Trash2 } from 'lucide-react'
import { formatINR } from '@/lib/currency'
import type { PriceHint } from '@/lib/quotations/api'
import { sizeInInches, sizeToInches, type DimensionUnit, type LineRef, type QuoteArea, type QuoteLine } from '@/lib/quotations/math'
import type { ModelSuggestion } from '@/lib/pricing/model'
import { PriceHintLine } from './PricingDesk'
import { TaughtPrice, type DiffersReport } from '@/components/pricing/training/TaughtPrice'
import type { Library } from '@/lib/pricing/training/match'
import type { ReworkAnswer } from '@/lib/pricing/training/api'
import { withUsedTag } from '@/lib/pricing/echo'
import { Pic } from './Pic'
import { ChoicesPanel } from './ChoicesPanel'
import { forgetPicture, pointAtPicture, type PictureTarget } from './pictureClipboard'
import s from './quotations.module.css'

/**
 * One product on the builder (layout B, owner-approved 13 Nov 2026): its picture (click to see it large), the boxes, and the
 * numbers. The boxes form two columns (owner, 15 Nov 2026): Product above Material (5 of 12), Dimensions above Remarks (7 of 12).
 * The numbers are one card (owner, 15 Nov 2026): Quantity and Price, the suggestion, then a footer with Optional, the tools, the total and the count.
 * GST is not here: a quotation has one GST rate, in the totals (each product still stores it).
 * There is no Finish box (owner, 13 Nov 2026: not needed). `finish` stays in the line's data, stored and re-sent on every save,
 * because the database rewrites the lines and a missing key would wipe it; words typed into Material and Remarks still reach the price model.
 */
export const REF_LABEL: Record<LineRef['kind'], string> = { swatch: 'Swatch', drawing: 'Drawing', reference: 'Reference' }
export function LineRow({ l, area, unit, editable, qty, total, first, last, url, onChange, onUpload, onUploadSwatch, onImprove, onView, hint, model, feedbackCtx, taught, onRemove, onMove, onDuplicate }: {
  l: QuoteLine; area: QuoteArea | null; unit: DimensionUnit; editable: boolean; qty: number; total: number; first: boolean; last: boolean
  url: (p: string) => string; onChange: (p: Partial<QuoteLine>) => void; onUpload: (f: File | undefined) => void; onUploadSwatch?: (f: File) => Promise<string>; onImprove: () => void; onView: () => void
  hint?: PriceHint; model?: ModelSuggestion | null
  /** Submitted training cases to pick from (Pricing > Training), and where their photos are. */
  taught?: { library: Library; photo: (path: string) => string; differs?: (r: DiffersReport, line: { name: string; size: string | null; material: string | null; finish: string | null; qty: number }) => void
    /** Each picked case worked out for its line by the server (phase 2), by line key. */
    reworked?: Map<string, ReworkAnswer> }
  /** Who and what the price feedback is about; given by the builder, which knows the quotation. */
  feedbackCtx?: { clientType: string | null; quotationId: string | null; isDesk: boolean }
  onRemove: () => void; onMove: (d: -1 | 1) => void; onDuplicate: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [noteOpen, setNoteOpen] = useState(!!l.internal_note)
  const inches = unit === 'in' ? sizeInInches(l.size_text) : null
  const perUnit = l.qty_mode === 'per_unit' && !!area
  const label = l.name.trim() || 'this product'
  // Copy and paste the picture with the keyboard (owner, 18 Nov 2026; pictureClipboard.ts): point at it and press Ctrl+C / Ctrl+V.
  const [flash, setFlash] = useState('')
  const live = useRef({ path: l.image_path, editable, onChange, onUpload })
  useEffect(() => { live.current = { path: l.image_path, editable, onChange, onUpload } })
  const target = useMemo<PictureTarget>(() => ({
    get path() { return live.current.path },
    get editable() { return live.current.editable },
    set: path => live.current.onChange({ image_path: path }),
    upload: file => live.current.onUpload(file),
    flash: text => setFlash(text),
  }), [])
  useEffect(() => () => forgetPicture(target), [target])
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(''), 2500); return () => clearTimeout(t) }, [flash])
  return (
    <div className={s.pl} id={`line-${l.key}`}>
      <div className={s.plPic} onMouseEnter={() => pointAtPicture(target)} onMouseLeave={() => pointAtPicture(null)} onFocus={() => pointAtPicture(target)}
        title={editable ? 'Point here and press Ctrl+C to copy this picture, or Ctrl+V to paste one' : l.image_path ? 'Point here and press Ctrl+C to copy this picture' : undefined}>
        {l.image_path
          ? <button type="button" className={s.plPicBtn} onClick={onView} aria-label={`View the picture of ${label}`}><Pic className={s.plPicImg} src={url(l.image_path)} alt="" lazy /><span className={s.plZoom}><Maximize2 size={14} aria-hidden /></span></button>
          : <button type="button" className={s.plPicEmpty} onClick={() => fileRef.current?.click()} disabled={!editable}><ImagePlus size={22} aria-hidden /><span>Add picture</span>{editable && <span className={s.small} style={{ fontWeight: 400 }}>or paste (Ctrl+V)</span>}</button>}
        {flash && <span className={`${s.small} ${s.muted}`} role="status">{flash}</span>}
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
        {!!l.references?.length && (
          // The client's swatch, drawing or other reference, kept from the file (internal: never on the client's copy).
          <div className={s.plRefs} aria-label="Other pictures from the client's file">
            {l.references.map((r, i) => (
              <span key={r.path} className={s.plRef} title={[REF_LABEL[r.kind], r.note].filter(Boolean).join(': ')}>
                <a href={url(r.path)} target="_blank" rel="noreferrer"><Pic className={s.plRefImg} src={url(r.path)} alt={REF_LABEL[r.kind]} lazy /></a>
                <span className={s.plRefKind}>{REF_LABEL[r.kind]}</span>
                {editable && <button type="button" className={s.plRefRm} aria-label={`Remove this ${REF_LABEL[r.kind].toLowerCase()}`} onClick={() => onChange({ references: l.references!.filter((_, j) => j !== i) })}>×</button>}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className={s.plMid}>
        <label className={`${s.field} ${s.c5}`}><span>Product</span><input aria-label="Product name" className={s.input} style={{ fontWeight: 600 }} placeholder="Product name, e.g. Bed" value={l.name} onChange={e => onChange({ name: e.target.value })} disabled={!editable} /></label>
        <label className={`${s.field} ${s.c7}`}><span>Dimensions ({unit})</span>
          <span className={s.unitWrap}><input aria-label="Dimensions" className={s.input} placeholder="e.g. 83 × 68 × 18" value={l.size_text} onChange={e => onChange({ size_text: e.target.value })} onBlur={() => { const inch = unit === 'in' ? sizeToInches(l.size_text) : null; if (inch) onChange({ size_text: inch }) }} disabled={!editable} /><span className={s.unitTag} aria-hidden>{unit}</span></span>
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
        <div className={s.qp}>
          <div className={s.field}><span>Quantity</span>
            <div className={s.qtyBox}>
              <input aria-label={perUnit ? `Quantity per ${area!.unit_label.replace(/s$/, '')}` : 'Quantity'} className={s.qtyIn} type="number" min={0} step="any" value={l.qty ?? ''} onChange={e => onChange({ qty: e.target.value === '' ? null : Number(e.target.value) })} disabled={!editable} />
              {area ? (
                <select aria-label="Quantity is" className={s.qtySel} value={l.qty_mode} onChange={e => onChange({ qty_mode: e.target.value as QuoteLine['qty_mode'] })} disabled={!editable}>
                  <option value="per_unit">per {area.unit_label.replace(/s$/, '')}</option>
                  <option value="fixed">in total</option>
                </select>
              ) : <span className={s.qtyUnit}>pieces</span>}
            </div>
          </div>
          <label className={s.field}><span>Price before GST</span>
            <span className={s.rupeeBox}><span className={s.rs} aria-hidden>₹</span><input aria-label="Unit price (₹, before GST)" className={s.rupeeIn} type="number" min={0} placeholder="Price" value={l.unit_price ?? ''} onChange={e => onChange({ unit_price: e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value))) })} disabled={!editable} /></span>
          </label>
        </div>
        {taught && <TaughtPrice library={taught.library} photo={taught.photo} line={l} note={l.internal_note} price={l.unit_price} editable={editable} rework={taught.reworked?.get(l.key)}
          onNote={n => onChange({ internal_note: n })} onUse={p => onChange({ unit_price: Math.round(p) })}
          onDiffers={taught.differs && (r => taught.differs!(r, { name: l.name, size: l.size_text, material: l.material, finish: [l.finish, l.spec].filter(Boolean).join(' ') || null, qty }))} />}
        {/* The echo guard (20270824000000): a price set by Use is tagged, and learning leaves it out until somebody changes it. */}
        <PriceHintLine hint={hint} model={model} price={l.unit_price} editable={editable} onUse={p => onChange({ unit_price: Math.round(p), internal_note: withUsedTag(l.internal_note, Math.round(p)) })}
          feedback={feedbackCtx && { line: { name: l.name, size: l.size_text, material: l.material, finish: [l.finish, l.spec].filter(Boolean).join(' ') || null, qty }, ...feedbackCtx, imagePath: l.image_path, price: l.unit_price }}
          note={l.internal_note} onAsked={n => onChange({ internal_note: n })} />
        <div className={s.plFoot}>
          <label className={s.optLab}><input type="checkbox" checked={l.is_optional} onChange={e => onChange({ is_optional: e.target.checked })} disabled={!editable} /> Optional</label>
          <div className={s.plTotal}>{l.unit_price === null ? <span className={s.muted}>No price</span> : formatINR(total)}</div>
          {editable ? (
            <div className={s.plTools}>
              <button className={s.iconBtn} onClick={() => onMove(-1)} disabled={first} aria-label="Move up"><ArrowUp size={15} /></button>
              <button className={s.iconBtn} onClick={() => onMove(1)} disabled={last} aria-label="Move down"><ArrowDown size={15} /></button>
              <button className={s.iconBtn} onClick={onDuplicate} aria-label="Duplicate"><Copy size={15} /></button>
              <button className={s.iconBtn} onClick={onRemove} aria-label="Remove product"><Trash2 size={15} /></button>
            </div>
          ) : <span />}
          <div className={`${s.plPieces} ${s.small} ${s.muted}`}>{l.is_optional ? 'not in the total' : `${qty.toLocaleString('en-IN')} ${qty === 1 ? 'piece' : 'pieces'}`}</div>
        </div>
      </div>
      <ChoicesPanel choices={l.choices} editable={editable} url={url} onChange={choices => onChange({ choices })} onUpload={onUploadSwatch ?? (() => Promise.reject(new Error("Pictures cannot be added here")))} />
    </div>
  )
}
