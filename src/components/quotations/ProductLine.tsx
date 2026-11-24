'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Copy, ImagePlus, Maximize2, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import { formatINR } from '@/lib/currency'
import type { PriceHint } from '@/lib/quotations/api'
import { choiceCounts, sizeInInches, sizeToInches, type DimensionUnit, type LineRef, type QuoteArea, type QuoteLine } from '@/lib/quotations/math'
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
 * One product on the builder (owner-approved mockup, 25 Nov 2026; the arrangement is layout B of 13 Nov 2026): a square white picture tile with its number
 * and three actions (Improve, Replace, Remove; click the picture to see it large), the boxes, and the numbers panel.
 * The boxes: Product (the title, larger) and Dimensions on one row, Material and Remarks / customization under them. Remarks, the Internal note and Client
 * choices are shown only when they have something in them; otherwise one quiet row of "+ Remarks", "+ Internal note" and "+ Client choices" opens each,
 * so a product with nothing to add is not a wall of empty boxes. The numbers are one card: Quantity and Price (and, for the pricing desk, the suggestion),
 * then a footer with Optional, the tools and the total with how it is worked out. GST is not here: a quotation has one GST rate, in the totals
 * (each product still stores it).
 * There is no Finish box (owner, 13 Nov 2026: not needed). `finish` stays in the line's data, stored and re-sent on every save,
 * because the database rewrites the lines and a missing key would wipe it; words typed into Material and Remarks still reach the price model.
 */
export const REF_LABEL: Record<LineRef['kind'], string> = { swatch: 'Swatch', drawing: 'Drawing', reference: 'Reference' }
export function LineRow({ l, n, area, unit, editable, qty, total, first, last, url, onChange, onUpload, onUploadSwatch, onImprove, onView, hint, model, feedbackCtx, taught, onRemove, onMove, onDuplicate }: {
  l: QuoteLine; /** Its place on the page, 1, 2, 3…, across the room types. */ n: number; area: QuoteArea | null; unit: DimensionUnit; editable: boolean; qty: number; total: number; first: boolean; last: boolean
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
  const [remOpen, setRemOpen] = useState(!!l.spec)
  const [chOpen, setChOpen] = useState(false)
  const inches = unit === 'in' ? sizeInInches(l.size_text) : null
  const perUnit = l.qty_mode === 'per_unit' && !!area
  const label = l.name.trim() || 'this product'
  const showNote = noteOpen || !!l.internal_note
  const showRem = remOpen || !!l.spec
  const hasChoices = choiceCounts(l.choices).total > 0
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

  // The quiet row of things a product can still add; each draws only while it has not been added.
  const adders = editable ? [
    !showRem && <button key="rem" type="button" className={s.plAdd} onClick={() => setRemOpen(true)}>+ Remarks</button>,
    !showNote && <button key="note" type="button" className={s.plAdd} onClick={() => setNoteOpen(true)}>+ Internal note</button>,
    !chOpen && !hasChoices && <button key="ch" type="button" className={s.plAdd} onClick={() => setChOpen(true)}>+ Client choices</button>,
  ].filter(Boolean) : []
  return (
    <article className={s.pl} id={`line-${l.key}`} aria-label={`Product ${n}${l.name.trim() ? `, ${l.name.trim()}` : ''}`}>
      <div className={s.plPic} onMouseEnter={() => pointAtPicture(target)} onMouseLeave={() => pointAtPicture(null)} onFocus={() => pointAtPicture(target)}
        title={editable ? 'Point here and press Ctrl+C to copy this picture, or Ctrl+V to paste one' : l.image_path ? 'Point here and press Ctrl+C to copy this picture' : undefined}>
        <div className={s.plTile}>
          <span className={s.plIdx} aria-hidden>{n}</span>
          {l.image_path
            ? <button type="button" className={s.plPicBtn} onClick={onView} aria-label={`View the picture of ${label}`}><Pic className={s.plPicImg} src={url(l.image_path)} alt="" lazy /><span className={s.plZoom}><Maximize2 size={14} aria-hidden /></span></button>
            : <button type="button" className={s.plPicEmpty} onClick={() => fileRef.current?.click()} disabled={!editable}><ImagePlus size={22} aria-hidden /><b>Add picture</b>{editable && <span className={s.plPasteHint}>or paste (Ctrl+V)</span>}</button>}
        </div>
        {flash && <span className={`${s.small} ${s.muted}`} role="status">{flash}</span>}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={e => { onUpload(e.target.files?.[0]); e.target.value = '' }} />
        {editable && l.image_path && (
          <div className={s.plActs}>
            <button type="button" className={s.plImprove} onClick={onImprove} aria-label="Improve picture" title="Improve picture"><Sparkles size={14} aria-hidden /><span>Improve</span></button>
            <button type="button" className={s.plSq} onClick={() => fileRef.current?.click()} aria-label="Replace the picture" title="Replace picture"><RefreshCw size={15} aria-hidden /></button>
            <button type="button" className={`${s.plSq} ${s.plSqDanger}`} onClick={() => onChange({ image_path: null })} aria-label="Remove the picture" title="Remove picture"><Trash2 size={15} aria-hidden /></button>
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
        <label className={s.field}><span>Product</span><input aria-label="Product name" className={`${s.input} ${s.plTitle}`} placeholder="Product name, e.g. Bed" value={l.name} onChange={e => onChange({ name: e.target.value })} disabled={!editable} /></label>
        <label className={s.field}><span>Dimensions ({unit})</span>
          <span className={s.unitWrap}><input aria-label="Dimensions" className={s.input} placeholder="e.g. 83 × 68 × 18" value={l.size_text} onChange={e => onChange({ size_text: e.target.value })} onBlur={() => { const inch = unit === 'in' ? sizeToInches(l.size_text) : null; if (inch) onChange({ size_text: inch }) }} disabled={!editable} /><span className={s.unitTag} aria-hidden>{unit}</span></span>
          {inches && <span className={`${s.small} ${s.muted} ${s.num}`}>= {inches.join(' × ')} in</span>}
        </label>
        <label className={s.field}><span>Material</span><textarea aria-label="Material" className={`${s.input} ${s.grow}`} rows={1} maxLength={120} placeholder="e.g. Ash wood" value={l.material} onChange={e => onChange({ material: e.target.value })} disabled={!editable} /></label>
        {showRem
          ? <label className={s.field}><span>Remarks / customization <em style={{ fontStyle: 'normal', fontWeight: 400 }}>the client reads this</em></span><textarea aria-label="Remarks / customization" className={`${s.input} ${s.grow}`} rows={1} maxLength={1600} placeholder="What the client reads under the product" value={l.spec} onChange={e => onChange({ spec: e.target.value })} disabled={!editable} autoFocus={remOpen && !l.spec} /></label>
          : editable ? <div className={s.field}><span aria-hidden>&nbsp;</span><div className={s.plAdders}>{adders}</div></div> : <span />}
        {showRem && adders.length > 0 && <div className={s.plXrow}>{adders}</div>}
        {showNote && (
          <label className={`${s.field} ${s.plFull}`}><span>Internal note (never shown to the client)</span><input aria-label="Internal note" className={s.input} maxLength={1000} value={l.internal_note} onChange={e => onChange({ internal_note: e.target.value })} disabled={!editable} autoFocus={noteOpen && !l.internal_note} /></label>
        )}
        <ChoicesPanel choices={l.choices} editable={editable} url={url} shown={chOpen} onShown={setChOpen} onChange={choices => onChange({ choices })} onUpload={onUploadSwatch ?? (() => Promise.reject(new Error("Pictures cannot be added here")))} />
      </div>
      <div className={s.plRight}>
        <div className={s.plTop}>
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
        </div>
        <div className={s.plFoot}>
          <div>
            <label className={s.optLab}><input type="checkbox" checked={l.is_optional} onChange={e => onChange({ is_optional: e.target.checked })} disabled={!editable} /> Optional</label>
            {editable && (
              <div className={s.plTools}>
                <button className={s.iconBtn} onClick={() => onMove(-1)} disabled={first} aria-label="Move up"><ArrowUp size={15} /></button>
                <button className={s.iconBtn} onClick={() => onMove(1)} disabled={last} aria-label="Move down"><ArrowDown size={15} /></button>
                <button className={s.iconBtn} onClick={onDuplicate} aria-label="Duplicate"><Copy size={15} /></button>
                <button className={s.iconBtn} onClick={onRemove} aria-label="Remove product"><Trash2 size={15} /></button>
              </div>
            )}
          </div>
          <div>
            <div className={s.plTotal}>{l.unit_price === null ? <span className={s.muted}>No price</span> : formatINR(total)}</div>
            <div className={s.plPieces}>{l.is_optional ? 'not in the total' : l.unit_price === null ? `${qty.toLocaleString('en-IN')} ${qty === 1 ? 'piece' : 'pieces'}` : `${qty.toLocaleString('en-IN')} × ${formatINR(l.unit_price)}`}</div>
          </div>
        </div>
      </div>
    </article>
  )
}
