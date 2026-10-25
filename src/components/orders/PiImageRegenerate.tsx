'use client'

// "Customize image" for one product line in Edit PI.
//
// Sales agree a change with the client (marble top, round instead of square, a
// longer table on two bases) and type it under Customization. This panel turns
// that into a picture: it starts from the customization text, lets the person
// add or reword the change, and Regenerate shows the result beside the
// current picture. Regenerate again from the new picture to refine it. Nothing
// reaches the PI until "Use this image" and the edit is saved; the standard
// picture can be brought back until then.

import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { RotateCcw, Sparkles } from 'lucide-react'
import {
  CUSTOMIZATION_CHIPS, MAX_INSTRUCTION_LENGTH, INSTRUCTION_MESSAGES,
  addChipToInstruction, instructionProblem, suggestInstruction,
} from '@/lib/orders/customizationImage'

export type RegeneratedPhoto = { storage_path: string; sha256: string; mime_type: string }

export const REGENERATE_NOTE =
  'AI-generated from the current picture. Check it before it goes to production; the written customization stays the source of truth.'

export function PiImageRegenerate({
  supabase, submissionId, itemId, sourcePath, customization, disabled, canRevert, onUse, onRevert,
}: {
  supabase: SupabaseClient
  submissionId: string
  itemId: string
  /** The picture the line shows now. Null when it has none (nothing to edit). */
  sourcePath: string | null
  customization: string
  disabled: boolean
  /** The line shows a replaced picture and the saved one can be restored. */
  canRevert: boolean
  onUse: (photo: RegeneratedPhoto, signedUrl: string | null) => void
  onRevert: () => void
}) {
  const [open, setOpen] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ photo: RegeneratedPhoto; url: string | null } | null>(null)

  if (!sourcePath) return null

  const openPanel = () => {
    if (!open && instruction === '') setInstruction(suggestInstruction(customization))
    setOpen(o => !o)
  }

  const regenerate = async () => {
    const problem = instructionProblem(instruction)
    if (problem) { setError(INSTRUCTION_MESSAGES[problem]); return }
    setWorking(true); setError(null)
    try {
      // Refine from the preview when there is one, otherwise from the line's picture.
      const res = await fetch('/api/orders/pi-edits/regenerate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submissionId, itemId, sourcePath: preview?.photo.storage_path ?? sourcePath, instruction }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setError(body.message ?? 'The picture could not be regenerated. Please try again.'); return }
      const photo: RegeneratedPhoto = { storage_path: body.storage_path, sha256: body.sha256, mime_type: body.mime_type }
      const { data } = await supabase.storage.from('order-files').createSignedUrl(photo.storage_path, 600)
      setPreview({ photo, url: data?.signedUrl ?? null })
    } catch {
      setError('The picture could not be regenerated. Check your connection and try again.')
    } finally { setWorking(false) }
  }

  return (
    <div className="pi-regen">
      <button type="button" className="boe-btn boe-btn-ghost pi-edit-photo-btn" disabled={disabled}
        aria-expanded={open} onClick={openPanel}>
        <Sparkles size={12} aria-hidden="true" /> Customize image
      </button>
      {canRevert && (
        <button type="button" className="boe-btn boe-btn-ghost pi-edit-photo-btn" disabled={disabled} onClick={onRevert}>
          <RotateCcw size={12} aria-hidden="true" /> Back to standard picture
        </button>
      )}
      {open && (
        <div className="pi-regen-panel" role="group" aria-label="Customize image">
          <label className="pi-edit-field"><span>What should change in the picture?</span>
            <textarea rows={3} value={instruction} maxLength={MAX_INSTRUCTION_LENGTH} className="boe-input"
              placeholder="e.g. marble top instead of wood, round instead of square"
              onChange={e => setInstruction(e.target.value)} /></label>
          <div className="pi-regen-chips">
            {CUSTOMIZATION_CHIPS.map(c => (
              <button key={c.label} type="button" className="pi-regen-chip"
                onClick={() => setInstruction(i => addChipToInstruction(i, c.text))}>{c.label}</button>
            ))}
          </div>
          <div className="pi-regen-actions">
            <button type="button" className="boe-btn boe-btn-primary" disabled={working || disabled} onClick={() => void regenerate()}>
              {working ? 'Regenerating…' : preview ? 'Regenerate again from this' : 'Regenerate'}
            </button>
            {preview && !working && (
              <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setPreview(null)}>Discard</button>
            )}
          </div>
          {error && <p role="alert" className="pi-regen-error">{error}</p>}
          {preview && (
            <div className="pi-regen-result">
              <div className="pi-edit-photo-frame">
                {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL from a private bucket */}
                {preview.url ? <img src={preview.url} alt="Regenerated product picture" /> : <span>Preview unavailable</span>}
              </div>
              <button type="button" className="boe-btn boe-btn-primary" disabled={disabled}
                onClick={() => { onUse(preview.photo, preview.url); setPreview(null); setOpen(false) }}>
                Use this image
              </button>
            </div>
          )}
          <p className="pi-regen-note">{REGENERATE_NOTE}</p>
        </div>
      )}
    </div>
  )
}
