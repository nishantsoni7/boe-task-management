'use client'

import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'

// The product photograph and the two PI facts that sit beside it.
//
// Kept as one small component because the SKU cell is rendered in three places
// (desktop row, mobile card, and the update dialog's header) and all three must
// show the same thing. It adds no control: the thumbnail is a picture, and the
// one action on a product line is still the existing Update dialog.
//
// SIGNED URLS, NOT PUBLIC ONES. The bucket is private, so a key is exchanged for
// a short-lived signed URL at render time. A failure to sign is silent — the
// thumbnail simply does not appear — because a broken image is not worth an
// error banner in the middle of a review, and the product line is still
// complete without it.

export const MEETING_IMAGE_BUCKET = 'meeting-product-images'
/** Long enough to read a meeting, short enough that a leaked link expires. */
const SIGNED_URL_TTL_SECONDS = 60 * 60

/**
 * One signed URL per image key, cached for the life of the page.
 *
 * A PI reuses one photograph across several products — 20 products shared 11
 * images in a real file — so without this the same key would be signed once per
 * row, several times over.
 */
const signedUrlCache = new Map<string, Promise<string | null>>()

function signedUrlFor(supabase: SupabaseClient, path: string): Promise<string | null> {
  const cached = signedUrlCache.get(path)
  if (cached) return cached

  const promise = supabase.storage
    .from(MEETING_IMAGE_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS)
    .then(({ data }) => data?.signedUrl ?? null)
    .catch(() => null)

  signedUrlCache.set(path, promise)
  return promise
}

export function MeetingItemThumb({
  supabase, path, size = 44, onOpen,
}: {
  supabase: SupabaseClient
  path: string | null
  size?: number
  /** Opens the existing full-size preview. Omitted where a picture is enough. */
  onOpen?: (url: string) => void
}) {
  // Keyed by path, so a row whose image changes cannot briefly show the old
  // one. Storing the path alongside the URL is what lets the render decide,
  // rather than an effect resetting state on the way through — which is both a
  // cascading render and what react-hooks/set-state-in-effect refuses.
  const [signed, setSigned] = useState<{ path: string; url: string | null } | null>(null)
  const url = signed?.path === path ? signed.url : null

  useEffect(() => {
    if (!path) return
    let active = true
    signedUrlFor(supabase, path).then(next => {
      if (active) setSigned({ path, url: next })
    })
    return () => { active = false }
  }, [supabase, path])

  if (!path) return null

  const box: React.CSSProperties = {
    width: size, height: size, borderRadius: '6px', flexShrink: 0,
    border: `1px solid ${colors.border}`, background: colors.raised,
    objectFit: 'cover', display: 'block',
  }

  // Reserve the space while signing, so a row does not jump when it resolves.
  if (!url) return <div style={box} aria-hidden />

  if (!onOpen) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" style={box} loading="lazy" />
  }

  return (
    <button
      onClick={e => { e.stopPropagation(); onOpen(url) }}
      title="View product photograph"
      style={{ padding: 0, border: 'none', background: 'none', cursor: 'zoom-in', lineHeight: 0 }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="" style={box} loading="lazy" />
    </button>
  )
}

/**
 * Dimensions and the specification note, under the product name.
 *
 * Both are quiet by design: they are reference facts a reviewer glances at, not
 * the subject of the meeting. The note is clipped to two lines so a long
 * instruction cannot push the update column off the screen.
 */
export function MeetingItemSpec({
  dimensions, specNote,
}: {
  dimensions: string | null
  specNote: string | null
}) {
  if (!dimensions && !specNote) return null
  return (
    <>
      {dimensions && (
        <div style={{ fontSize: '12px', color: colors.tertiary, marginTop: '2px' }}>
          {dimensions}
        </div>
      )}
      {specNote && (
        <div style={{
          fontSize: '12px', color: colors.muted, marginTop: '2px', lineHeight: 1.35,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {specNote}
        </div>
      )}
    </>
  )
}

/**
 * Full-size view of one photograph.
 *
 * A plain overlay rather than a gallery: there is one image per product and no
 * reason to browse between them. Click anywhere or press Escape to close —
 * this is a read-only pop-up with nothing to lose, which is the case the BOE
 * form-modal rule explicitly leaves click-away alone.
 */
export function MeetingImageLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-label="Product photograph"
      style={{
        position: 'fixed', inset: 0, zIndex: 210, cursor: 'zoom-out',
        background: 'rgba(0,0,0,0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt="Product photograph"
        style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: '8px', objectFit: 'contain' }}
      />
    </div>
  )
}
