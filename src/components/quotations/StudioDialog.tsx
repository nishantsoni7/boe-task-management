'use client'

// Improve picture (phase 4): Clean up or Change it through /api/quotations/picture (one paid request per press),
// or Crop & rotate here on the device (free; the area is drawn with the mouse since 18 Nov 2026, CropBox). The result is
// shown beside the original; nothing changes on the quotation until "Use this picture" (and then the builder's Save).
// A made picture can be changed again with comments (owner, 18 Nov 2026): "Change this result" sends the RESULT back
// with what to change, and "Back to the previous one" steps to the one before.

import { useEffect, useState } from 'react'
import { RotateCw, Sparkles, Wand2, Crop } from 'lucide-react'
import type { createClient } from '@/lib/supabase/client'
import { shrinkPhoto } from '@/lib/exhibitionLeads/scanClient'
import { uploadPicture } from '@/lib/quotations/api'
import { MAX_INSTRUCTION } from '@/lib/quotations/pictureStudio'
import { Pic } from './Pic'
import { CropBox, WHOLE, renderCrop, type Box } from './CropBox'
import s from './quotations.module.css'

type Supabase = ReturnType<typeof createClient>
type Tab = 'clean' | 'change' | 'crop'

const blobToDataUrl = (b: Blob) => new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = bad; r.readAsDataURL(b) })

export function StudioDialog({ supabase, userId, path, url, wants, swatch, onClose, onUse }: {
  supabase: Supabase; userId: string; path: string; url: (p: string) => string
  /** What the client wants different from this reference picture (read from the client's file): opens "Change it" filled in. */
  wants?: string
  /** The client's swatch for it (a stored path), used as the reference picture. */
  swatch?: string
  onClose: () => void; onUse: (newPath: string) => void
}) {
  const [tab, setTab] = useState<Tab>(wants ? 'change' : 'clean')
  const [instruction, setInstruction] = useState(wants?.slice(0, MAX_INSTRUCTION) ?? '')
  const [reference, setReference] = useState<string | null>(null)
  // `url` is a new arrow on every render: depend on the address string, never the function, or this runs forever.
  const swatchUrl = swatch ? url(swatch) : null
  useEffect(() => {
    if (!swatchUrl) return
    let gone = false
    void fetch(swatchUrl).then(r => r.blob()).then(shrinkPhoto).then(blobToDataUrl).then(d => { if (!gone) setReference(d) }).catch(() => {})
    return () => { gone = true }
  }, [swatchUrl])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [turns, setTurns] = useState(0)
  const [box, setBox] = useState<Box>(WHOLE)
  // Changing a made picture again: what to change, and the pictures made before this one (Back).
  const [refine, setRefine] = useState('')
  const [earlier, setEarlier] = useState<string[]>([])

  // Crop & rotate: load the picture once, then draw it as it will be saved on every change.
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const src = url(path) // a string, so the effect below runs once per picture, not once per render
  useEffect(() => {
    if (tab !== 'crop') return
    const i = new Image()
    i.crossOrigin = 'anonymous'
    i.onload = () => setImg(i)
    i.src = src
  }, [tab, src])

  const run = async (again?: string) => {
    setBusy(true); setErr('')
    try {
      if (tab === 'crop' && again === undefined) {
        if (!img) throw new Error('The picture has not loaded yet.')
        const c = renderCrop(img, turns, box)
        const blob = await new Promise<Blob | null>(ok => c.toBlob(ok, 'image/jpeg', 0.92))
        if (!blob) throw new Error('The picture could not be prepared.')
        setResult(await uploadPicture(supabase, userId, blob))
        return
      }
      const res = await fetch('/api/quotations/picture', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // Again: the made picture is the starting point, changed by what was asked; otherwise the product's own picture.
        body: JSON.stringify(again !== undefined && result
          ? { sourcePath: result, mode: 'change', instruction: again, reference }
          : { sourcePath: path, mode: tab, instruction, reference }),
      })
      const json = await res.json().catch(() => null) as { ok: boolean; path?: string; error?: string } | null
      if (!json?.ok || !json.path) throw new Error(json?.error ?? 'The picture could not be made. Try again.')
      if (again !== undefined && result) { setEarlier(e => [...e, result]); setRefine('') }
      setResult(json.path)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Something went wrong.') } finally { setBusy(false) }
  }
  const pickReference = async (f: File | undefined) => {
    if (!f) return
    try { setReference(await blobToDataUrl(await shrinkPhoto(f))) } catch { setErr('That reference picture could not be read.') }
  }
  const tabBtn = (t: Tab, label: string, Icon: typeof Sparkles) => (
    <button type="button" role="tab" className={s.tab} aria-selected={tab === t} onClick={() => { setTab(t); setResult(null); setEarlier([]); setRefine(''); setErr('') }} disabled={busy}><Icon size={14} aria-hidden /> {label}</button>
  )

  return (
    <div className={s.scrim} onClick={busy || result ? undefined : onClose}>
      <div className={s.modal} style={{ maxWidth: 820 }} onClick={e => e.stopPropagation()} role="dialog" aria-labelledby="studio-title">
        <div className={s.cardHead}><h2 id="studio-title">Improve picture</h2><span className={s.spacer} /><button type="button" className={s.iconBtn} onClick={onClose} disabled={busy} aria-label="Close">×</button></div>
        <div className={s.tabs} role="tablist">{tabBtn('clean', 'Clean up', Sparkles)}{tabBtn('change', 'Change it', Wand2)}{tabBtn('crop', 'Crop & rotate', Crop)}</div>
        <div className={s.cardBody} style={{ display: 'grid', gap: 12 }}>
          {tab === 'clean' && <div className={s.small}>Redraws an unclear client picture (WhatsApp photo, screenshot, blurred PDF image) as a sharp catalogue picture of the same design on white. One paid request per press.</div>}
          {tab === 'change' && (
            <div style={{ display: 'grid', gap: 8 }}>
              <label className={s.field}><span>What to change</span><input id="studio-change" className={s.input} value={instruction} maxLength={MAX_INSTRUCTION} onChange={e => setInstruction(e.target.value)} placeholder="Walnut finish, add arms, fabric in mustard velvet…" disabled={!!result} /></label>
              <label className={s.small} style={{ cursor: 'pointer' }}>Reference picture (optional): <input type="file" accept="image/*" onChange={e => { void pickReference(e.target.files?.[0]); e.target.value = '' }} disabled={!!result} /> {reference && 'added'}</label>
              <div className={`${s.small} ${s.muted}`}>One paid request per press. Everything you do not mention stays the same.</div>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, alignItems: 'start' }}>
            <figure style={{ margin: 0 }}><figcaption className={`${s.small} ${s.muted}`}>Now</figcaption>
              {tab === 'crop' && !result
                ? (img ? <CropBox img={img} turns={turns} box={box} onBox={setBox} disabled={busy} /> : <div className={`${s.small} ${s.muted}`}>Opening the picture…</div>)
                : <Pic src={url(path)} alt="Current picture" className={s.studioPic} />}</figure>
            {result && <figure style={{ margin: 0 }}><figcaption className={`${s.small} ${s.muted}`}>New</figcaption><Pic src={url(result)} alt="New picture" className={s.studioPic} /></figure>}
          </div>
          {tab === 'crop' && !result && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className={s.btn} onClick={() => { setTurns(t => (t + 1) % 4); setBox(WHOLE) }} disabled={busy || !img}><RotateCw size={14} aria-hidden /> Rotate</button>
              <button type="button" className={s.btn} onClick={() => setBox(WHOLE)} disabled={busy || !img}>Select all</button>
            </div>
          )}
          {result && tab !== 'crop' && (
            <div style={{ display: 'grid', gap: 6 }} data-refine>
              <label className={s.field}><span>Change this result</span>
                <input className={s.input} value={refine} maxLength={MAX_INSTRUCTION} onChange={e => setRefine(e.target.value)} disabled={busy}
                  placeholder="What should be different, e.g. remove the cushion, straight legs, lighter wood" /></label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button type="button" className={s.btn} disabled={busy || refine.trim().length < 3} onClick={() => void run(refine.trim())}>{busy ? 'Making the picture… (up to a minute)' : 'Make these changes'}</button>
                {earlier.length > 0 && <button type="button" className={s.btn} disabled={busy} onClick={() => { setResult(earlier[earlier.length - 1]); setEarlier(e => e.slice(0, -1)) }}>Back to the previous one</button>}
                <span className={`${s.small} ${s.muted}`}>One paid request per press. The new picture starts from this one; everything you do not mention stays the same.</span>
              </div>
            </div>
          )}
          {err && <div className={`${s.notice} ${s.noticeBad}`} role="alert">{err}</div>}
        </div>
        <div className={s.cardHead} style={{ borderTop: '1px solid var(--boe-border)', borderBottom: 0, justifyContent: 'flex-end' }}>
          {!result && <button type="button" className={s.btn} onClick={onClose} disabled={busy}>Cancel</button>}
          {!result && <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={busy || (tab === 'change' && instruction.trim().length < 3)} onClick={() => void run()}>
            {busy ? (tab === 'crop' ? 'Saving…' : 'Making the picture… (up to a minute)') : tab === 'crop' ? 'Apply' : tab === 'clean' ? 'Clean up' : 'Make the change'}</button>}
          {result && <button type="button" className={s.btn} onClick={onClose}>Keep original</button>}
          {result && <button type="button" className={s.btn} onClick={() => { setResult(null); setEarlier([]); setRefine('') }} disabled={busy}>Start over</button>}
          {result && <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={() => onUse(result)}>Use this picture</button>}
        </div>
      </div>
    </div>
  )
}
