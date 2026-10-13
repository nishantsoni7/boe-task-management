'use client'

import { useRef } from 'react'
import { AlertCircle, Camera, ImagePlus, Loader2, RotateCw, Star, X } from 'lucide-react'
import { MAX_IMAGES } from '@/lib/inventory/constants'
import s from './inventory.module.css'

export type Photo = {
  key: string
  /** The bucket path once uploaded. */
  path: string | null
  /** What to show: the saved picture's address, or a local preview while it uploads. */
  url: string
  status: 'uploading' | 'ok' | 'failed'
  /** Kept so a failed upload can be tried again without picking the file again. */
  blob?: Blob
}

type Props = {
  photos: Photo[]
  onAdd: (files: File[]) => void
  onRemove: (key: string) => void
  onMakeCover: (key: string) => void
  onRetry: (key: string) => void
  invalid?: boolean
}

export function ImageUploader({ photos, onAdd, onRemove, onMakeCover, onRetry, invalid }: Props) {
  const galleryRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const room = MAX_IMAGES - photos.length

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])].filter(f => f.type.startsWith('image/')).slice(0, Math.max(0, room))
    e.target.value = '' // the same file can be picked again after a removal
    if (files.length) onAdd(files)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {photos.length > 0 && (
        <div className={s.photoGrid} role="list" aria-label="Product pictures">
          {photos.map((p, i) => (
            <div key={p.key} role="listitem" className={`${s.photo}${i === 0 ? ` ${s.photoCover}` : ''}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url} alt={`Picture ${i + 1}${i === 0 ? ' (main)' : ''}`} />
              {i === 0 && <span className={s.coverTag}><Star size={11} fill="currentColor" /> Main</span>}
              {p.status === 'uploading' && <div className={s.photoBusy} role="status" aria-label="Uploading"><Loader2 size={24} className={s.spin} /></div>}
              {p.status === 'failed' && (
                <div className={s.photoFail} role="alert">
                  <AlertCircle size={18} /> Not uploaded
                  <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => onRetry(p.key)}><RotateCw size={14} /> Retry</button>
                </div>
              )}
              <button type="button" className={s.photoX} onClick={() => onRemove(p.key)} aria-label={`Remove picture ${i + 1}`}><X size={18} /></button>
              {i > 0 && p.status === 'ok' && <button type="button" className={s.photoMake} onClick={() => onMakeCover(p.key)}>Make main</button>}
            </div>
          ))}
        </div>
      )}

      <div className={s.addTiles}>
        <button type="button" className={s.addTile} onClick={() => cameraRef.current?.click()} disabled={room <= 0} style={invalid ? { borderColor: '#DC1F2E' } : undefined}>
          <Camera size={26} /> Take photo
        </button>
        <button type="button" className={s.addTile} onClick={() => galleryRef.current?.click()} disabled={room <= 0} style={invalid ? { borderColor: '#DC1F2E' } : undefined}>
          <ImagePlus size={26} /> Choose from gallery
        </button>
      </div>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className={s.srOnly} onChange={pick} tabIndex={-1} aria-hidden="true" />
      <input ref={galleryRef} type="file" accept="image/*" multiple className={s.srOnly} onChange={pick} tabIndex={-1} aria-hidden="true" />
      <div className={s.hint}>
        {room <= 0 ? `The most you can add is ${MAX_IMAGES} pictures.` : `${photos.length} of ${MAX_IMAGES} added. The first picture is the thumbnail everyone sees; make it a clear, well-lit front view.`}
      </div>
    </div>
  )
}
