'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ImagePlus, Trash2 } from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import {
  MAX_REVIEW_IMAGES,
  REVIEW_IMAGE_ACCEPT,
  REVIEW_IMAGE_BUCKET,
  REVIEW_IMAGE_TYPES_LABEL,
  validateReviewImage,
} from '@/lib/customerReviews/reviewImages'
import { formatPhotoSize } from '@/lib/customerReviews/photos'
import type { TestCardPhoto } from '@/lib/customerReviews/types'

// Up to four photographs of the furniture a review is about, on a private
// bucket.
//
// ATTACHING AND REMOVING BOTH GO THROUGH THE SERVER.
//
// POST /api/customer-reviews/images authenticates the caller, resolves
// `verify`, checks the review is still pending, reads the bytes, decodes and
// re-encodes the image, chooses the slot, generates the object key and writes
// both the object and its metadata row.
//
// DELETE /api/customer-reviews/images does the reverse as ONE operation: mark,
// delete the object, delete the row, write the audit entry.
//
// The browser can do neither itself. `authenticated` holds no INSERT or DELETE
// policy on the metadata table and none on the bucket, so a direct write or a
// half-removal is refused by the database rather than merely discouraged here.
//
// validateReviewImage() still runs before the POST. It is a COURTESY — it saves
// a five-megabyte round trip to be told no — and it is not the boundary.
//
// READING is direct: short-lived signed URLs, minted per render, governed by
// the same SELECT policy that decides who may read the card. There is no public
// URL in this file, and no image is public by default or otherwise.
//
// WHY THERE IS NO DOWNLOAD CONTROL HERE, when ShareReview has one. Downloading
// belongs to sharing an APPROVED review, where the point is to hand the images
// to WhatsApp by hand. A pending draft is not something to be handed anywhere,
// so the only things offered here are add and remove.

const SIGNED_URL_TTL_SECONDS = 300

export function ReviewImageManager({
  supabase,
  cardId,
  images,
  onChanged,
  /**
   * False once the review is approved. Attaching and removing share one window
   * — pending_approval — because the images an approved review carries are part
   * of what was approved.
   */
  canEdit,
}: {
  supabase: SupabaseClient
  cardId: string
  images: TestCardPhoto[]
  onChanged: () => void | Promise<void>
  canEdit: boolean
}) {
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const errorRef = useRef<HTMLParagraphElement | null>(null)
  const uploading = useRef(false)
  const removing = useRef(false)

  // AN ERROR NOBODY CAN SEE IS AN ERROR THAT DID NOT HAPPEN, as far as the
  // person is concerned.
  //
  // This section sits inside a scrolling sheet, and the message renders BELOW
  // the Add control — which on a phone, and on a desktop sheet holding four
  // thumbnails, is past the fold. Local acceptance testing caught exactly that:
  // a refused upload showed "A review can carry 4 images…" eighteen pixels
  // below the visible area, so the press looked like it had done nothing.
  //
  // `block: 'nearest'` scrolls the minimum needed rather than yanking the sheet
  // to the bottom, so the thumbnails the person was looking at stay in view.
  //
  // AND NO `behavior: 'smooth'`. The first version asked for it and the message
  // stayed exactly where it was: smooth scrolling is silently a no-op in some
  // engines and embedded views, so the animation was not merely skipped — the
  // scroll never happened at all. An error is the last thing that should depend
  // on an optional nicety working, and instant is the better answer regardless:
  // somebody who has just been refused wants the reason now, not after 300ms of
  // easing.
  useEffect(() => {
    if (!error) return
    errorRef.current?.scrollIntoView({ block: 'nearest' })
  }, [error])

  // Signed URLs are minted per render pass and never stored anywhere. They
  // expire on their own, and a viewer who has lost access simply gets no URL —
  // createSignedUrls is governed by the same policy as reading the card.
  useEffect(() => {
    let active = true
    const paths = images.map(i => i.storage_path)
    // Nothing to sign. Previously signed URLs are left in state rather than
    // cleared: they are keyed by object path, so a removed image's entry is
    // never looked up again, and clearing here would be a setState in an effect
    // body for no visible change.
    if (paths.length === 0) return

    supabase.storage
      .from(REVIEW_IMAGE_BUCKET)
      .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)
      .then(({ data }) => {
        if (!active || !data) return
        const next: Record<string, string> = {}
        data.forEach((entry, index) => {
          if (entry.signedUrl) next[paths[index]] = entry.signedUrl
        })
        setUrls(prev => ({ ...prev, ...next }))
      })
      .catch(() => { /* a missing thumbnail is not an error worth a banner */ })

    return () => { active = false }
  }, [supabase, images])

  const attach = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    if (uploading.current) return
    uploading.current = true
    setBusy(true)
    setError(null)

    try {
      // ONE AT A TIME, IN ORDER. A multi-select is accepted and uploaded
      // sequentially rather than in parallel: the server assigns the lowest
      // free slot, so two parallel uploads would race for it and one would come
      // back as "remove one before adding another" — a confusing answer to a
      // verifier who picked two pictures for two empty places.
      const chosen = Array.from(files)
      const room = MAX_REVIEW_IMAGES - images.length
      if (room <= 0) {
        setError(`A review can carry ${MAX_REVIEW_IMAGES} images. Remove one before adding another.`)
        return
      }
      if (chosen.length > room) {
        setError(`Only ${room} more image${room === 1 ? '' : 's'} can be attached to this review.`)
        return
      }

      for (const file of chosen) {
        const objection = validateReviewImage(file)
        if (objection) { setError(objection); return }

        const form = new FormData()
        form.append('cardId', cardId)
        form.append('file', file)

        const res = await fetch('/api/customer-reviews/images', { method: 'POST', body: form })
        if (!res.ok) {
          const payload = await res.json().catch(() => null)
          setError(payload?.error ?? 'That image could not be attached. Try again.')
          return
        }
      }

      await onChanged()
    } catch {
      setError('That image could not be attached. Try again.')
    } finally {
      uploading.current = false
      setBusy(false)
      // Cleared so choosing the same file twice in a row still fires onChange.
      if (inputRef.current) inputRef.current.value = ''
    }
  }, [cardId, images.length, onChanged])

  const remove = useCallback(async (imageId: string) => {
    if (removing.current) return
    removing.current = true
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/customer-reviews/images', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageId }),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        setError(payload?.error ?? 'That image could not be removed. Try again.')
        return
      }
      await onChanged()
    } catch {
      setError('That image could not be removed. Try again.')
    } finally {
      removing.current = false
      setBusy(false)
    }
  }, [onChanged])

  const full = images.length >= MAX_REVIEW_IMAGES

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
        <h4 style={{
          margin: 0, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.05em', color: colors.tertiary,
        }}>
          Images
        </h4>
        <span style={{ fontSize: '11px', color: colors.muted }}>
          {images.length} of {MAX_REVIEW_IMAGES}
          {images.length === 0 ? ' · optional' : ''}
        </span>
      </div>

      {images.length > 0 && (
        <ul style={{
          listStyle: 'none', margin: 0, padding: 0,
          display: 'grid', gap: '8px',
          gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
        }}>
          {images.map(image => (
            <li
              key={image.id}
              style={{
                position: 'relative', borderRadius: '8px', overflow: 'hidden',
                border: `1px solid ${colors.border}`, background: colors.raised,
              }}
            >
              {/*
                A thumbnail when the signed URL has arrived, the filename when it
                has not. An empty grey square would read as a broken image; the
                name is at least the fact we hold.
              */}
              {/*
                A PLAIN <img>, AS THE SCREENSHOT MANAGER USES. A signed,
                short-lived storage URL cannot go through next/image: the
                optimiser fetches it server-side and caches the result past the
                life of the signature, which turns a 300-second grant into a
                cached copy of a private object.
              */}
              {urls[image.storage_path] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={urls[image.storage_path]}
                  alt={image.file_name}
                  style={{ display: 'block', width: '100%', aspectRatio: '1 / 1', objectFit: 'cover' }}
                />
              ) : (
                <div style={{
                  width: '100%', aspectRatio: '1 / 1', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', padding: '6px',
                  fontSize: '10px', color: colors.muted, textAlign: 'center',
                  overflowWrap: 'anywhere',
                }}>
                  {image.file_name}
                </div>
              )}

              <div style={{
                padding: '5px 6px', fontSize: '10px', color: colors.tertiary,
                borderTop: `1px solid ${colors.border}`, background: '#FFFFFF',
              }}>
                {formatPhotoSize(image.byte_size)}
              </div>

              {canEdit && (
                <button
                  type="button"
                  onClick={() => remove(image.id)}
                  disabled={busy}
                  aria-label={`Remove ${image.file_name}`}
                  style={{
                    position: 'absolute', top: '2px', right: '2px',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    // 44px, LIKE EVERY OTHER CONTROL IN THIS MODULE. It was 32,
                    // which made the one destructive control on the thumbnail
                    // the only sub-44 target on the screen — and the one where
                    // a mis-tap costs somebody an image they have to re-upload.
                    // The icon stays small; the thing you press does not.
                    width: '44px', height: '44px', borderRadius: '8px',
                    border: 'none', cursor: busy ? 'default' : 'pointer',
                    // Slightly less opaque than the old 0.72 so a 44px square
                    // does not black out the corner of a 107px thumbnail.
                    background: 'rgba(17,19,24,0.62)', color: '#FFFFFF',
                  }}
                >
                  <Trash2 size={14} strokeWidth={2} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <input
            ref={inputRef}
            type="file"
            accept={REVIEW_IMAGE_ACCEPT}
            multiple
            onChange={e => attach(e.target.files)}
            disabled={busy || full}
            style={{ display: 'none' }}
            id={`review-images-${cardId}`}
          />
          <label
            htmlFor={`review-images-${cardId}`}
            className="boe-btn boe-btn-ghost"
            aria-disabled={busy || full}
            style={{
              fontSize: '12px', padding: '9px 14px', minHeight: '44px',
              cursor: busy || full ? 'default' : 'pointer',
              opacity: busy || full ? 0.55 : 1,
            }}
          >
            <ImagePlus size={13} strokeWidth={2} />
            {busy ? 'Working…' : 'Add images'}
          </label>
          {/*
            THE DISABLED REASON, IN WORDS. A greyed control with no explanation
            is a control people press repeatedly.
          */}
          <span style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.45 }}>
            {full
              ? `Four images is the limit. Remove one to add another.`
              : `${REVIEW_IMAGE_TYPES_LABEL}, up to 5 MB each. They stay with the review after approval.`}
          </span>
        </div>
      )}

      {!canEdit && images.length === 0 && (
        <p style={{ margin: 0, fontSize: '11px', color: colors.muted, lineHeight: 1.5 }}>
          No images are attached to this review.
        </p>
      )}

      {!canEdit && images.length > 0 && (
        <p style={{ margin: 0, fontSize: '11px', color: colors.muted, lineHeight: 1.5 }}>
          This review has been approved, so its images can no longer be changed.
        </p>
      )}

      {error && (
        <p ref={errorRef} role="alert" style={{ margin: 0, fontSize: '12px', color: colors.red, lineHeight: 1.5 }}>
          {error}
        </p>
      )}
    </section>
  )
}
