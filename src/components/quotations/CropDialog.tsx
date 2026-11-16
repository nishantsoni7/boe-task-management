'use client'

// Crop & rotate a picture in the scan review, before anything is saved (16 Nov 2026, owner chose "trim and rotate"):
// the same drawing as Improve picture → Crop & rotate (StudioDialog.drawCrop), on a picture that is still only on this
// device. Trims inward only: a picture cut too tight is fixed by choosing a spare one, or Replace after adding.

import { useEffect, useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'
import { drawCrop, type Insets } from './StudioDialog'
import s from './quotations.module.css'

export function CropDialog({ src, onClose, onUse }: { src: string; onClose: () => void; onUse: (picture: Blob) => void }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [turns, setTurns] = useState(0)
  const [cut, setCut] = useState<Insets>({ top: 0, right: 0, bottom: 0, left: 0 })
  const [err, setErr] = useState('')
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const i = new Image()
    i.onload = () => setImg(i)
    i.onerror = () => setErr('This picture could not be opened.')
    i.src = src
  }, [src])
  useEffect(() => { if (img && canvasRef.current) drawCrop(img, canvasRef.current, turns, cut) }, [img, turns, cut])

  const apply = () => {
    const c = canvasRef.current
    if (!c) return
    c.toBlob(b => (b ? onUse(b) : setErr('The picture could not be saved.')), 'image/jpeg', 0.92)
  }
  const slider = (k: keyof Insets, label: string) => (
    <label className={s.field} key={k}><span>{label} {cut[k]}%</span>
      <input type="range" min={0} max={45} value={cut[k]} onChange={e => setCut(p => ({ ...p, [k]: Number(e.target.value) }))} /></label>
  )

  return (
    <div className={s.scrim} onClick={onClose}>
      <div className={s.modal} style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()} role="dialog" aria-labelledby="crop-title">
        <div className={s.cardHead}><h2 id="crop-title">Crop & rotate</h2><span className={s.spacer} /><button type="button" className={s.iconBtn} onClick={onClose} aria-label="Close">×</button></div>
        <div className={s.cardBody} style={{ display: 'grid', gap: 12 }}>
          <canvas ref={canvasRef} style={{ maxWidth: '100%', maxHeight: 320, justifySelf: 'center', border: '1px solid var(--boe-border)', borderRadius: 8 }} aria-label="The picture as it will be kept" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
            {slider('top', 'Top')}{slider('bottom', 'Bottom')}{slider('left', 'Left')}{slider('right', 'Right')}
            <button type="button" className={s.btn} style={{ alignSelf: 'end' }} onClick={() => setTurns(t => (t + 1) % 4)}><RotateCw size={14} aria-hidden /> Rotate</button>
          </div>
          {err && <div className={`${s.notice} ${s.noticeBad}`} role="alert">{err}</div>}
        </div>
        <div className={s.cardHead} style={{ borderTop: '1px solid var(--boe-border)', borderBottom: 0, justifyContent: 'flex-end' }}>
          <button type="button" className={s.btn} onClick={onClose}>Cancel</button>
          <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={apply} disabled={!img}>Use this picture</button>
        </div>
      </div>
    </div>
  )
}
