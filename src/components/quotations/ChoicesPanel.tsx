'use client'

import { useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ImagePlus } from 'lucide-react'
import { istToday } from '@/lib/istDate'
import { CHOICE_KINDS, CHOICE_LABEL, CHOICE_MAX, choiceCounts, type ChoiceKind, type LineChoice, type LineChoices } from '@/lib/quotations/math'
import { Pic } from './Pic'
import s from './quotations.module.css'

/**
 * Client choices under a product (owner, 18 Nov 2026): what the client picked for fabric, finish, stone and rope weave, from our
 * catalog or their own. Layout 2 of the preview: one row per product in the table that PR 2 prints; this is where it is entered.
 * A choice never changes a price and is never locked; "Confirmed by the client" only stamps today's date.
 */
export function ChoicesPanel({ choices, editable, url, onChange, onUpload }: {
  choices: LineChoices | undefined; editable: boolean; url: (path: string) => string
  onChange: (c: LineChoices) => void; onUpload: (f: File) => Promise<string>
}) {
  const { total, open: waiting } = choiceCounts(choices)
  const [shown, setShown] = useState(false)
  const set = (k: ChoiceKind, v: LineChoice | undefined) => {
    const next = { ...choices }
    if (v) next[k] = v
    else delete next[k]
    onChange(next)
  }
  return (
    <div className={s.chWrap}>
      <button type="button" className={s.chToggle} aria-expanded={shown} onClick={() => setShown(v => !v)}>
        {shown ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />}
        Client choices
        {total > 0
          ? <span className={`${s.chip} ${waiting ? s.chWait : s.chDone}`}>{waiting ? `${waiting} to confirm` : `${total} confirmed`}</span>
          : <span className={`${s.small} ${s.muted}`}>fabric, finish, stone, rope weave</span>}
      </button>
      {shown && (
        <div className={s.chBody}>
          {CHOICE_KINDS.map(k => (
            <ChoiceRow key={k} kind={k} v={choices?.[k]} editable={editable} url={url} onUpload={onUpload} onChange={v => set(k, v)} />
          ))}
          <p className={`${s.small} ${s.muted}`}>Only kept inside BOE One for now. A choice never changes the price.</p>
        </div>
      )}
    </div>
  )
}

function ChoiceRow({ kind, v, editable, url, onChange, onUpload }: {
  kind: ChoiceKind; v: LineChoice | undefined; editable: boolean; url: (path: string) => string
  onChange: (v: LineChoice | undefined) => void; onUpload: (f: File) => Promise<string>
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [msg, setMsg] = useState('')
  const label = CHOICE_LABEL[kind]
  if (!v) {
    return (
      <div className={s.chRow}>
        <b>{label}</b>
        <span className={`${s.small} ${s.muted}`}>Not used</span>
        {editable && <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => onChange({ source: 'catalog', status: 'to_confirm' })}>Add {label.toLowerCase()}</button>}
      </div>
    )
  }
  const catalog = v.source === 'catalog'
  const text = (f: 'name' | 'code' | 'supplier' | 'used_for' | 'note', name: string, ph: string, wide = false) => (
    <label className={`${s.field} ${wide ? s.chWide : ''}`}><span>{name}</span>
      <input aria-label={`${label} ${name.toLowerCase()}`} className={s.input} maxLength={CHOICE_MAX[f]} placeholder={ph} value={v[f] ?? ''} onChange={e => onChange({ ...v, [f]: e.target.value })} disabled={!editable} />
    </label>
  )
  const pick = async (f: File | undefined) => {
    if (!f) return
    setMsg('Uploading…')
    try { onChange({ ...v, photo: await onUpload(f) }); setMsg('') } catch (e) { setMsg(e instanceof Error ? e.message : 'The picture could not be uploaded') }
  }
  return (
    <div className={s.chRow} data-open>
      <b>{label}</b>
      <div className={s.chForm}>
        <div className={s.chSeg} role="group" aria-label={`${label} comes from`}>
          <button type="button" aria-pressed={catalog} className={catalog ? s.chOn : undefined} disabled={!editable} onClick={() => onChange({ ...v, source: 'catalog' })}>From our catalog</button>
          <button type="button" aria-pressed={!catalog} className={!catalog ? s.chOn : undefined} disabled={!editable} onClick={() => onChange({ ...v, source: 'client' })}>Client&apos;s own</button>
        </div>
        <div className={s.chGrid}>
          {text('name', catalog ? 'Name' : 'What the client chose', catalog ? 'e.g. Berlin velvet' : 'e.g. their own linen, 4 m')}
          {catalog && text('code', 'Code / shade', 'e.g. F18')}
          {text('supplier', catalog ? 'Supplier' : 'Who supplies it', catalog ? 'e.g. V2 Homes' : 'Client sends it, or a supplier')}
          {text('used_for', 'Where used', 'e.g. seat and back')}
          {text('note', 'Note', 'Anything the factory should know', true)}
        </div>
        <div className={s.chFoot}>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={e => { void pick(e.target.files?.[0]); e.target.value = '' }} />
          {v.photo
            ? <span className={s.plRef}><a href={url(v.photo)} target="_blank" rel="noreferrer"><Pic className={s.plRefImg} src={url(v.photo)} alt={`${label} swatch`} lazy /></a></span>
            : null}
          {editable && <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => fileRef.current?.click()}><ImagePlus size={14} aria-hidden /> {v.photo ? 'Replace swatch photo' : 'Add swatch photo'}</button>}
          {editable && v.photo && <button type="button" className={s.plRm} onClick={() => onChange({ ...v, photo: null })}>Remove photo</button>}
          <label className={s.optLab}>
            <input type="checkbox" checked={v.status === 'confirmed'} disabled={!editable}
              onChange={e => onChange(e.target.checked ? { ...v, status: 'confirmed', confirmed_on: v.confirmed_on || istToday() } : { ...v, status: 'to_confirm', confirmed_on: undefined })} />
            {' '}Confirmed by the client{v.status === 'confirmed' && v.confirmed_on ? ` on ${v.confirmed_on}` : ''}
          </label>
          {editable && <button type="button" className={s.plRm} onClick={() => onChange(undefined)}>Remove {label.toLowerCase()}</button>}
          {msg && <span className={`${s.small} ${s.muted}`} role="status">{msg}</span>}
        </div>
      </div>
    </div>
  )
}
