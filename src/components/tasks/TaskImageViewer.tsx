'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from 'lucide-react'
import { colors, font } from '@/lib/tokens'
import { stepIndex, type GalleryEntry } from '@/lib/tasks/taskGallery'

// A large image viewer for a task's images. It stays open while the user moves
// between images — the single-file AttachmentPreviewModal closes and reopens
// per file, which is what made browsing eight photos tedious.
//
// URLs arrive already signed (the gallery signs with the caller's own session,
// see attachmentStorage.ts); this component never builds one.
//
// It is portalled to <body>. Rendered in place it would sit inside the Task
// Detail right column, which is position:sticky and therefore its own stacking
// context — so the sidebar and top header could paint over it however high its
// z-index. From <body> it covers the whole app, and everything else is made
// inert while it is open, so nothing behind it can be clicked or focused.

/** Horizontal travel, in CSS px, that counts as a swipe rather than a tap. */
const SWIPE_MIN_PX = 50

interface Props {
  images:     readonly GalleryEntry[]
  /** Signed URL per object path. A missing path renders as unavailable. */
  urls:       ReadonlyMap<string, string>
  startIndex: number
  onClose:    () => void
}

export function TaskImageViewer({ images, urls, startIndex, onClose }: Props) {
  const [index, setIndex] = useState(() => Math.min(Math.max(startIndex, 0), Math.max(images.length - 1, 0)))
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set())
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const closeRef   = useRef<HTMLButtonElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const touchStart = useRef<{ x: number; y: number } | null>(null)

  const count   = images.length
  const current = images[index]
  const url     = current ? urls.get(current.path) : undefined
  const many    = count > 1

  const go = useCallback((delta: number) => {
    setIndex(i => stepIndex(i, delta, count))
    setDownloadError(null)
  }, [count])

  // Keyboard: arrows move, Escape closes. Registered on window so it works
  // wherever focus sits inside the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape')          { e.preventDefault(); onClose() }
      else if (e.key === 'ArrowLeft')  { e.preventDefault(); go(-1) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, onClose])

  // While open: the rest of the app is inert (no clicks, no Tab focus, hidden
  // from assistive tech), the page does not scroll, and focus sits in the
  // viewer. On close all of that is undone — inert first, because focus cannot
  // return to an element that is still inert — and focus goes back to the
  // thumbnail that opened it.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const madeInert: HTMLElement[] = []
    for (const el of Array.from(document.body.children)) {
      if (el === overlayRef.current || !(el instanceof HTMLElement) || el.inert) continue
      el.inert = true
      madeInert.push(el)
    }
    const bodyOverflow = document.body.style.overflow
    const htmlOverflow = document.documentElement.style.overflow
    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'
    closeRef.current?.focus()
    return () => {
      for (const el of madeInert) el.inert = false
      document.body.style.overflow = bodyOverflow
      document.documentElement.style.overflow = htmlOverflow
      previous?.focus?.()
    }
  }, [])

  // Warm the neighbours so Next/Previous feels instant.
  useEffect(() => {
    if (!many) return
    for (const d of [-1, 1]) {
      const n = images[stepIndex(index, d, count)]
      const u = n && urls.get(n.path)
      if (u) { const img = new Image(); img.src = u }
    }
  }, [index, images, urls, count, many])

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0]
    touchStart.current = t ? { x: t.clientX, y: t.clientY } : null
  }
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchStart.current
    touchStart.current = null
    const t = e.changedTouches[0]
    if (!start || !t || !many) return
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    // Mostly-horizontal only, so a vertical scroll attempt is not a page turn.
    if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1)
  }

  const download = async () => {
    if (!current || !url || downloading) return
    setDownloading(true)
    setDownloadError(null)
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(String(res.status))
      const blob = await res.blob()
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = current.fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
    } catch {
      setDownloadError('Download failed. Try again.')
    } finally {
      setDownloading(false)
    }
  }

  if (!current) return null
  const unavailable = !url || failed.has(current.path)

  const navButton = (side: 'prev' | 'next') => (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); go(side === 'prev' ? -1 : 1) }}
      aria-label={side === 'prev' ? 'Previous image' : 'Next image'}
      className={`boe-image-viewer-nav boe-image-viewer-nav-${side}`}
    >
      {side === 'prev' ? <ChevronLeft size={26} aria-hidden /> : <ChevronRight size={26} aria-hidden />}
    </button>
  )

  const viewer = (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Image ${index + 1} of ${count}: ${current.fileName}`}
      className="boe-image-viewer"
      onClick={onClose}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* Header */}
      <div className="boe-image-viewer-bar" onClick={e => e.stopPropagation()}>
        <span className="boe-image-viewer-counter" aria-live="polite">
          Image {index + 1} of {count}
        </span>
        <span className="boe-image-viewer-name" title={current.fileName}>{current.fileName}</span>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
          <button
            type="button"
            onClick={download}
            disabled={unavailable || downloading}
            className="boe-image-viewer-download"
            title={`Download ${current.fileName}`}
          >
            <Download size={15} aria-hidden />
            {downloading ? 'Downloading…' : 'Download image'}
          </button>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="boe-image-viewer-action"
              aria-label="Open image in a new tab"
            >
              <ExternalLink size={14} aria-hidden />
              <span className="boe-image-viewer-action-text">Open in Tab</span>
            </a>
          )}
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="boe-image-viewer-action boe-image-viewer-close"
            aria-label="Close viewer"
          >
            <X size={18} aria-hidden />
          </button>
        </div>
      </div>

      {downloadError && (
        <p role="alert" className="boe-image-viewer-error" onClick={e => e.stopPropagation()}>{downloadError}</p>
      )}

      {/* Stage */}
      <div className="boe-image-viewer-stage">
        {many && navButton('prev')}
        {unavailable ? (
          <div
            onClick={e => e.stopPropagation()}
            style={{ color: '#E6E8EC', fontFamily: font.body, fontSize: '13px', textAlign: 'center', padding: '24px' }}
          >
            This image could not be loaded.
          </div>
        ) : (
          // next/image needs known dimensions and a remotePatterns entry for
          // the storage host; these are arbitrary user uploads shown
          // contain-fit, the same reason AttachmentPreviewModal uses <img>.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={current.path}
            src={url}
            alt={current.fileName}
            onClick={e => e.stopPropagation()}
            onError={() => setFailed(prev => new Set(prev).add(current.path))}
            className="boe-image-viewer-img"
            draggable={false}
          />
        )}
        {many && navButton('next')}
      </div>

      {many && (
        <p className="boe-image-viewer-hint" style={{ color: colors.muted }}>
          <span className="boe-image-viewer-hint-keys">← → to move · Esc to close</span>
          <span className="boe-image-viewer-hint-touch">Swipe to move</span>
        </p>
      )}
    </div>
  )

  // No document during a server render (and in the render tests); the viewer
  // only ever opens from a click, so in the browser it is always portalled.
  return typeof document === 'undefined' ? viewer : createPortal(viewer, document.body)
}
