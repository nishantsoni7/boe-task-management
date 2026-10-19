'use client'

// ── Payment proof: click, drag-and-drop, or paste a screenshot ───────────────
//
// ONE control for every form that takes a proof. It is controlled: the form owns
// `file` and `error` (so closing the "Add proof or notes" section never loses
// them, and the form's own submit logic is untouched). This component only
// answers "how did a file arrive?" — picker, drop, or Ctrl+V — and hands it to
// prepareProofFile, which names, converts and validates it.
//
// PASTE WORKS ANYWHERE IN THE DIALOG while this control is on screen, not only
// when it has focus: a person who has just taken a screenshot presses Ctrl+V.
// A paste that carries no file (ordinary text into the reference box) is left
// alone, untouched.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileText, ImagePlus, X } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { PROOF_ACCEPT_ATTR, filesFromTransfer, prepareProofFile } from '@/lib/finance/proofIntake'
import { useDragAndPaste } from '@/hooks/useDragAndPaste'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ProofDropZone({ file, error, onFile, onError, disabled = false, note }: {
  file: File | null
  error: string | null
  onFile: (file: File | null) => void
  onError: (message: string | null) => void
  disabled?: boolean
  /** One quiet line under the control (for example, what editing adds to). */
  note?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const take = useCallback(async (files: File[]) => {
    if (disabled || busy || files.length === 0) return
    setBusy(true)
    try {
      const result = await prepareProofFile(files[0])
      if (result.error !== null) { onFile(null); onError(result.error); return }
      onError(files.length > 1 ? 'Only one file can be attached; the first one was used.' : null)
      onFile(result.file)
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }, [busy, disabled, onError, onFile])

  const { dropActive, onDragOver, onDragEnter, onDragLeave, onDrop } = useDragAndPaste(files => { void take(files) })

  // Ctrl+V anywhere in the dialog.
  useEffect(() => {
    if (disabled) return
    const onDocPaste = (e: ClipboardEvent) => {
      const files = filesFromTransfer(e.clipboardData?.items)
      if (files.length === 0) return
      e.preventDefault()
      void take(files)
    }
    document.addEventListener('paste', onDocPaste)
    return () => document.removeEventListener('paste', onDocPaste)
  }, [disabled, take])

  // A thumbnail for an image; released when the file changes or the control goes.
  const previewUrl = useMemo(
    () => (file && file.type.startsWith('image/') ? URL.createObjectURL(file) : null),
    [file],
  )
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }, [previewUrl])

  const open = () => { if (!disabled && !busy) inputRef.current?.click() }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <input
        ref={inputRef}
        type="file"
        accept={PROOF_ACCEPT_ATTR}
        hidden
        tabIndex={-1}
        aria-label="Payment proof file"
        onChange={e => { void take(Array.from(e.target.files ?? [])) }}
      />

      {file ? (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px',
          borderRadius: '8px', border: `1px solid ${colors.border}`, background: colors.base,
        }}>
          {previewUrl
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={previewUrl} alt="" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6, flexShrink: 0, border: `1px solid ${colors.border}` }} />
            : <FileText size={28} aria-hidden="true" style={{ color: colors.secondary, flexShrink: 0 }} />}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {file.name}
            </div>
            <div style={{ fontSize: '12px', color: colors.muted }}>
              {formatSize(file.size)} · stored privately · optional
            </div>
          </div>
          <button type="button" onClick={open} disabled={disabled || busy}
            className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '12px', flexShrink: 0 }}>
            Replace
          </button>
          <button type="button" onClick={() => { onFile(null); onError(null) }} disabled={disabled || busy}
            aria-label="Remove the attached proof"
            className="boe-btn boe-btn-ghost" style={{ padding: '4px 8px', fontSize: '12px', flexShrink: 0 }}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ) : (
        <div
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
          aria-label="Attach payment proof: click to choose a file, drop one here, or paste a screenshot"
          onClick={open}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }}
          onDragOver={onDragOver}
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
            padding: '14px 12px', borderRadius: '8px', textAlign: 'center',
            border: `1.5px dashed ${dropActive ? colors.brand : colors.borderMed}`,
            background: dropActive ? colors.brandTint : colors.base,
            cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
          }}
        >
          <ImagePlus size={20} aria-hidden="true" style={{ color: dropActive ? colors.brandInk : colors.secondary }} />
          <div style={{ fontSize: '13px', fontWeight: 600, color: colors.primary }}>
            {busy ? 'Reading the file…' : dropActive ? 'Drop to attach' : 'Drop a screenshot or PDF here, click to choose, or press Ctrl+V to paste'}
          </div>
          <div style={{ fontSize: '12px', color: colors.muted }}>
            JPG, PNG, WEBP, GIF, other images, or PDF · up to 10 MB
          </div>
        </div>
      )}

      {error && <div role="alert" style={{ fontSize: '12px', color: colors.red, lineHeight: 1.4 }}>{error}</div>}
      {note && !error && <div style={{ fontSize: '12px', color: colors.muted, lineHeight: 1.4 }}>{note}</div>}
    </div>
  )
}
