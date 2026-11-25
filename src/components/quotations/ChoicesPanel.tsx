'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, ImageIcon, ImagePlus, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { istToday } from '@/lib/istDate'
import {
  CHOICE_KINDS, CHOICE_LABEL, CHOICE_MAX, MAX_CHOICES, choiceCounts, choiceKeys, choiceLabel, choiceNamed, isFixedKind, newChoiceKey,
  type ChoiceKey, type LineChoice, type LineChoices, type QuoteLine,
} from '@/lib/quotations/math'
import { Pic } from './Pic'
import s from './quotations.module.css'

/**
 * Client choices under a product (owner, 18 Nov 2026; version 2 step 3, 25 Nov 2026): what the client picked, from our catalog or their own.
 * Any choice can be added by name (20270828000000): Fabric and Finish are the usual ones, then Stone, Rope weave, Leather or anything else.
 * Opened, the choices sit side by side as COMPACT cards (owner: "too big", then "slightly smaller"): the photo, and the choice's name and the
 * selection under it. A pencil edits one card in place. A choice never changes a price and is never locked; "Confirmed by the client" only
 * stamps today's date. Supplier and Where used are gone from the form (owner: "we can add these details in notes"); a choice saved with
 * them before still shows them, so they can be edited or cleared.
 */

/** The names the Choice box suggests: the four fixed kinds, then the common others from the owner's mockup. */
const MORE_NAMES = ['Leather', 'Cane', 'Glass', 'Metal', 'Marble', 'Wood']
const SOURCE_TEXT: Record<LineChoice['source'], string> = { catalog: 'From our catalog', client: 'Client’s own', code: 'Client’s code, we source it' }

/** What was chosen, in a few words: the name and code, or whose it is when it has neither. */
export function choiceText(c: LineChoice): string {
  const named = [c.name, c.code].map(x => (x ?? '').trim()).filter(Boolean).join(' ')
  if (c.source === 'code') return named ? `Client’s code: ${named}` : 'Client’s code'
  return named || (c.source === 'client' ? 'Client’s own' : 'Not named yet')
}

/**
 * What the product's strip says while the panel is closed (owner, 25 Nov 2026, version 2): the first two choices by name, then how many wait
 * for the client, so nobody has to open the panel to know.
 */
export function ChoicesSummary({ choices }: { choices: LineChoices | undefined }) {
  const { total, open: waiting } = choiceCounts(choices)
  if (!total) return <span className={`${s.small} ${s.muted} ${s.chSumText}`}>none yet: fabric, finish or anything else</span>
  const keys = choiceKeys(choices)
  return (
    <>
      {keys.slice(0, 2).map(k => <span key={k} className={s.chSum}>{choiceLabel(k, choices![k])}: {choiceText(choices![k]!)}</span>)}
      {keys.length > 2 && <span className={s.chSum}>+{keys.length - 2} more</span>}
      {waiting > 0 ? <span className={`${s.chip} ${s.chWait}`}>{waiting} to confirm</span> : <span className={`${s.chip} ${s.chDone}`}>{total} confirmed</span>}
    </>
  )
}

/** A finished any-name choice called like a free fixed kind ("fabric") moves to that kind's key; anything else stays as it is. */
export function settle(c: LineChoices | undefined, k: ChoiceKey): [LineChoices | undefined, ChoiceKey] {
  const v = c?.[k]
  if (!v || isFixedKind(k)) return [c, k]
  const fixed = CHOICE_KINDS.find(f => CHOICE_LABEL[f].toLowerCase() === (v.label ?? '').trim().toLowerCase())
  if (!fixed || c?.[fixed]) return [c, k]
  const next = { ...c }, moved = { ...v }
  delete next[k]
  delete moved.label
  next[fixed] = moved
  return [next, fixed]
}

/** The cards under a product; its strip (ProductLine.tsx) opens and closes them. Fabric and finish are chosen here only (25 Nov 2026). */
export function ChoicesPanel({ choices, editable, url, onChange, onUpload, onCopy }: {
  choices: LineChoices | undefined; editable: boolean; url: (path: string) => string
  onChange: (c: LineChoices) => void; onUpload: (f: File) => Promise<string>
  /** Opens "Copy to…" for one choice; the builder holds the dialog, since it needs every product. */
  onCopy?: (key: ChoiceKey) => void
}) {
  const [editing, setEditing] = useState<ChoiceKey | null>(null)
  const listId = useId()
  const keys = choiceKeys(choices)
  const set = (k: ChoiceKey, v: LineChoice | undefined) => {
    const next = { ...choices }
    if (v) next[k] = v
    else delete next[k]
    onChange(next)
  }
  // Done: a choice named like one of the four fixed kinds, while that kind is free, moves to its key, so the Fabric and packing tab and the
  // PI see it. Returns the key the choice ends up under.
  const finish = (k: ChoiceKey): ChoiceKey => {
    setEditing(null)
    const [next, key] = settle(choices, k)
    if (next !== choices) onChange(next ?? {})
    return key
  }
  const edit = (k: ChoiceKey) => { if (editing && editing !== k) finish(editing); setEditing(k) }
  const add = () => {
    const base = editing ? settle(choices, editing)[0] : choices
    const k = newChoiceKey()
    onChange({ ...base, [k]: { source: 'catalog', status: 'to_confirm', label: '' } })
    setEditing(k)
  }
  const named = new Set(keys.map(k => choiceLabel(k, choices![k]).toLowerCase()))
  const names = [...CHOICE_KINDS.map(k => CHOICE_LABEL[k]), ...MORE_NAMES].filter(n => !named.has(n.toLowerCase()))
  return (
    <div className={s.ccCards}>
      {keys.map(k => (editable && editing === k
        ? <ChoiceEdit key={k} k={k} v={choices![k]!} listId={listId} url={url} onUpload={onUpload} onChange={v => set(k, v)}
            onDone={() => finish(k)} onRemove={() => { setEditing(null); set(k, undefined) }} onCopy={onCopy ? () => onCopy(finish(k)) : undefined} />
        : <ChoiceCard key={k} k={k} v={choices![k]!} url={url} editable={editable} onEdit={() => edit(k)} />))}
      {editable && (keys.length < MAX_CHOICES
        ? <button type="button" className={s.ccAdd} onClick={add}><Plus size={18} aria-hidden /><span>Add a choice</span><small>fabric, finish, stone or anything else</small></button>
        : <p className={`${s.small} ${s.muted}`}>A product holds {MAX_CHOICES} choices at most.</p>)}
      {!editable && keys.length === 0 && <p className={`${s.small} ${s.muted}`}>No choices yet.</p>}
      <datalist id={listId}>{names.map(n => <option key={n} value={n} />)}</datalist>
    </div>
  )
}

function ChoiceCard({ k, v, url, editable, onEdit }: { k: ChoiceKey; v: LineChoice; url: (path: string) => string; editable: boolean; onEdit: () => void }) {
  const label = choiceLabel(k, v), ok = v.status === 'confirmed'
  return (
    <article className={s.ccCard} title={[SOURCE_TEXT[v.source], v.note?.trim()].filter(Boolean).join(' · ')}>
      <div className={s.ccImg}>
        {v.photo
          ? <a className={s.ccImgLink} href={url(v.photo)} target="_blank" rel="noreferrer"><Pic className={s.ccPhoto} src={url(v.photo)} alt={`${label} photo`} lazy /></a>
          : <span className={s.ccNoPhoto}><ImageIcon size={18} aria-hidden /><span>No photo</span></span>}
        <span className={`${s.ccDot} ${ok ? s.ccDotOk : s.ccDotWait}`} role="img" aria-label={ok ? 'Confirmed by the client' : 'To confirm'} title={ok ? 'Confirmed by the client' : 'To confirm'}>{ok ? <Check size={11} aria-hidden /> : null}</span>
        {editable && <button type="button" className={s.ccPen} onClick={onEdit} aria-label={`Edit ${label}`} title="Edit"><Pencil size={13} aria-hidden /></button>}
      </div>
      <div className={s.ccBody}>
        <span className={s.ccKind}>{label}{ok ? null : <> · <em>to confirm</em></>}</span>
        <b className={s.ccName}>{choiceText(v)}</b>
      </div>
    </article>
  )
}

function ChoiceEdit({ k, v, listId, url, onUpload, onChange, onDone, onRemove, onCopy }: {
  k: ChoiceKey; v: LineChoice; listId: string; url: (path: string) => string; onUpload: (f: File) => Promise<string>
  onChange: (v: LineChoice) => void; onDone: () => void; onRemove: () => void; onCopy?: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [msg, setMsg] = useState('')
  const fixed = isFixedKind(k)
  const label = choiceLabel(k, v), ok = v.status === 'confirmed'
  const pick = async (f: File | undefined) => {
    if (!f) return
    setMsg('Uploading…')
    try { onChange({ ...v, photo: await onUpload(f) }); setMsg('') } catch (e) { setMsg(e instanceof Error ? e.message : 'The picture could not be uploaded') }
  }
  const text = (f: 'name' | 'code' | 'supplier' | 'used_for', name: string, ph: string) => (
    <label className={s.field}><span>{name}</span>
      <input aria-label={`${label} ${name.toLowerCase()}`} className={s.input} maxLength={CHOICE_MAX[f]} placeholder={ph} value={v[f] ?? ''} onChange={e => onChange({ ...v, [f]: e.target.value })} />
    </label>
  )
  return (
    <article className={`${s.ccCard} ${s.ccEdit}`} aria-label={`Edit ${label}`}>
      <div className={`${s.ccImg} ${s.ccImgSm}`}>
        {v.photo ? <Pic className={s.ccPhoto} src={url(v.photo)} alt={`${label} photo`} /> : null}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={e => { void pick(e.target.files?.[0]); e.target.value = '' }} />
        <button type="button" className={`${s.ccPhotoBtn} ${v.photo ? '' : s.ccPhotoSolo}`} onClick={() => fileRef.current?.click()}>
          {v.photo ? <><RefreshCw size={13} aria-hidden /> Replace photo</> : <><ImagePlus size={15} aria-hidden /> Add photo</>}
        </button>
        {v.photo && <button type="button" className={s.ccPen} onClick={() => onChange({ ...v, photo: null })} aria-label="Remove photo" title="Remove photo"><X size={14} aria-hidden /></button>}
      </div>
      <div className={s.ccForm}>
        {fixed
          ? <div className={s.field}><span>Choice</span><b className={s.ccFixed}>{label}</b></div>
          : <label className={s.field}><span>Choice</span>
              <input aria-label="Choice" className={s.input} list={listId} maxLength={CHOICE_MAX.label} placeholder="e.g. Stone, Leather, Cane" value={v.label ?? ''} onChange={e => onChange({ ...v, label: e.target.value })} autoFocus={!v.label} />
            </label>}
        <label className={s.field}><span>Comes from</span>
          <select aria-label={`${label} comes from`} className={s.input} value={v.source} onChange={e => onChange({ ...v, source: e.target.value as LineChoice['source'] })}>
            {(Object.keys(SOURCE_TEXT) as LineChoice['source'][]).map(x => <option key={x} value={x}>{SOURCE_TEXT[x]}</option>)}
          </select>
        </label>
        <div className={s.ccTwo}>
          {text('name', 'Name', v.source === 'client' ? 'What the client chose' : 'e.g. Berlin velvet')}
          {text('code', v.source === 'code' ? 'Client’s code' : 'Code / shade', 'e.g. F18')}
        </div>
        {(v.supplier || v.used_for) && <div className={s.ccTwo}>{v.supplier ? text('supplier', 'Supplier', '') : null}{v.used_for ? text('used_for', 'Where used', '') : null}</div>}
        <label className={s.field}><span className={s.labRow}><span>Note</span><span className={`${s.small} ${s.muted}`}>Only your team sees it</span></span>
          <textarea aria-label={`${label} note`} className={`${s.input} ${s.ccNote}`} rows={2} maxLength={CHOICE_MAX.note} placeholder="Supplier, where used, anything for the factory" value={v.note ?? ''} onChange={e => onChange({ ...v, note: e.target.value })} />
        </label>
        <label className={s.optLab}>
          <input type="checkbox" checked={ok}
            onChange={e => onChange(e.target.checked ? { ...v, status: 'confirmed', confirmed_on: v.confirmed_on || istToday() } : { ...v, status: 'to_confirm', confirmed_on: undefined })} />
          {' '}Confirmed by the client{ok && v.confirmed_on ? ` on ${v.confirmed_on}` : ''}
        </label>
        {msg && <span className={`${s.small} ${s.muted}`} role="status">{msg}</span>}
      </div>
      <div className={s.ccFoot}>
        <button type="button" className={`${s.btn} ${s.btnSm} ${s.btnPrimary}`} onClick={onDone}>Done</button>
        <span className={s.spacer} />
        {onCopy && <button type="button" className={`${s.btn} ${s.btnSm} ${s.btnQuiet}`} onClick={onCopy}><Copy size={14} aria-hidden /> Copy to…</button>}
        <button type="button" className={`${s.iconBtn} ${s.iconDanger}`} onClick={onRemove} aria-label={`Remove ${label}`} title="Remove"><Trash2 size={16} aria-hidden /></button>
      </div>
    </article>
  )
}

/**
 * "Copy to…" (owner's mockup, 25 Nov 2026): pick the products one choice goes to, instead of copying to all 50. Each row shows the product's
 * number, picture and name, and what it has of that choice now. The builder does the copy (copyChoiceTo) and offers Undo.
 */
export function CopyChoiceDialog({ lines, from, choiceKey, url, onCopy, onClose }: {
  /** Every product, in the order of the page (its number is its place here). */
  lines: readonly QuoteLine[]; from: string; choiceKey: ChoiceKey; url: (path: string) => string
  onCopy: (to: ReadonlySet<string>) => void; onClose: () => void
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const src = lines.find(l => l.key === from)
  const c = src?.choices?.[choiceKey]
  if (!src || !c) return null
  const name = choiceLabel(choiceKey, c), lower = name.toLowerCase()
  const others = lines.map((l, i) => ({ l, no: i + 1 })).filter(x => x.l.key !== from)
  const hasOf = (l: QuoteLine) => { const k = choiceNamed(l.choices, name); return k ? l.choices![k]! : undefined }
  const without = others.filter(x => !hasOf(x.l))
  const toggle = (key: string, on: boolean) => setPicked(p => { const n = new Set(p); if (on) n.add(key); else n.delete(key); return n })
  const n = picked.size
  return createPortal(
    <div className={s.scrim} onClick={onClose}>
      <div className={`${s.modal} ${s.cpDlg}`} role="dialog" aria-modal="true" aria-labelledby="cp-title" onClick={e => e.stopPropagation()}>
        <div className={s.cardHead}>
          <div className={s.briefTitle}>
            <span className={`${s.small} ${s.muted}`}>Copy {name}</span>
            <h2 id="cp-title">{choiceText(c)}</h2>
            <span className={`${s.small} ${s.muted}`}>from {src.name.trim() || 'this product'} · the photo, name, code, note and confirmation are copied</span>
          </div>
          <button type="button" className={s.iconBtn} onClick={onClose} aria-label="Close" autoFocus><X size={16} aria-hidden /></button>
        </div>
        <div className={`${s.cardBody} ${s.cpBody}`}>
          <div className={s.row}>
            <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => setPicked(new Set(others.map(x => x.l.key)))}>Select all ({others.length})</button>
            {without.length > 0 && without.length < others.length && <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => setPicked(new Set(without.map(x => x.l.key)))}>Only those without {lower} ({without.length})</button>}
            {n > 0 && <button type="button" className={`${s.btn} ${s.btnSm} ${s.btnQuiet}`} onClick={() => setPicked(new Set())}>Clear</button>}
          </div>
          <div className={s.cpList}>
            {others.map(({ l, no }) => {
              const has = hasOf(l)
              return (
                <label key={l.key} className={s.cpItem}>
                  <input type="checkbox" checked={picked.has(l.key)} onChange={e => toggle(l.key, e.target.checked)} />
                  <span className={s.cpThumb}>{l.image_path ? <Pic src={url(l.image_path)} alt="" lazy /> : <ImageIcon size={14} aria-hidden />}</span>
                  <span className={s.cpName}><span className={s.muted}>{no}</span> {l.name.trim() || 'Untitled product'}</span>
                  <span className={s.cpHas}>{has ? `has ${choiceText(has)}` : `no ${lower} yet`}</span>
                </label>
              )
            })}
          </div>
          <p className={`${s.small} ${s.muted}`}>A product that has {lower} gets it replaced.</p>
        </div>
        <div className={s.briefFoot}>
          <button type="button" className={s.btn} onClick={onClose}>Cancel</button>
          <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={!n} onClick={() => onCopy(picked)}>Copy to {n} {n === 1 ? 'product' : 'products'}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
