'use client'

// Improve picture (phase 4): Clean up or Change it through /api/quotations/picture (one paid request per press),
// or Crop & rotate here on the device (free). The result is shown beside the original; nothing changes on the
// quotation until "Use this picture" (and then the builder's Save).

import { useEffect, useRef, useState } from 'react'
import { RotateCw, Sparkles, Wand2, Crop } from 'lucide-react'
import type { createClient } from '@/lib/supabase/client'
import { shrinkPhoto } from '@/lib/exhibitionLeads/scanClient'
import { uploadPicture } from '@/lib/quotations/api'
import { MAX_INSTRUCTION } from '@/lib/quotations/pictureStudio'
import { Pic } from './Pic'
import s from './quotations.module.css'

type Supabase = ReturnType<typeof createClient>
type Tab = 'clean' | 'change' | 'crop'
type Insets = { top: number; right: number; bottom: number; left: number }

function drawCrop(img: HTMLImageElement, c: HTMLCanvasElement, turns: number, cut: Insets) {
  const sx = (img.naturalWidth * cut.left) / 100, sy = (img.naturalHeight * cut.top) / 100
  const sw = Math.max(1, img.naturalWidth * (1 - (cut.left + cut.right) / 100)), sh = Math.max(1, img.naturalHeight * (1 - (cut.top + cut.bottom) / 100))
  const side = turns % 2 === 1
  c.width = side ? sh : sw; c.height = side ? sw : sh
  const g = c.getContext('2d')!
  g.save(); g.translate(c.width / 2, c.height / 2); g.rotate((turns * Math.PI) / 2)
  g.drawImage(img, sx, sy, sw, sh, -sw / 2, -sh / 2, sw, sh); g.restore()
}

const blobToDataUrl = (b: Blob) => new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = bad; r.readAsDataURL(b) })

export function StudioDialog({ supabase, userId, path, url, onClose, onUse }: {
  supabase: Supabase; userId: string; path: string; url: (p: string) => string
  onClose: () => void; onUse: (newPath: string) => void
}) {
  const [tab, setTab] = useState<Tab>('clean')
  const [instruction, setInstruction] = useState('')
  const [reference, setReference] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [turns, setTurns] = useState(0)
  const [cut, setCut] = useState<Insets>({ top: 0, right: 0, bottom: 0, left: 0 })
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

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
  useEffect(() => { if (img && canvasRef.current) drawCrop(img, canvasRef.current, turns, cut) }, [img, turns, cut, result, tab])

  const run = async () => {
    setBusy(true); setErr('')
    try {
      if (tab === 'crop') {
        const c = canvasRef.current
        if (!c) throw new Error('The picture has not loaded yet.')
        const blob = await new Promise<Blob | null>(ok => c.toBlob(ok, 'image/jpeg', 0.92))
        if (!blob) throw new Error('The picture could not be prepared.')
        setResult(await uploadPicture(supabase, userId, blob))
        return
      }
      const res = await fetch('/api/quotations/picture', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath: path, mode: tab, instruction, reference }),
      })
      const json = await res.json().catch(() => null) as { ok: boolean; path?: string; error?: string } | null
      if (!json?.ok || !json.path) throw new Error(json?.error ?? 'The picture could not be made. Try again.')
      setResult(json.path)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Something went wrong.') } finally { setBusy(false) }
  }
  const pickReference = async (f: File | undefined) => {
    if (!f) return
    try { setReference(await blobToDataUrl(await shrinkPhoto(f))) } catch { setErr('That reference picture could not be read.') }
  }
  const slider = (k: keyof Insets, label: string) => (
    <label className={s.field} key={k}><span>{label} {cut[k]}%</span>
      <input type="range" min={0} max={45} value={cut[k]} onChange={e => setCut(p => ({ ...p, [k]: Number(e.target.value) }))} disabled={!!result} /></label>
  )
  const tabBtn = (t: Tab, label: string, Icon: typeof Sparkles) => (
    <button type="button" role="tab" className={s.tab} aria-selected={tab === t} onClick={() => { setTab(t); setResult(null); setErr('') }} disabled={busy}><Icon size={14} aria-hidden /> {label}</button>
  )

  return (
    <div className={s.scrim} onClick={busy ? undefined : onClose}>
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
              {tab === 'crop' && !result ? <canvas ref={canvasRef} style={{ maxWidth: '100%', maxHeight: 320, border: '1px solid var(--boe-border)', borderRadius: 8 }} /> : <Pic src={url(path)} alt="Current picture" className={s.studioPic} />}</figure>
            {result && <figure style={{ margin: 0 }}><figcaption className={`${s.small} ${s.muted}`}>New</figcaption><Pic src={url(result)} alt="New picture" className={s.studioPic} /></figure>}
          </div>
          {tab === 'crop' && !result && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
              {slider('top', 'Top')}{slider('bottom', 'Bottom')}{slider('left', 'Left')}{slider('right', 'Right')}
              <button type="button" className={s.btn} style={{ alignSelf: 'end' }} onClick={() => setTurns(t => (t + 1) % 4)}><RotateCw size={14} aria-hidden /> Rotate</button>
            </div>
          )}
          {err && <div className={`${s.notice} ${s.noticeBad}`} role="alert">{err}</div>}
        </div>
        <div className={s.cardHead} style={{ borderTop: '1px solid var(--boe-border)', borderBottom: 0, justifyContent: 'flex-end' }}>
          {!result && <button type="button" className={s.btn} onClick={onClose} disabled={busy}>Cancel</button>}
          {!result && <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={busy || (tab === 'change' && instruction.trim().length < 3)} onClick={run}>
            {busy ? (tab === 'crop' ? 'Saving…' : 'Making the picture… (up to a minute)') : tab === 'crop' ? 'Apply' : tab === 'clean' ? 'Clean up' : 'Make the change'}</button>}
          {result && <button type="button" className={s.btn} onClick={onClose}>Keep original</button>}
          {result && <button type="button" className={s.btn} onClick={() => setResult(null)}>Try again</button>}
          {result && <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={() => onUse(result)}>Use this picture</button>}
        </div>
      </div>
    </div>
  )
}
