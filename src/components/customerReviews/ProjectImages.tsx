'use client'

import { useCallback, useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import { formatPhotoSize } from '@/lib/customerReviews/photos'
import { GROUP_IMAGE_BUCKET } from '@/lib/customerReviews/imageGroups'
import { AWAITING_IMAGES_LABEL } from '@/lib/customerReviews/reviewTypes'
import {
  REVIEW_GROUP_IMAGE_COLUMNS,
  type ReviewGroupImage,
} from '@/lib/customerReviews/types'
import { ImageGridSkeleton } from './ReviewSkeletons'

// ── The photographs an image review posts ────────────────────────────────────
//
// THE PROJECT GROUP IS THE AUTHORITATIVE SOURCE for an image review, and this
// is the one place the browser reads it. The detail screen uses what this hook
// returns for three things at once — whether the review is Ready, what the
// candidate is shown, and what the share sheet carries — so all three are the
// same set of images by construction rather than by three queries agreeing.
//
// ── AUTHORIZATION: THE CALLER'S OWN CLIENT, ALWAYS ──────────────────────────
//
// Both reads below go through the SIGNED-IN USER'S supabase client, never a
// service role and never a route holding one. What comes back is decided by
// customer_review_group_images_select and customer_review_image_groups_select,
// which both defer to can_view_customer_review_image_group() — a verifier, or a
// `use` holder who has been assigned a LIVE review pointing at that exact
// group, and nobody else.
//
// So Employee A asking for Employee B's group id gets an empty list, not an
// error and not a partial answer. There is no endpoint here to reach past, no
// id to guess into something, and no privileged path exposed to the browser.
//
// The thumbnails are drawn from SHORT-LIVED SIGNED URLS minted per render and
// stored nowhere. createSignedUrls is governed by the bucket's own SELECT
// policy, which asks the same question again about the same group.
//
// ── WHY THE ARCHIVED FLAG IS READ AT ALL ────────────────────────────────────
//
// An archived project is one nobody is posting about any more. A review still
// pointing at one is NOT ready, so booking and sharing are both refused — the
// database says the same thing inside the UPDATE that books. Reading only the
// images would make an archived-but-populated group look usable.

const SIGNED_URL_TTL_SECONDS = 300

export type ProjectImageSet = {
  /** Live images in the group, oldest first. Empty until loaded, or when there are none. */
  images: ReviewGroupImage[]
  /**
   * The group exists, is not archived and holds at least one live image.
   *
   * `undefined` while loading, and `undefined` for a review with no group at
   * all — imageReadiness() already answers that case from image_group_id, and a
   * `false` here would be indistinguishable from "the group is unusable".
   */
  usable: boolean | undefined
  loading: boolean
}

export const NO_PROJECT_IMAGES: ProjectImageSet = { images: [], usable: undefined, loading: false }

/**
 * Load one review's project images, through the caller's own RLS.
 *
 * TWO SMALL READS RATHER THAN AN EMBED. The group row answers "archived?" and
 * the image rows answer "how many, and where"; an embedded select would couple
 * this to a PostgREST relationship name for no gain at two round trips.
 */
export function useProjectImages(
  supabase: SupabaseClient,
  groupId: string | null | undefined,
): ProjectImageSet {
  const target = groupId ?? null

  /**
   * WHICH GROUP THE VALUE IN STATE BELONGS TO, or null before the first load.
   *
   * "Loading" is DERIVED from this rather than tracked separately, and that is
   * what keeps the effect below free of a synchronous setState — a flag would
   * have to be raised before the await, inside the effect, which is the
   * cascading-render pattern react-hooks/set-state-in-effect exists to catch.
   * The list screen resolves the same problem the same way with `loadedTab`.
   */
  const [loaded, setLoaded] = useState<{ groupId: string | null; value: ProjectImageSet }>(
    { groupId: null, value: NO_PROJECT_IMAGES },
  )

  const load = useCallback(async (): Promise<ProjectImageSet> => {
    if (!groupId) return NO_PROJECT_IMAGES

    const [{ data: groupRow, error: groupError }, { data: imageRows, error: imageError }] =
      await Promise.all([
        supabase
          .from('customer_review_image_groups')
          .select('id, archived_at')
          .eq('id', groupId)
          .maybeSingle(),
        supabase
          .from('customer_review_group_images')
          .select(REVIEW_GROUP_IMAGE_COLUMNS)
          .eq('group_id', groupId)
          .is('removal_started_at', null)
          .order('uploaded_at', { ascending: true }),
      ])

    // A READ THAT FAILED IS NOT A GROUP THAT IS UNUSABLE. Reporting `false`
    // here would grey out Book and hide Share on a network blip; `undefined`
    // means "unknown", the controls stay as the row alone implies, and the
    // database refuses anything that should not happen.
    if (groupError || imageError) return { images: [], usable: undefined, loading: false }

    // NO ROW MEANS NOT VISIBLE TO THIS CALLER, which for a candidate is the
    // same answer as not usable: they cannot post photographs they cannot read.
    const group = groupRow as { archived_at: string | null } | null
    const images = (imageRows ?? []) as unknown as ReviewGroupImage[]

    return {
      images,
      usable: group !== null && group.archived_at === null && images.length > 0,
      loading: false,
    }
  }, [supabase, groupId])

  // A FETCH IS STARTED HERE; NO STATE IS SET HERE. Every setState runs after
  // the read resolves, so this effect performs no synchronous state update.
  useEffect(() => {
    if (target === null) return
    let active = true
    const startFetch = () => {
      void load().then(value => { if (active) setLoaded({ groupId: target, value }) })
    }
    startFetch()
    return () => { active = false }
  }, [load, target])

  // A review with no group has nothing to load and nothing to wait for; one
  // whose group has not come back yet is loading, and says so rather than
  // rendering an empty set that reads as "no images".
  if (target === null) return NO_PROJECT_IMAGES
  if (loaded.groupId !== target) return { images: [], usable: undefined, loading: true }
  return loaded.value
}

/**
 * The project images, shown to whoever is looking at the review.
 *
 * READ ONLY, AND THAT IS THE REQUIREMENT. A candidate does not choose images —
 * they are given a project, and this shows them which photographs will go out
 * with the review they are about to share. There is no add, no remove and no
 * reorder here; the library is where a verifier manages a project.
 */
export function ProjectImages({
  supabase, set, label,
}: {
  supabase: SupabaseClient
  set: ProjectImageSet
  /** The project's internal name, when the caller has read it. */
  label: string | null
}) {
  const [urls, setUrls] = useState<Record<string, string>>({})

  useEffect(() => {
    const paths = set.images.map(i => i.storage_path)
    if (paths.length === 0) return
    let active = true
    supabase.storage
      .from(GROUP_IMAGE_BUCKET)
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
  }, [supabase, set.images])

  // TILE-SHAPED, so the block does not grow under the reader's eye when the
  // photographs arrive. The review text above it never waits for this.
  if (set.loading) return <ImageGridSkeleton />

  // AN ARCHIVED GROUP IS NOT SHOWN AS A GALLERY. It can still hold pictures,
  // and drawing them said `here is what goes out` about a review that cannot
  // be booked or shared — the badge beside it says `Waiting for admin images`
  // and the database refuses the booking. This is the same sentence.
  if (set.images.length === 0 || set.usable === false) {
    return (
      <p style={{
        margin: 0, padding: '14px 16px', borderRadius: '8px', fontSize: '12px', lineHeight: 1.6,
        border: `1px dashed ${colors.border}`, color: '#92400E', background: '#FFFBEB',
      }}>
        <strong>{AWAITING_IMAGES_LABEL}.</strong>{' '}
        You can book and share this review once they are attached.
      </p>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <p style={{ margin: 0, fontSize: '12px', color: colors.secondary, lineHeight: 1.6 }}>
        {set.images.length} photograph{set.images.length === 1 ? '' : 's'} of one project
        {label ? ` · ${label}` : ''}. These go out when you share the review.
      </p>

      <ul style={{
        listStyle: 'none', margin: 0, padding: 0,
        display: 'grid', gap: '8px',
        gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
      }}>
        {set.images.map(image => (
          <li key={image.id} style={{
            borderRadius: '8px', overflow: 'hidden',
            border: `1px solid ${colors.border}`, background: colors.raised,
          }}>
            {/*
              A PLAIN <img>, as every other private-image surface in this module
              uses. A signed, short-lived storage URL cannot go through
              next/image: the optimiser fetches it server-side and caches the
              result past the life of the signature, which turns a 300-second
              grant into a cached copy of a private object.
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
          </li>
        ))}
      </ul>
    </div>
  )
}
