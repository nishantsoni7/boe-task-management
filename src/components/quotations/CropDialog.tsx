'use client'

// Crop & rotate a picture in the scan review, before anything is saved (16 Nov 2026, owner chose "trim and rotate"; since
// 18 Nov 2026 the area is drawn with the mouse, as in Photoshop: CropBox). The picture is still only on this device.

import { useEffect, useState } from 'react'
import { RotateCw } from 'lucide-react'
import { CropBox, WHOLE, renderCrop, type Box } from './CropBox'
import s from './quotations.module.css'

export function CropDialog({ src, onClose, onUse }: { src: string; onClose: () => void; onUse: (picture: Blob) => void }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [turns, setTurns] = useState(0)
  const [box, setBox] = useState<Box>(WHOLE)
  const [err, setErr] = useState('')

  useEffect(() => {
    const i = new Image()
    i.onload = () => setImg(i)
    i.onerror = () => setErr('This picture could not be opened.')
    i.src = src
  }, [src])

  const apply = () => {
    if (!img) return
    renderCrop(img, turns, box).toBlob(b => (b ? onUse(b) : setErr('The picture could not be saved.')), 'image/jpeg', 0.92)
  }
  // A turn changes which way is up, so the box drawn before it no longer means the same area: start again from the whole.
  const rotate = () => { setTurns(t => (t + 1) % 4); setBox(WHOLE) }

  return (
    <div className={s.scrim} onClick={onClose}>
      <div className={s.modal} style={{ maxWidth: 620 }} onClick={e => e.stopPropagation()} role="dialog" aria-labelledby="crop-title">
        <div className={s.cardHead}><h2 id="crop-title">Crop & rotate</h2><span className={s.spacer} /><button type="button" className={s.iconBtn} onClick={onClose} aria-label="Close">×</button></div>
        <div className={s.cardBody} style={{ display: 'grid', gap: 12 }}>
          {img ? <CropBox img={img} turns={turns} box={box} onBox={setBox} /> : !err && <div className={`${s.small} ${s.muted}`}>Opening the picture…</div>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className={s.btn} onClick={rotate} disabled={!img}><RotateCw size={14} aria-hidden /> Rotate</button>
            <button type="button" className={s.btn} onClick={() => setBox(WHOLE)} disabled={!img}>Select all</button>
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
