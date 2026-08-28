'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, ImagePlus, Trash2 } from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import {
  MAX_PROJECT_PHOTOS,
  REVIEW_PHOTO_ACCEPT,
  REVIEW_PHOTO_BUCKET,
  REVIEW_PHOTO_TYPES_LABEL,
  formatPhotoSize,
  validateReviewPhoto,
} from '@/lib/customerReviews/photos'
import type { CustomerReviewPhoto, PhotoKind } from '@/lib/customerReviews/types'

// Project photographs and review proof, on a private bucket.
//
// UPLOADING AND REMOVING BOTH GO THROUGH THE SERVER.
//
// POST /api/customer-reviews/photos authenticates the caller, checks the
// permission, reads the bytes, decodes and re-encodes the image, generates the
// object key and writes both the object and its metadata row.
//
// DELETE /api/customer-reviews/photos does the reverse as ONE operation:
// mark, delete the object, delete the row, write the audit entry.
//
// The browser can do neither itself. `authenticated` holds no INSERT or DELETE
// policy on the metadata table and no INSERT or DELETE policy on the bucket, so
// a direct write or a half-removal is refused by the database rather than
// merely discouraged here. Reading is still direct.
//
// validateReviewPhoto() still runs before the POST. It is a COURTESY — it saves
// a five-megabyte round trip to be told no — and it is not the boundary. The
// route re-checks everything and does not trust a single field this component
// sends.
//
// READING is still direct: short-lived signed URLs, minted per render, governed
// by the same SELECT policy that decides who may read the request. There is no
// public URL anywhere in this file.
//
// NOT A MEDIA LIBRARY. Upload only, scoped to one request. Selecting an existing
// project photograph from elsewhere in BOE is not implemented and is recorded as
// a known limitation.

const SIGNED_URL_TTL_SECONDS = 300

export function PhotoManager({
  supabase,
  requestId,
  kind,
  photos,
  onChanged,
  /** False once the request is past the stage this kind may be attached in. */
  canAttach,
  canRemove,
  emptyHint,
  /** Show a per-photo download control, for attaching by hand in WhatsApp. */
  downloadable = false,
}: {
  supabase: SupabaseClient
  requestId: string | null
  kind: PhotoKind
  photos: CustomerReviewPhoto[]
  onChanged: () => void | Promise<void>
  canAttach: boolean
  canRemove: boolean
  emptyHint: string
  downloadable?: boolean
}) {
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const uploading = useRef(false)
  const removing = useRef(false)

  // Signed URLs are minted per render pass and never stored anywhere. They
  // expire on their own, and a viewer who has lost access simply gets no URL —
  // createSignedUrl is governed by the same policy as reading the request.
  useEffect(() => {
    let active = true
    const paths = photos.map(p => p.storage_path)
    // Nothing to sign. Previously signed URLs are left in state rather than
    // cleared: they are keyed by object path, so a removed photo's entry is
    // never looked up again, and clearing here would be a setState in an effect
    // body for no visible change.
    if (paths.length === 0) return

    supabase.storage
      .from(REVIEW_PHOTO_BUCKET)
      .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)
      .then(({ data }) => {
        if (!active || !data) return
        const next: Record<string, string> = {}
        data.forEach((entry, index) => {
          if (entry.signedUrl) next[paths[index]] = entry.signedUrl
        })
        setUrls(next)
      })
      .catch(() => { /* a missing preview is not an error worth a banner */ })

    return () => { active = false }
  }, [supabase, photos])

  const attach = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0 || !requestId) return
    // State is too slow to stop a double click; the ref is what actually stops
    // a second POST, and the server refuses a duplicate by content hash even if
    // two tabs race past this.
    if (uploading.current) return
    uploading.current = true
    setBusy(true)
    setError(null)

    try {
      const limit = kind === 'project_photo' ? MAX_PROJECT_PHOTOS : 1
      const room = limit - photos.length
      if (room <= 0) {
        setError(kind === 'project_photo'
          ? `You can attach up to ${MAX_PROJECT_PHOTOS} photographs.`
          : 'Only one proof image can be attached. Remove the current one first.')
        return
      }

      for (const file of Array.from(files).slice(0, room)) {
        // A courtesy check, not the boundary. See the note at the top.
        const invalid = validateReviewPhoto(file)
        if (invalid) { setError(invalid); return }

        const body = new FormData()
        body.append('requestId', requestId)
        body.append('kind', kind)
        body.append('file', file)

        const response = await fetch('/api/customer-reviews/photos', { method: 'POST', body })
        if (!response.ok) {
          // The route's own sentence, which is chosen from a closed list and
          // never contains a filename, a path or a customer detail.
          const payload = await response.json().catch(() => null)
          setError(typeof payload?.error === 'string'
            ? payload.error
            : 'That photo could not be attached.')
          return
        }
      }

      await onChanged()
    } catch {
      setError('That photo could not be attached. Check your connection and try again.')
    } finally {
      uploading.current = false
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }, [requestId, kind, photos.length, onChanged])

  const remove = useCallback(async (photo: CustomerReviewPhoto) => {
    if (removing.current) return
    removing.current = true
    setBusy(true)
    setError(null)
    try {
      // ONE call. Removing an attachment means deleting a private object AND a
      // metadata row, and a browser that could do either half on its own would
      // eventually do exactly one of them — leaving a file nothing names, or a
      // record pointing at nothing. The database refuses both halves to
      // `authenticated`, so this is the only path.
      const response = await fetch('/api/customer-reviews/photos', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoId: photo.id }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        setError(typeof payload?.error === 'string'
          ? payload.error
          : 'That photo could not be removed.')
        return
      }
      await onChanged()
    } catch {
      setError('That photo could not be removed. Check your connection and try again.')
    } finally {
      removing.current = false
      setBusy(false)
    }
  }, [onChanged])

  return (
    <div>
      {photos.length === 0 ? (
        <p style={{ fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>{emptyHint}</p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '10px' }}>
          {photos.map(photo => (
            <div
              key={photo.id}
              style={{
                width: '124px', borderRadius: '9px', overflow: 'hidden',
                border: `1px solid ${colors.border}`, background: colors.raised,
              }}
            >
              <div style={{ height: '92px', background: colors.float, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {urls[photo.storage_path] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={urls[photo.storage_path]}
                    alt={photo.file_name}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <span style={{ fontSize: '11px', color: colors.muted }}>Loading…</span>
                )}
              </div>
              <div style={{ padding: '6px 8px' }}>
                <div style={{
                  fontSize: '11px', color: colors.secondary, fontWeight: 600,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {photo.file_name}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '4px', marginTop: '2px' }}>
                  <span style={{ fontSize: '10px', color: colors.muted }}>{formatPhotoSize(photo.byte_size)}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                    {/* Opening the signed URL is how an employee gets the file
                        onto their device, so they can attach it by hand in
                        WhatsApp — which is the only way it ever reaches a
                        customer. */}
                    {downloadable && urls[photo.storage_path] && (
                      <a
                        href={urls[photo.storage_path]}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open ${photo.file_name} to save it`}
                        title="Open to save, then attach it in WhatsApp"
                        style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          width: '32px', height: '32px', margin: '-6px 0 -6px -6px',
                          borderRadius: '6px', color: colors.blue,
                        }}
                      >
                        <Download size={13} strokeWidth={2} />
                      </a>
                    )}
                    {canRemove && (
                      <button
                        type="button"
                        onClick={() => remove(photo)}
                        disabled={busy}
                        aria-label={`Remove ${photo.file_name}`}
                        // 32px square. The icon is 13px; the padding is what
                        // makes it hittable with a thumb rather than only with a
                        // mouse.
                        style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          width: '32px', height: '32px', margin: '-6px -6px -6px 0',
                          borderRadius: '6px', border: 'none', background: 'transparent',
                          color: colors.red, cursor: busy ? 'not-allowed' : 'pointer',
                        }}
                      >
                        <Trash2 size={13} strokeWidth={2} />
                      </button>
                    )}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {canAttach && requestId && (
        <>
          <input
            ref={inputRef}
            type="file"
            accept={REVIEW_PHOTO_ACCEPT}
            multiple={kind === 'project_photo'}
            onChange={e => attach(e.target.files)}
            style={{ display: 'none' }}
            id={`review-photo-input-${kind}`}
          />
          <label
            htmlFor={`review-photo-input-${kind}`}
            className="boe-btn boe-btn-ghost"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '7px 14px', fontSize: '12px', minHeight: '36px',
              cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1,
            }}
          >
            <ImagePlus size={14} strokeWidth={2} />
            {busy ? 'Checking and uploading…' : kind === 'project_photo' ? 'Add project photos' : 'Attach proof image'}
          </label>
          <p style={{ fontSize: '11px', color: colors.muted, marginTop: '6px' }}>
            {REVIEW_PHOTO_TYPES_LABEL}, up to 5 MB each
            {kind === 'project_photo' ? `, ${MAX_PROJECT_PHOTOS} maximum` : ''}.
            {kind === 'project_photo' ? ' Use real photographs of this customer’s own project.' : ''}
            {' '}Each file is checked on the server, re-encoded, and stripped of camera
            metadata before it is stored.
          </p>
        </>
      )}

      {canAttach && !requestId && (
        <p style={{ fontSize: '11px', color: colors.muted }}>
          Save the draft first — photographs attach to a saved request.
        </p>
      )}

      {error && (
        <p role="alert" style={{ fontSize: '12px', color: colors.red, marginTop: '8px' }}>{error}</p>
      )}
    </div>
  )
}
