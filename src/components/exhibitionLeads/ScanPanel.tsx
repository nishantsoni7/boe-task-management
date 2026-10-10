'use client'

import { useEffect, useRef, useState } from 'react'
import { Camera, CircleAlert, ClipboardList, Contact, ImagePlus, RotateCcw, ScanLine, Sparkles, X } from 'lucide-react'
import type { createClient } from '@/lib/supabase/client'
import { SCAN_KIND_SHORT, type ScanKind, type ScanResult } from '@/lib/exhibitionLeads/scan'
import { ScanError, scanPhoto, shrinkPhoto } from '@/lib/exhibitionLeads/scanClient'
import a from './scan.module.css'

// "Scan to fill" — one scanner for both: point it at a visiting card or a visitor
// form (it works out which). The photograph is read, the form below fills itself,
// and the salesperson fills the rest and judges the lead (Hot / Warm / …).
//
// The panel owns the photo and the reading; the screen decides what goes where
// (onResult) and says what it filled, so this component never touches the form.
// It is remounted (key) after every saved lead, so the next visitor starts clean.

type Supabase = ReturnType<typeof createClient>

type Phase =
  | { name: 'idle' }
  | { name: 'reading'; photo: string }
  | { name: 'done'; kind: ScanKind; photo: string; filled: number; unusablePhone: boolean; kept?: boolean }
  | { name: 'error'; photo: string | null; message: string; code: ScanError['code'] }


export function ScanPanel({ supabase, disabled, keptPhoto, onResult, onClear }: {
  supabase: Supabase
  disabled?: boolean
  /** An entry put back into the form for editing brings its photograph along. */
  keptPhoto?: Blob
  /** The reading is ready: fill the form, and say how many fields that filled. The photo is kept with the lead. */
  onResult: (r: ScanResult, photo: Blob) => { filled: number; unusablePhone: boolean }
  /** The person removed the scan: take the "read from photo" markers off. */
  onClear: () => void
}) {
  // A photograph that came back with an entry being edited starts the panel in its "kept" state.
  const [phase, setPhase] = useState<Phase>(() => keptPhoto
    ? { name: 'done', kind: 'visiting_card', photo: URL.createObjectURL(keptPhoto), filled: 0, unusablePhone: false, kept: true }
    : { name: 'idle' })
  const [big, setBig] = useState(false)
  const cameraRef = useRef<HTMLInputElement>(null)
  const galleryRef = useRef<HTMLInputElement>(null)
  const photoUrl = useRef<string | null>(null)
  // A newer scan makes an older one's answer irrelevant.
  const run = useRef(0)

  useEffect(() => () => { if (photoUrl.current) URL.revokeObjectURL(photoUrl.current) }, [])

  // …whose address is released with the panel, like any other.
  useEffect(() => { if (keptPhoto && phase.name === 'done') photoUrl.current = phase.photo }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const swapPhoto = (blob: Blob | null): string | null => {
    if (photoUrl.current) URL.revokeObjectURL(photoUrl.current)
    photoUrl.current = blob ? URL.createObjectURL(blob) : null
    return photoUrl.current
  }

  async function start(file: File) {
    const mine = ++run.current
    setBig(false)
    let shrunk: Blob
    try {
      shrunk = await shrinkPhoto(file)
    } catch (e) {
      if (mine !== run.current) return
      swapPhoto(null)
      const se = e as ScanError
      setPhase({ name: 'error', photo: null, message: se.message, code: se.code ?? 'failed' })
      return
    }
    const photo = swapPhoto(shrunk) as string
    if (mine !== run.current) return
    setPhase({ name: 'reading', photo })
    try {
      const result = await scanPhoto(supabase, shrunk)
      if (mine !== run.current) return
      const { filled, unusablePhone } = onResult(result, shrunk)
      setPhase({ name: 'done', kind: result.kind, photo, filled, unusablePhone })
    } catch (e) {
      if (mine !== run.current) return
      const se = e as ScanError
      setPhase({ name: 'error', photo, message: se.message ?? 'Could not read the photo.', code: se.code ?? 'failed' })
    }
  }

  function pick(source: 'camera' | 'gallery') {
    const input = source === 'camera' ? cameraRef.current : galleryRef.current
    if (input) { input.value = ''; input.click() }
  }

  function onFile(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0]
    if (file) void start(file)
  }

  function clear() {
    run.current++
    swapPhoto(null)
    setPhase({ name: 'idle' })
    onClear()
  }

  const busy = phase.name === 'reading'

  return (
    <section className={a.scan} aria-label="Scan to fill">
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onFile} tabIndex={-1} />
      <input ref={galleryRef} type="file" accept="image/*" hidden onChange={onFile} tabIndex={-1} />

      {phase.name === 'idle' && (
        <>
          <div className={a.scanHead}>
            <span className={a.scanSpark} aria-hidden="true"><Sparkles size={15} strokeWidth={2.2} /></span>
            <div>
              <div className={a.scanTitle}>Scan to fill</div>
              <div className={a.scanSub}>Photograph it — the details fill in, you just judge the lead.</div>
            </div>
          </div>
          <div className={a.scanOne}>
            <button
              type="button" className={a.scanBig} disabled={disabled}
              onClick={() => pick('camera')} aria-label="Scan a visiting card or visitor form with the camera"
            >
              <span className={a.scanIcon} aria-hidden="true"><Camera size={24} strokeWidth={1.9} /></span>
              <span className={a.scanBigText}>
                <span className={a.scanName}>Scan visiting card or visitor form</span>
                <span className={a.scanFor}>Point the camera at either — it works out which</span>
              </span>
              <span className={a.scanKinds} aria-hidden="true"><Contact size={16} strokeWidth={1.9} /><ClipboardList size={16} strokeWidth={1.9} /></span>
            </button>
            <button
              type="button" className={a.scanAlt} disabled={disabled}
              onClick={() => pick('gallery')} aria-label="Upload a photo of a visiting card or visitor form"
            >
              <ImagePlus size={14} strokeWidth={2} aria-hidden="true" /> Or upload a photo from the gallery
            </button>
          </div>
        </>
      )}

      {phase.name === 'reading' && (
        <div className={a.scanRow} role="status" aria-live="polite">
          <div className={`${a.thumb} ${a.thumbScanning}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={phase.photo} alt="" />
            <span className={a.scanLine} aria-hidden="true" />
          </div>
          <div className={a.scanText}>
            <div className={a.scanState}>Reading the photo…</div>
            <div className={a.scanSub}>A few seconds. You can already start on the Lead type below.</div>
          </div>
        </div>
      )}

      {phase.name === 'done' && (
        <div>
          <div className={a.scanRow}>
            <button
              type="button" className={a.thumb} onClick={() => setBig(b => !b)}
              aria-expanded={big} aria-label={big ? 'Shrink the photo' : 'Enlarge the photo to compare'}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={phase.photo} alt="The photo that was scanned" />
            </button>
            <div className={a.scanText} role="status" aria-live="polite">
              <div className={`${a.scanState} ${a.scanOk}`}>
                <ScanLine size={16} strokeWidth={2.2} aria-hidden="true" style={{ verticalAlign: '-3px', marginRight: 6 }} />
                {phase.kept
                  ? 'Photo kept with this lead'
                  : phase.filled > 0
                  ? `Filled ${phase.filled} ${phase.filled === 1 ? 'field' : 'fields'} from the ${SCAN_KIND_SHORT[phase.kind]}`
                  : 'Read the photo — nothing new to fill'}
              </div>
              <div className={a.scanSub}>
                {phase.kept
                  ? 'It is attached when you save.'
                  : phase.unusablePhone
                  ? 'The number on it could not be read as a mobile — please type it.'
                  : 'Check the marked fields, then choose the Lead type.'}
              </div>
            </div>
            <div className={a.scanActions}>
              <button type="button" className={a.iconBtn} onClick={() => pick('camera')} aria-label="Scan again" title="Scan again">
                <RotateCcw size={17} strokeWidth={2} aria-hidden="true" />
              </button>
              <button type="button" className={a.iconBtn} onClick={clear} aria-label="Remove the scan" title="Remove the scan">
                <X size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          </div>
          {big && (
            <div className={a.bigPhoto}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={phase.photo} alt="The photo that was scanned, enlarged" />
            </div>
          )}
        </div>
      )}

      {phase.name === 'error' && (
        <div className={a.scanErr} role="alert">
          <CircleAlert size={18} strokeWidth={2.1} aria-hidden="true" style={{ flex: 'none', marginTop: 1 }} />
          <div className={a.scanText}>
            <div>{phase.message}</div>
            <div className={a.scanErrActions}>
              {phase.code !== 'not_configured' && phase.code !== 'auth' && (
                <button type="button" className={a.linkBtn} onClick={() => pick('camera')} disabled={busy}>Try again</button>
              )}
              <button type="button" className={a.linkBtn} onClick={clear}>Type it instead</button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
