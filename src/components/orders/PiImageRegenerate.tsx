'use client'

// "Customize image" for one product line in Edit PI.
//
// Sales agree a change with the client (marble top, round instead of square, a
// longer table on two bases sharing one floor plate) and type it under
// Customization. This panel turns that into a picture in two steps:
//
//   1. Check understanding — the words (and up to two reference pictures) are
//      rewritten as exact physical instructions, shown as "Understood as",
//      editable, with anything that was guessed listed to check.
//   2. Regenerate picture — the image is made from that checked instruction.
//
// "Change this picture further" starts again from the new picture. Nothing
// reaches the PI until "Use this image" and the edit is saved; the standard
// picture can be brought back until then.

import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ImagePlus, RotateCcw, Sparkles, X } from 'lucide-react'
import {
  CUSTOMIZATION_CHIPS, MAX_INSTRUCTION_LENGTH, MAX_REFERENCES, MAX_REFERENCE_BYTES, REFERENCE_MAX_SIDE,
  INSTRUCTION_MESSAGES, addChipToInstruction, instructionProblem, suggestInstruction,
} from '@/lib/orders/customizationImage'
import { MAX_FEEDBACK_NOTE } from '@/lib/orders/customizationLearning'

export type RegeneratedPhoto = { storage_path: string; sha256: string; mime_type: string }

export const REGENERATE_NOTE =
  'AI-generated from the current picture. Check it before it goes to production; the written customization stays the source of truth.'

/** Shrinks a chosen picture in the browser to a JPEG data URL small enough to send. */
async function shrinkToDataUrl(file: File): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, REFERENCE_MAX_SIDE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const url = canvas.toDataURL('image/jpeg', 0.85)
    return (url.length * 3) / 4 > MAX_REFERENCE_BYTES ? null : url
  } catch {
    return null
  }
}

export function PiImageRegenerate({
  supabase, submissionId, itemId, sourcePath, customization, productName, dimensions, material,
  disabled, canRevert, onUse, onRevert,
}: {
  supabase: SupabaseClient
  submissionId: string
  itemId: string
  /** The picture the line shows now. Null when it has none (nothing to edit). */
  sourcePath: string | null
  customization: string
  productName: string
  dimensions: string
  material: string
  disabled: boolean
  /** The line shows a replaced picture and the saved one can be restored. */
  canRevert: boolean
  onUse: (photo: RegeneratedPhoto, signedUrl: string | null) => void
  onRevert: () => void
}) {
  const [open, setOpen] = useState(false)
  const [comment, setComment] = useState('')
  const [references, setReferences] = useState<string[]>([])
  const [understood, setUnderstood] = useState<{
    instruction: string
    assumptions: string[]
    /** The recorded attempt (Learning, 20270420000000); null when learning is not set up. */
    attemptId: string | null
    applied: { rules: number; examples: number }
  } | null>(null)
  /** The salesperson's verdict on the current preview. */
  const [verdict, setVerdict] = useState<null | 'correct' | 'wrong' | 'wrong-sent'>(null)
  const [wrongNote, setWrongNote] = useState('')
  const [working, setWorking] = useState<null | 'understand' | 'regenerate'>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ photo: RegeneratedPhoto; url: string | null } | null>(null)
  /** Set by "Change this picture further": the next change starts from the preview. */
  const [refineFrom, setRefineFrom] = useState<{ photo: RegeneratedPhoto; url: string | null } | null>(null)

  if (!sourcePath) return null
  const startFrom = refineFrom?.photo.storage_path ?? sourcePath

  const openPanel = () => {
    if (!open && comment === '' && !refineFrom) setComment(suggestInstruction(customization))
    setOpen(o => !o)
  }
  // The request changed, so the old understanding no longer describes it.
  const changeComment = (next: string) => { setComment(next); setUnderstood(null) }

  const post = async (url: string, payload: Record<string, unknown>) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    const body = await res.json().catch(() => ({}))
    return { ok: res.ok, body }
  }

  /** Tells the Learning page what happened. Fire and forget: it never blocks the panel. */
  const report = (event: 'used' | 'discarded' | 'refined' | 'correct' | 'wrong', note = '') => {
    const attemptId = understood?.attemptId
    if (!attemptId) return
    void post('/api/orders/pi-edits/customization-feedback', { attemptId, event, note }).catch(() => undefined)
  }

  const understand = async () => {
    const problem = instructionProblem(comment)
    if (problem) { setError(INSTRUCTION_MESSAGES[problem]); return }
    setWorking('understand'); setError(null)
    try {
      const { ok, body } = await post('/api/orders/pi-edits/interpret-customization', {
        submissionId, itemId, sourcePath: startFrom, comment, productName, dimensions, material, references,
      })
      if (!ok) { setError(body.message ?? 'The customization could not be worked out. Please try again.'); return }
      setUnderstood({
        instruction: body.instruction,
        assumptions: Array.isArray(body.assumptions) ? body.assumptions : [],
        attemptId: typeof body.attemptId === 'string' ? body.attemptId : null,
        applied: { rules: Number(body.applied?.rules) || 0, examples: Number(body.applied?.examples) || 0 },
      })
    } catch {
      setError('The customization could not be checked. Check your connection and try again.')
    } finally { setWorking(null) }
  }

  const regenerate = async () => {
    if (!understood) return
    const problem = instructionProblem(understood.instruction)
    if (problem) { setError(INSTRUCTION_MESSAGES[problem]); return }
    setWorking('regenerate'); setError(null)
    try {
      const { ok, body } = await post('/api/orders/pi-edits/regenerate-image', {
        submissionId, itemId, sourcePath: startFrom, instruction: understood.instruction, references,
        attemptId: understood.attemptId,
      })
      if (!ok) { setError(body.message ?? 'The picture could not be regenerated. Please try again.'); return }
      const photo: RegeneratedPhoto = { storage_path: body.storage_path, sha256: body.sha256, mime_type: body.mime_type }
      const { data } = await supabase.storage.from('order-files').createSignedUrl(photo.storage_path, 600)
      setPreview({ photo, url: data?.signedUrl ?? null })
      setVerdict(null); setWrongNote('')
    } catch {
      setError('The picture could not be regenerated. Check your connection and try again.')
    } finally { setWorking(null) }
  }

  const addReference = async (file: File | undefined) => {
    if (!file || references.length >= MAX_REFERENCES) return
    const url = await shrinkToDataUrl(file)
    if (!url) { setError('That picture could not be used. Try a JPEG or PNG photo.'); return }
    setReferences(r => [...r, url]); setUnderstood(null); setError(null)
  }

  const refineFurther = () => {
    if (!preview) return
    report('refined')
    setRefineFrom(preview); setPreview(null)
    setComment(''); setUnderstood(null); setReferences([])
  }

  const busy = working !== null || disabled

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
          {refineFrom && (
            <div className="pi-regen-from">
              <div className="pi-edit-photo-frame">
                {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL from a private bucket */}
                {refineFrom.url ? <img src={refineFrom.url} alt="Picture being changed further" /> : <span>Picture</span>}
              </div>
              <p className="pi-regen-note">Changing this picture further. Say only what should change now.{' '}
                <button type="button" className="pi-regen-link" onClick={() => { setRefineFrom(null); setUnderstood(null) }}>Start from the product picture instead</button>
              </p>
            </div>
          )}

          <label className="pi-edit-field"><span>What does the client want changed?</span>
            <textarea rows={3} value={comment} maxLength={MAX_INSTRUCTION_LENGTH} className="boe-input"
              placeholder="e.g. longer rectangular table, 2 pedestal base, bottom plate combined"
              onChange={e => changeComment(e.target.value)} /></label>
          <div className="pi-regen-chips">
            {CUSTOMIZATION_CHIPS.map(c => (
              <button key={c.label} type="button" className="pi-regen-chip"
                onClick={() => changeComment(addChipToInstruction(comment, c.text))}>{c.label}</button>
            ))}
          </div>

          <div className="pi-regen-refs">
            {references.map((r, i) => (
              <div key={i} className="pi-regen-ref">
                {/* eslint-disable-next-line @next/next/no-img-element -- a local data URL chosen by the person */}
                <img src={r} alt={`Reference picture ${i + 1}`} />
                <button type="button" aria-label={`Remove reference picture ${i + 1}`}
                  onClick={() => { setReferences(rs => rs.filter((_, j) => j !== i)); setUnderstood(null) }}><X size={12} aria-hidden="true" /></button>
              </div>
            ))}
            {references.length < MAX_REFERENCES && (
              <label className="boe-btn boe-btn-ghost pi-edit-photo-btn">
                <ImagePlus size={12} aria-hidden="true" /> Add reference picture
                <input type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={busy}
                  onChange={e => { void addReference(e.target.files?.[0]); e.target.value = '' }} />
              </label>
            )}
            <span className="pi-regen-note">Optional: a catalogue photo or a phone sketch of the wanted detail.</span>
          </div>

          <div className="pi-regen-actions">
            <button type="button" className={understood ? 'boe-btn boe-btn-ghost' : 'boe-btn boe-btn-primary'} disabled={busy} onClick={() => void understand()}>
              {working === 'understand' ? 'Checking…' : understood ? 'Check again' : 'Check understanding'}
            </button>
          </div>

          {understood && (
            <div className="pi-regen-understood">
              <label className="pi-edit-field"><span>Understood as (edit if anything is wrong)</span>
                <textarea rows={5} value={understood.instruction} maxLength={MAX_INSTRUCTION_LENGTH} className="boe-input"
                  onChange={e => setUnderstood(u => (u ? { ...u, instruction: e.target.value } : u))} /></label>
              {understood.assumptions.length > 0 && (
                <div className="pi-regen-assumptions">
                  <span>Please check these guesses:</span>
                  <ul>{understood.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
                </div>
              )}
              {(understood.applied.rules > 0 || understood.applied.examples > 0) && (
                <p className="pi-regen-note">Used {understood.applied.rules} company rule{understood.applied.rules === 1 ? '' : 's'}
                  {understood.applied.examples > 0 ? ` and ${understood.applied.examples} similar approved example${understood.applied.examples === 1 ? '' : 's'}` : ''}.</p>
              )}
              <div className="pi-regen-actions">
                <button type="button" className="boe-btn boe-btn-primary" disabled={busy} onClick={() => void regenerate()}>
                  {working === 'regenerate' ? 'Regenerating… (up to a minute)' : preview ? 'Regenerate again' : 'Regenerate picture'}
                </button>
              </div>
            </div>
          )}

          {error && <p role="alert" className="pi-regen-error">{error}</p>}

          {preview && (
            <div className="pi-regen-result">
              <div className="pi-edit-photo-frame">
                {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL from a private bucket */}
                {preview.url ? <img src={preview.url} alt="Regenerated product picture" /> : <span>Preview unavailable</span>}
              </div>
              <div className="pi-regen-actions">
                <button type="button" className="boe-btn boe-btn-primary" disabled={busy}
                  onClick={() => { report('used'); onUse(preview.photo, preview.url); setPreview(null); setRefineFrom(null); setOpen(false) }}>
                  Use this image
                </button>
                <button type="button" className="boe-btn boe-btn-ghost" disabled={busy} onClick={refineFurther}>Change this picture further</button>
                <button type="button" className="boe-btn boe-btn-ghost" disabled={busy} onClick={() => { report('discarded'); setPreview(null) }}>Discard</button>
              </div>
              {understood?.attemptId && (
                <div className="pi-regen-verdict" role="group" aria-label="Was this picture right?">
                  {verdict === null && (
                    <>
                      <span>Was this picture right?</span>
                      <button type="button" className="pi-regen-chip" onClick={() => { setVerdict('correct'); report('correct') }}>👍 Correct</button>
                      <button type="button" className="pi-regen-chip" onClick={() => setVerdict('wrong')}>👎 Wrong</button>
                    </>
                  )}
                  {verdict === 'wrong' && (
                    <div className="pi-regen-wrong">
                      <label className="pi-edit-field"><span>What was wrong? (this teaches it)</span>
                        <textarea rows={2} value={wrongNote} maxLength={MAX_FEEDBACK_NOTE} className="boe-input"
                          placeholder="e.g. the two pedestals still have separate floor plates"
                          onChange={e => setWrongNote(e.target.value)} /></label>
                      <div className="pi-regen-actions">
                        <button type="button" className="boe-btn boe-btn-primary" onClick={() => { report('wrong', wrongNote); setVerdict('wrong-sent') }}>Send</button>
                        <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setVerdict(null)}>Cancel</button>
                      </div>
                    </div>
                  )}
                  {(verdict === 'correct' || verdict === 'wrong-sent') && <span>Thanks, noted for the admin’s review.</span>}
                </div>
              )}
            </div>
          )}
          <p className="pi-regen-note">{REGENERATE_NOTE}</p>
        </div>
      )}
    </div>
  )
}
