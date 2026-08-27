'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ImagePlus, Trash2 } from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import {
  MAX_PROJECT_PHOTOS,
  REVIEW_PHOTO_ACCEPT,
  REVIEW_PHOTO_BUCKET,
  REVIEW_PHOTO_TYPES_LABEL,
  buildReviewPhotoPath,
  formatPhotoSize,
  reviewPhotoContentType,
  validateReviewPhoto,
} from '@/lib/customerReviews/photos'
import type { CustomerReviewPhoto, PhotoKind } from '@/lib/customerReviews/types'

// Project photographs and review proof, on a private bucket.
//
// Same shape as the Finance payment-proof upload: the object key is fully
// generated (nothing a user typed reaches the path), the bucket is private, and
// the images are shown through short-lived signed URLs whose issue is governed
// by the same SELECT policy that decides who may read the request. There is no
// public URL anywhere in this file.
//
// THE COMPENSATION THAT MATTERS. An upload is two writes — the object, then the
// metadata row — and the row is what makes the object discoverable and what the
// path constraint checks. If the row fails, the object is removed again before
// this function returns, so a failed attach cannot leave an orphan sitting in a
// bucket nothing points at. The storage DELETE policy permits exactly that
// cleanup for the owner while the request is still being prepared.
//
// NOT A MEDIA LIBRARY. Upload only, scoped to one request. Selecting an
// existing project photograph from elsewhere in BOE is not implemented and is
// recorded as a known limitation — the images that exist live inside Order
// submissions and Showroom products, behind their own buckets and their own
// authorization, and reaching across to them is a far larger piece of work than
// this module.

const SIGNED_URL_TTL_SECONDS = 300

export function PhotoManager({
  supabase,
  requestId,
  kind,
  photos,
  onChanged,
  /** False once the request is past preparation, or for a non-owner. */
  canAttach,
  canRemove,
  emptyHint,
}: {
  supabase: SupabaseClient
  requestId: string | null
  kind: PhotoKind
  photos: CustomerReviewPhoto[]
  onChanged: () => void | Promise<void>
  canAttach: boolean
  canRemove: boolean
  emptyHint: string
}) {
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const uploading = useRef(false)

  // Signed URLs are minted per render pass and never stored anywhere. They
  // expire on their own, and a viewer who has lost access simply gets no URL —
  // createSignedUrl is governed by the same policy as reading the request.
  useEffect(() => {
    let active = true
    const paths = photos.map(p => p.storage_path)
    // Nothing to sign. The previously signed URLs are left in state rather than
    // cleared: they are keyed by object path, so a removed photo's entry is
    // simply never looked up again, and clearing here would be a setState in an
    // effect body for no visible change.
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
        const invalid = validateReviewPhoto(file)
        if (invalid) { setError(invalid); return }

        const contentType = reviewPhotoContentType(file)
        if (!contentType) { setError(`Only ${REVIEW_PHOTO_TYPES_LABEL} images can be attached.`); return }

        const path = buildReviewPhotoPath(requestId, kind, file.name)

        const { error: uploadError } = await supabase.storage
          .from(REVIEW_PHOTO_BUCKET)
          .upload(path, file, { contentType, upsert: false })
        if (uploadError) {
          setError('That photo could not be uploaded. Check the file and try again.')
          return
        }

        const { error: rowError } = await supabase
          .from('customer_review_request_photos')
          .insert({
            request_id: requestId,
            kind,
            storage_path: path,
            // The stored name is for display only and is never used to build a
            // path; it is trimmed so a pathological filename cannot exceed the
            // column's own limit and fail the insert after the object landed.
            file_name: file.name.slice(0, 200),
            mime_type: contentType,
            byte_size: file.size,
          })

        if (rowError) {
          // COMPENSATION: the object exists and nothing points at it. Remove it
          // before returning, so a failed attach leaves the request exactly as
          // it was.
          await supabase.storage.from(REVIEW_PHOTO_BUCKET).remove([path]).catch(() => {})
          setError('That photo could not be attached to this request.')
          return
        }
      }

      await onChanged()
    } finally {
      uploading.current = false
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }, [supabase, requestId, kind, photos.length, onChanged])

  const remove = useCallback(async (photo: CustomerReviewPhoto) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      // The metadata row first: while it exists the object is still
      // discoverable, so a failure here is recoverable and a failure after it
      // leaves nothing dangling that anybody can see.
      const { error: rowError } = await supabase
        .from('customer_review_request_photos')
        .delete()
        .eq('id', photo.id)
      if (rowError) { setError('That photo could not be removed.'); return }

      await supabase.storage.from(REVIEW_PHOTO_BUCKET).remove([photo.storage_path]).catch(() => {})
      await onChanged()
    } finally {
      setBusy(false)
    }
  }, [supabase, busy, onChanged])

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
                  {canRemove && (
                    <button
                      type="button"
                      onClick={() => remove(photo)}
                      disabled={busy}
                      aria-label={`Remove ${photo.file_name}`}
                      style={{
                        display: 'inline-flex', alignItems: 'center', padding: '3px',
                        border: 'none', background: 'transparent',
                        color: colors.red, cursor: busy ? 'not-allowed' : 'pointer',
                      }}
                    >
                      <Trash2 size={13} strokeWidth={2} />
                    </button>
                  )}
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
              padding: '7px 14px', fontSize: '12px',
              cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1,
            }}
          >
            <ImagePlus size={14} strokeWidth={2} />
            {busy ? 'Attaching…' : kind === 'project_photo' ? 'Add project photos' : 'Attach proof image'}
          </label>
          <p style={{ fontSize: '11px', color: colors.muted, marginTop: '6px' }}>
            {REVIEW_PHOTO_TYPES_LABEL}, up to 5 MB each
            {kind === 'project_photo' ? `, ${MAX_PROJECT_PHOTOS} maximum` : ''}.
            {kind === 'project_photo' ? ' Use real photographs of this customer’s own project.' : ''}
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
