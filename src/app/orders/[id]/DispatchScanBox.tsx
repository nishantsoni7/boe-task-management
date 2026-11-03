'use client'

// SCAN FIRST (owner, 2026-11-03): one box per paper on the Record dispatch screen. Upload the invoice, or the
// e-way bill, and the details below it fill in; the fields stay open for typing, or for a correction. The box only
// draws what it is given and reports what the person did: the screen owns the upload and the reading.

import type { ChangeEvent, DragEvent } from 'react'
import { Camera, CircleCheck, LoaderCircle, ScanText, TriangleAlert, Upload } from 'lucide-react'
import { DISPATCH_PAPER_ACCEPT } from '@/lib/orders/dispatchPaperReading'

export type ScanPaperState = 'uploading' | 'reading' | 'read' | 'unclear' | 'failed'

export type ScanPaperView = {
  key: string
  fileName: string
  state: ScanPaperState
  /** The small line under the file name: what was read, what is wrong, or what is happening. */
  line: string
  /** The paper showing in the preview beside the details. */
  selected: boolean
}

const BUSY: readonly ScanPaperState[] = ['uploading', 'reading']

export function DispatchScanBox({ noun, optional = false, papers, disabled, onFiles, onOpen, onRemove }: {
  /** "invoice", "e-way bill", "LR / bilty": said in the box's own words. */
  noun: string
  /** The LR / bilty: a quiet line, not a box. */
  optional?: boolean
  papers: ScanPaperView[]
  disabled: boolean
  onFiles: (files: File[]) => void
  onOpen: (key: string) => void
  onRemove: (key: string) => void
}) {
  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    if (files.length > 0) onFiles(files)
  }
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (disabled) return
    const files = [...event.dataTransfer.files]
    if (files.length > 0) onFiles(files)
  }
  const chooser = (
    <input className="odr-file" type="file" accept={DISPATCH_PAPER_ACCEPT} multiple disabled={disabled} onChange={pick} aria-label={`Choose the ${noun}`} />
  )

  if (papers.length === 0) {
    if (optional) {
      return (
        <p className="odr-optional">
          Have a transporter&apos;s {noun}?{' '}
          <label className="odr-optional-link">{chooser}Scan it too</label>{' '}
          (optional)
        </p>
      )
    }
    return (
      <div className="odr-scan" onDragOver={event => event.preventDefault()} onDrop={drop}>
        <span className="odr-scan-icon"><ScanText aria-hidden="true" /></span>
        <span className="odr-scan-text">
          <b>Scan the {noun}</b>
          <small>Upload the PDF or a photo and the details below fill in for you.</small>
        </span>
        <label className="boe-btn boe-btn-primary odr-scan-camera">
          <input className="odr-file" type="file" accept="image/*" capture="environment" disabled={disabled} onChange={pick} aria-label={`Take a photo of the ${noun}`} />
          <Camera aria-hidden="true" />Take photo
        </label>
        <label className="boe-btn boe-btn-primary">
          {chooser}
          <Upload aria-hidden="true" />Choose file
        </label>
      </div>
    )
  }

  return (
    <div className="odr-scan-list">
      {papers.map(p => {
        const tone = p.state === 'read' ? 'done' : BUSY.includes(p.state) ? 'busy' : 'problem'
        const Icon = tone === 'done' ? CircleCheck : tone === 'busy' ? LoaderCircle : TriangleAlert
        return (
          <div key={p.key} className={`odr-scan odr-scan--${tone}${p.selected ? ' is-on' : ''}`}>
            <span className="odr-scan-icon"><Icon aria-hidden="true" /></span>
            <button type="button" className="odr-scan-text odr-scan-open" aria-pressed={p.selected} onClick={() => onOpen(p.key)}>
              <b>{p.fileName}</b>
              <small>{p.line}</small>
            </button>
            <button
              type="button" className="boe-btn boe-btn-secondary" aria-label={`Remove ${p.fileName}`}
              disabled={disabled || BUSY.includes(p.state)} onClick={() => onRemove(p.key)}
            >
              Remove
            </button>
          </div>
        )
      })}
      <label className="odr-optional-link odr-scan-more">{chooser}Add another {noun} paper</label>
    </div>
  )
}
