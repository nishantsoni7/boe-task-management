'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Download, ImageOff, Paperclip } from 'lucide-react'
import { colors, font } from '@/lib/tokens'
import { mapWithConcurrency } from '@/lib/attachment-utils'
import { signAttachmentUrls, SIGNED_URL_TTL_SECONDS } from '@/lib/tasks/attachmentStorage'
import {
  buildZip, galleryCountLabel, signatureIsStale, uniqueZipNames, zipFileNameForTask,
  type GalleryEntry,
} from '@/lib/tasks/taskGallery'
import { TaskImageViewer } from './TaskImageViewer'

// The task's own attachments as a card of their own: images as a thumbnail
// grid, everything else as the same file links as before.
//
// Access is exactly the old per-file preview's: every URL is a short-lived
// signed URL minted with the VIEWER'S session (signAttachmentUrls), so the
// storage policy decides what they may see. Nothing is proxied, nothing new is
// stored, and no path is ever turned into a permanent link.

/** Re-sign before the TTL runs out, so a viewer opened after a long read still loads. */
const RESIGN_AFTER_MS = (SIGNED_URL_TTL_SECONDS - 60) * 1000
/** Parallel fetches while building the ZIP — matches the upload window. */
const ZIP_FETCH_CONCURRENCY = 3

type ZipState =
  | { status: 'idle' }
  | { status: 'busy'; done: number; total: number }
  | { status: 'error'; message: string }

interface Props {
  entries:    readonly GalleryEntry[]
  taskTitle:  string
  supabase:   SupabaseClient
  /** Opens a non-image file in the existing AttachmentPreviewModal. */
  onOpenFile: (path: string, fileName: string) => void
}

export function TaskAttachmentGallery({ entries, taskTitle, supabase, onOpenFile }: Props) {
  const images = useMemo(() => entries.filter(e => e.isImage), [entries])
  const files  = useMemo(() => entries.filter(e => !e.isImage), [entries])

  const [urls, setUrls]           = useState<ReadonlyMap<string, string>>(() => new Map())
  const [signed, setSigned]       = useState(false)
  const [broken, setBroken]       = useState<ReadonlySet<string>>(() => new Set())
  const [viewerAt, setViewerAt]   = useState<number | null>(null)
  const [zip, setZip]             = useState<ZipState>({ status: 'idle' })
  const signedAt = useRef(0)

  const imagePathsKey = images.map(i => i.path).join('\n')

  const sign = useCallback(async () => {
    const map = await signAttachmentUrls(supabase, images.map(i => i.path))
    signedAt.current = Date.now()
    return map
  }, [supabase, images])

  // One batched signing round trip for every thumbnail.
  useEffect(() => {
    if (images.length === 0) return
    let active = true
    sign()
      .then(map => { if (active) { setUrls(map); setSigned(true) } })
      .catch(() => { if (active) setSigned(true) })
    return () => { active = false }
    // imagePathsKey, not `images`: a re-render with the same paths must not re-sign.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imagePathsKey, supabase])

  const openViewer = async (i: number) => {
    if (signatureIsStale(signedAt.current, RESIGN_AFTER_MS)) {
      try { setUrls(await sign()) } catch { /* keep the old map; the viewer shows unavailable */ }
    }
    setViewerAt(i)
  }

  const downloadAll = async () => {
    if (zip.status === 'busy' || images.length === 0) return
    // One entry per object: the same image cannot appear twice in the archive.
    const seen = new Set<string>()
    const wanted = images.filter(i => (seen.has(i.path) ? false : (seen.add(i.path), true)))
    setZip({ status: 'busy', done: 0, total: wanted.length })
    try {
      // Always freshly signed: the thumbnails' URLs may be close to expiry.
      const fresh = await sign()
      setUrls(fresh)
      let done = 0
      const results = await mapWithConcurrency(wanted, ZIP_FETCH_CONCURRENCY, async (img) => {
        const url = fresh.get(img.path)
        if (!url) return null
        try {
          const res = await fetch(url)
          if (!res.ok) return null
          const bytes = new Uint8Array(await res.arrayBuffer())
          done += 1
          setZip({ status: 'busy', done, total: wanted.length })
          return bytes
        } catch {
          return null
        }
      })
      const missing = results.filter(r => r === null).length
      if (missing > 0) {
        // No partial archive: a ZIP silently short of photos is worse than none.
        setZip({
          status: 'error',
          message: `${missing} of ${wanted.length} ${wanted.length === 1 ? 'image' : 'images'} could not be downloaded, so no ZIP was created. Check your connection and try again.`,
        })
        return
      }
      const names = uniqueZipNames(wanted.map(w => w.fileName))
      const archive = await buildZip(wanted.map((w, i) => ({ name: names[i], bytes: results[i]! })))
      const blob = new Blob([archive as BlobPart], { type: 'application/zip' })
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = zipFileNameForTask(taskTitle)
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
      setZip({ status: 'idle' })
    } catch {
      setZip({ status: 'error', message: 'The ZIP could not be created. Try again.' })
    }
  }

  if (entries.length === 0) return null
  const busy = zip.status === 'busy'

  return (
    <section className="boe-card boe-task-gallery" aria-label="Task attachments" style={{ background: '#ffffff' }}>
      <div className="boe-task-gallery-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          <span style={{ fontSize: '15px', fontWeight: 600, color: '#20242D', letterSpacing: '-0.01em' }}>
            Attachments
          </span>
          <span className="boe-task-gallery-count">{galleryCountLabel(entries)}</span>
        </div>
        {images.length > 0 && (
          <button
            type="button"
            onClick={downloadAll}
            disabled={busy}
            aria-busy={busy}
            className="boe-task-gallery-download"
          >
            <Download size={13} aria-hidden />
            {busy ? `Preparing ${zip.done} of ${zip.total}…` : 'Download all images'}
          </button>
        )}
      </div>

      {zip.status === 'error' && (
        <p role="alert" className="boe-task-gallery-error">
          {zip.message}
          <button type="button" onClick={() => setZip({ status: 'idle' })} aria-label="Dismiss">✕</button>
        </p>
      )}

      {images.length > 0 && (
        <ul className="boe-task-gallery-grid">
          {images.map((img, i) => {
            const url = urls.get(img.path)
            const unavailable = (signed && !url) || broken.has(img.path)
            return (
              <li key={img.key}>
                <button
                  type="button"
                  onClick={() => openViewer(i)}
                  className="boe-task-gallery-thumb"
                  title={img.fileName}
                  aria-label={`Open image ${i + 1} of ${images.length}: ${img.fileName}`}
                >
                  <span className="boe-task-gallery-frame">
                    {url && !unavailable ? (
                      // Arbitrary user uploads at unknown sizes from a signed
                      // storage URL — see the note in AttachmentPreviewModal.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={url}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        onError={() => setBroken(prev => new Set(prev).add(img.path))}
                      />
                    ) : unavailable ? (
                      <ImageOff size={18} color={colors.muted} aria-hidden />
                    ) : null}
                  </span>
                  <span className="boe-task-gallery-name">{img.fileName}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {files.length > 0 && (
        <div className="boe-task-gallery-files">
          {images.length > 0 && (
            <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: colors.muted, margin: 0 }}>
              Files
            </p>
          )}
          {files.map(f => (
            <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
              <button
                type="button"
                onClick={() => onOpenFile(f.path, f.fileName)}
                title={f.fileName}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '5px', minWidth: 0, maxWidth: '100%',
                  fontSize: '11.5px', fontWeight: 500, fontFamily: font.body,
                  color: colors.blue, cursor: 'pointer',
                  padding: '4px 10px', borderRadius: '6px',
                  border: `1px solid ${colors.blue}28`,
                  background: colors.blueTint,
                }}
              >
                <Paperclip size={12} aria-hidden style={{ flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.fileName}</span>
              </button>
              <span style={{
                fontSize: '10px', fontWeight: 600, letterSpacing: '0.04em',
                textTransform: 'uppercase', color: colors.muted,
                background: colors.float, border: `1px solid ${colors.border}`,
                padding: '1px 7px', borderRadius: '20px', flexShrink: 0,
              }}>
                {f.typeLabel}
              </span>
            </div>
          ))}
        </div>
      )}

      {viewerAt !== null && (
        <TaskImageViewer
          images={images}
          urls={urls}
          startIndex={viewerAt}
          onClose={() => setViewerAt(null)}
        />
      )}
    </section>
  )
}
