'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Camera, ImagePlus, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { VendorInput } from '@/lib/vendors/api'
import { VENDOR_SCAN_FIELD_LABEL, applyVendorScan } from '@/lib/vendors/scan'
import { ScanError, scanVendorPhoto, shrinkPhoto } from '@/lib/vendors/scanClient'
import s from './vendors.module.css'

// "Scan card or name plate": photograph the vendor's visiting card or the board outside the workshop and the form
// fills itself. Only EMPTY fields are filled, and the person checks the form before saving. The photograph is read
// once and thrown away.

export default function ScanVendorButton({ value, onChange }: {
  value: VendorInput
  onChange: (patch: Partial<VendorInput>) => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const cameraRef = useRef<HTMLInputElement>(null)
  const galleryRef = useRef<HTMLInputElement>(null)
  const latest = useRef(value)
  useEffect(() => { latest.current = value }, [value])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  async function start(file: File) {
    setBusy(true)
    setNote(null)
    try {
      const photo = await shrinkPhoto(file)
      const result = await scanVendorPhoto(supabase, photo)
      const { patch, filled } = applyVendorScan(latest.current, result)
      if (filled.length === 0) {
        setNote({ tone: 'ok', text: 'The photo was read, but every field it could fill already has something in it.' })
      } else {
        onChange(patch)
        setNote({ tone: 'ok', text: `Filled ${filled.map(f => VENDOR_SCAN_FIELD_LABEL[f]).join(', ')}. Please check them before saving.` })
      }
    } catch (e) {
      setNote({ tone: 'err', text: e instanceof ScanError ? e.message : 'Could not read the photo. Type the details instead.' })
    } finally {
      setBusy(false)
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

  return (
    <div className={s.scanRow}>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onFile} tabIndex={-1} />
      <input ref={galleryRef} type="file" accept="image/*" hidden onChange={onFile} tabIndex={-1} />
      <div className={s.scanButtons}>
        <button type="button" className={s.secondary} disabled={busy} onClick={() => pick('camera')}>
          {busy ? <Loader2 size={15} className={s.spin} aria-hidden="true" /> : <Camera size={15} aria-hidden="true" />}
          {busy ? 'Reading…' : 'Scan card or name plate'}
        </button>
        <button type="button" className={s.linkBtn} disabled={busy} onClick={() => pick('gallery')}>
          <ImagePlus size={14} aria-hidden="true" /> Upload a photo
        </button>
      </div>
      <div className={s.hint}>Photograph the visiting card or the board outside the workshop: the details fill in below.</div>
      {note && (
        <div className={`${s.banner} ${note.tone === 'err' ? s.bannerErr : s.bannerWarn}`} role={note.tone === 'err' ? 'alert' : 'status'}>
          {note.text}
        </div>
      )}
    </div>
  )
}
