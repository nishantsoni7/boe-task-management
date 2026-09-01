import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomUUID } from 'node:crypto'

import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { IMAGE_REJECTION_MESSAGES } from '@/lib/customerReviews/imageBytes'
import {
  PROCESSING_REJECTION_MESSAGES,
  processReviewImage,
} from '@/lib/customerReviews/imageProcessing'
import { sanitizeDisplayName } from '@/lib/customerReviews/photos'
import {
  MAX_REVIEW_IMAGES,
  REVIEW_IMAGE_BUCKET,
  REVIEW_IMAGE_KIND,
  REVIEW_IMAGE_MAX_BYTES,
  buildReviewImagePath,
  extensionForMime,
  nextFreeSlot,
} from '@/lib/customerReviews/reviewImages'
import {
  isMissingObjectError,
  runPhotoRemoval,
  type BeginResult,
  type PhotoRemovalService,
  type PhotoVisibilityReader,
  type RemovalOutcome,
} from '@/lib/customerReviews/photoRemovalFlow'

// THE ONLY WAY A REVIEW IMAGE ENTERS OR LEAVES THIS MODULE.
//
// POST adds one. DELETE removes one. Both are here for the reason the
// screenshot route gives: each is an operation spanning the private bucket and
// the metadata table, and no client may perform half of one.
//
// ── WHY THIS IS NOT /api/customer-reviews/photos ────────────────────────────
//
// It is the same bucket, the same table and the same byte handling, and it is a
// different route on purpose, because the AUTHORIZATION IS A DIFFERENT RULE:
//
//               screenshot                    review image
//   permission  customer_review_requests.use  ...requests.verify
//   who         the tester HOLDING the card   any verifier
//   window      status = 'booked'             status = 'pending_approval'
//   afterwards  frozen at submission          KEPT, and shared with the review
//
// Folding two authorization models into one handler means a branch on kind
// before every check, and a branch on kind is exactly where the wrong one gets
// taken. Two routes, two windows, one shared byte pipeline.
//
// ── WHAT A REVIEW IMAGE IS ─────────────────────────────────────────────────
//
// A photograph of the furniture a review is about, attached by the verifier
// while the draft is still pending, and offered — with the approved review's
// text — to whoever shares it afterwards. It is not evidence of anything and it
// proves nothing; it is part of the review.
//
// ── THE ORDER OF WORK, and it is the order that matters ────────────────────
//
//   1. authenticate the caller, as the CALLER — not as the server;
//   2. resolve customer_review_requests.verify for them;
//   3. read the card THROUGH THEIR OWN RLS, so a card they may not see does not
//      exist as far as this route is concerned;
//   4. apply the status rule — pending_approval and nothing else;
//   5. read the whole file into memory, gate it structurally, then DECODE AND
//      RE-ENCODE it — the stored object is libvips output, never the upload;
//   6. choose the lowest free SLOT;
//   7. only then upload, to a path this server generates;
//   8. insert the metadata describing the RE-ENCODED bytes;
//   9. if that insert fails, remove the object again.
//
// NOTHING THE CLIENT SENDS NAMES A LOCATION. The body carries a card id and a
// file. The bucket is a constant, the object key is generated here from the
// card id and a fresh uuid, the slot is chosen here, and `uploaded_by` is the
// authenticated user — never a field.
//
// PRIVACY. No response and no log line carries a filename, a signed URL, a
// storage path or a byte of content. Rejections are prewritten sentences.

export const runtime = 'nodejs'

/** Reading, decoding and re-encoding a 5 MB image is fast, but not instant. */
export const maxDuration = 30

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * Every sentence this route can return, and it returns nothing else.
 *
 * An allow-list rather than a formatter: the alternative is a template that one
 * day interpolates an error somebody forgot was attacker-influenced.
 */
const MESSAGES = {
  unauthenticated: 'Sign in to continue.',
  forbidden:       'You do not have permission to attach images to this review.',
  not_found:       'That review is not available.',
  wrong_status:    'Images can only be changed while a review is awaiting approval.',
  no_file:         'No file was received.',
  bad_request:     'That request could not be processed.',
  too_many:        `A review can carry ${MAX_REVIEW_IMAGES} images. Remove one before adding another.`,
  duplicate:       'That image is already attached to this review.',
  upload_failed:   'That image could not be stored. Try again.',
  unavailable:     'Image uploads are not configured on this deployment.',
  remove_locked:   'This review has been approved, so its images can no longer be removed.',
  remove_failed:   'That image could not be removed. Try again.',
  remove_partial:  'The image was removed but the record could not be updated. Try again.',
} as const

const fail = (status: number, message: string) =>
  NextResponse.json({ error: message }, {
    // Private data, and a per-caller answer. Nothing about this response may be
    // cached by a proxy or a browser.
    status,
    headers: { 'Cache-Control': 'no-store, private' },
  })

const ok = (body: Record<string, unknown>) =>
  NextResponse.json(body, { status: 200, headers: { 'Cache-Control': 'no-store, private' } })

export async function POST(req: NextRequest) {
  // ── 1. Who is calling ─────────────────────────────────────────────────────
  const caller = await createClient()
  const { data: { user }, error: authError } = await caller.auth.getUser()
  if (authError || !user) return fail(401, MESSAGES.unauthenticated)

  // ── 2. Active, and holding `verify` ───────────────────────────────────────
  //
  // is_active only. The role column is deliberately not selected: attaching a
  // review image is a verifier's action, and a verifier is somebody the
  // permission engine says holds `verify` — not somebody with a job title.
  const { data: profile } = await caller
    .from('users')
    .select('is_active')
    .eq('id', user.id)
    .single()
  if (!profile || profile.is_active !== true) return fail(403, MESSAGES.forbidden)

  const { data: allowed } = await caller.rpc('resolve_permission', {
    p_user_id: user.id,
    p_module_key: 'customer_review_requests',
    p_action_key: 'verify',
  })
  if (allowed !== true) return fail(403, MESSAGES.forbidden)

  // ── 3. What was sent ──────────────────────────────────────────────────────
  let cardId: string
  let bytes: Uint8Array
  let displayName: string
  try {
    const form = await req.formData()

    const rawId = form.get('cardId')
    if (typeof rawId !== 'string' || !UUID_RE.test(rawId)) return fail(400, MESSAGES.bad_request)
    cardId = rawId

    const file = form.get('file')
    if (!file || typeof file === 'string') return fail(400, MESSAGES.no_file)

    // The declared size is checked first so an oversized body is refused before
    // it is read into memory; the REAL length is checked again below, because
    // this one is still the client's claim.
    if ((file as File).size > REVIEW_IMAGE_MAX_BYTES) {
      return fail(413, IMAGE_REJECTION_MESSAGES.too_large)
    }
    bytes = new Uint8Array(await (file as File).arrayBuffer())

    // The ONE caller-supplied string that is stored. Stripped of separators and
    // control characters and bounded, so that even though it never reaches a
    // path, it cannot carry one — and it is never echoed back in an error.
    displayName = sanitizeDisplayName((file as File).name)
  } catch {
    return fail(400, MESSAGES.bad_request)
  }

  // ── 4. May they attach to THIS review ─────────────────────────────────────
  //
  // Read as the caller. The card's SELECT policy decides, so a card they may
  // not see returns no row and this route cannot tell the difference between
  // "not yours" and "does not exist".
  const { data: card } = await caller
    .from('customer_review_test_cards')
    .select('id, status, deleted_at')
    .eq('id', cardId)
    .maybeSingle()
  if (!card || card.deleted_at !== null) return fail(404, MESSAGES.not_found)

  // WHILE IT IS STILL A DRAFT, AND NO LATER. Once a review is approved a
  // candidate may already have read it and shared it; the images it was
  // approved with are part of what was approved. Mirrors
  // begin_customer_review_image_removal()'s status rule, so an image can be
  // added and withdrawn in exactly the same window.
  if (card.status !== 'pending_approval') return fail(409, MESSAGES.wrong_status)

  // ── 5. What the bytes actually are ────────────────────────────────────────
  //
  // The real length, the real container, and a container that accounts for the
  // whole file. This is what the browser's `file.type` was standing in for, and
  // it is the reason the stored mime_type is a fact rather than a claim.
  const processed = await processReviewImage(bytes, REVIEW_IMAGE_MAX_BYTES)
  if (!processed.ok) {
    const message = processed.reason === 'undecodable' || processed.reason === 'too_many_pixels'
      ? PROCESSING_REJECTION_MESSAGES[processed.reason]
      : IMAGE_REJECTION_MESSAGES[processed.reason]
    return fail(processed.reason === 'too_large' ? 413 : 415, message)
  }

  // FROM HERE ON, `stored` is the file. The uploaded bytes are not written
  // anywhere, are not hashed, and are not described by the metadata row.
  const stored = processed.bytes

  // ── 6. The privileged client ──────────────────────────────────────────────
  const admin = adminClient()
  if (!admin.ok) {
    // The NAMES of the missing variables, never their values.
    console.error('[customer-reviews:images] missing env:', admin.missing.join(', '))
    return fail(503, MESSAGES.unavailable)
  }
  const service = admin.client

  // ── 7. Limits that need the existing rows ─────────────────────────────────
  // Hashed over the STORED bytes, so two uploads of the same photograph that
  // differed only in metadata collapse to one attachment.
  const digest = createHash('sha256').update(stored).digest('hex')

  const { data: existing, error: existingError } = await service
    .from('customer_review_test_card_screenshots')
    .select('id, content_sha256, image_slot, removal_started_at')
    .eq('card_id', cardId)
    .eq('kind', REVIEW_IMAGE_KIND)
  if (existingError) return fail(500, MESSAGES.upload_failed)

  // A row already marked for removal does not count against the limit and does
  // not hold its slot: it is on its way out, and every reader already treats it
  // as gone. Counting it would make a failed removal permanently block the
  // replacement it exists to allow.
  const live = (existing ?? []).filter(row => row.removal_started_at === null)

  // ── THIS COUNT IS A COURTESY, NOT THE GUARANTEE ───────────────────────────
  //
  // It is a READ FOLLOWED BY A WRITE. Two concurrent uploads with different
  // content both see three here and both proceed, and the review would end up
  // with five. No amount of care at this point fixes that.
  //
  // What fixes it is customer_review_image_one_live_per_slot, a partial unique
  // index over (card_id, image_slot): the second inserter blocks on the index
  // and fails with 23505. Step 9 turns that into the SAME sentence this check
  // produces, so a verifier sees one answer however the race went.
  //
  // The check stays because it is cheaper and kinder: it refuses before five
  // megabytes are decoded, re-encoded and uploaded.
  if (live.length >= MAX_REVIEW_IMAGES) return fail(409, MESSAGES.too_many)

  // REPEATED CLICKS, answered by the content rather than by a timer. Two
  // requests carrying identical bytes for one review are one upload; a
  // genuinely different photograph is never blocked. Backed by its own partial
  // unique index for the same reason as above.
  if (live.some(row => row.content_sha256 === digest)) {
    return fail(409, MESSAGES.duplicate)
  }

  // THE LOWEST FREE SLOT. A gap left by a removal is reused, so four
  // attachments after three removals is still four rather than the seventh.
  const slot = nextFreeSlot(
    live.map(row => row.image_slot).filter((n): n is number => typeof n === 'number'),
  )
  if (slot === null) return fail(409, MESSAGES.too_many)

  // ── 8. The path, generated HERE ───────────────────────────────────────────
  //
  // The card id first, because the storage SELECT policy reads ownership out of
  // split_part(name, '/', 1) and the metadata CHECK requires the two to agree.
  // Nothing the caller typed contributes a character.
  const storagePath = buildReviewImagePath(cardId, randomUUID(), extensionForMime(processed.mime))

  const { error: uploadError } = await service.storage
    .from(REVIEW_IMAGE_BUCKET)
    .upload(storagePath, stored, {
      // The re-encoded bytes, under the type they were encoded as. What is
      // stored and what is served are the same fact.
      contentType: processed.mime,
      upsert: false,
    })
  if (uploadError) return fail(500, MESSAGES.upload_failed)

  // ── 9. The metadata, from the inspection ──────────────────────────────────
  const { data: row, error: rowError } = await service
    .from('customer_review_test_card_screenshots')
    .insert({
      card_id: cardId,
      kind: REVIEW_IMAGE_KIND,
      image_slot: slot,
      storage_path: storagePath,
      // Display only, and bounded. The filename is the one thing the caller
      // supplies that is kept, and it never reaches a path or a response.
      file_name: displayName,
      mime_type: processed.mime,
      byte_size: stored.length,
      content_sha256: digest,
      uploaded_by: user.id,
    })
    .select('id, kind, image_slot, storage_path, file_name, mime_type, byte_size, uploaded_by, uploaded_at')
    .single()

  if (rowError || !row) {
    // COMPENSATION. The object exists and nothing points at it; the metadata
    // row is what makes it discoverable and what the path constraint checks.
    // Remove it before returning, so a failed attach leaves the review exactly
    // as it was rather than leaving a file nobody can find again.
    await service.storage.from(REVIEW_IMAGE_BUCKET).remove([storagePath])

    // ── THE RACE, ARRIVING AS A UNIQUE VIOLATION ────────────────────────────
    //
    // 23505 here means another request won: either it took this slot
    // (one_live_per_slot), or it registered these same bytes first
    // (unique_live_content). Both are states the count in step 7 was trying to
    // prevent and could not, because it read before it wrote. The two indexes
    // are distinguished by NAME rather than by guessing from the message text.
    if (rowError?.code === '23505') {
      const constraint = `${rowError.message ?? ''} ${rowError.details ?? ''}`
      return fail(409, constraint.includes('unique_live_content')
        ? MESSAGES.duplicate
        : MESSAGES.too_many)
    }
    return fail(500, MESSAGES.upload_failed)
  }

  return ok({ image: { ...row, card_id: cardId } })
}

// ══ REMOVING ONE ════════════════════════════════════════════════════════════
//
// ONE OPERATION, because it spans two systems and no transaction covers both.
// The three steps and the reasoning are the screenshot route's, which this
// mirrors deliberately:
//
//   MARK    begin_customer_review_image_removal() re-checks the authorization
//           in SQL, refuses a test screenshot, refuses an approved review,
//           locks the row and stamps removal_started_at/removal_by. Every read
//           filters the row out from this moment.
//   OBJECT  the file is deleted from the private bucket.
//   ROW     finish_customer_review_image_removal() deletes the metadata, and
//           the delete trigger writes `image_removed` to the append-only trail.
//
// A FAILURE BETWEEN THEM IS EXPLICIT, and both functions are idempotent, so a
// retry converges from either half.

export async function DELETE(req: NextRequest) {
  const caller = await createClient()
  const { data: { user }, error: authError } = await caller.auth.getUser()
  if (authError || !user) return fail(401, MESSAGES.unauthenticated)

  const { data: profile } = await caller
    .from('users')
    .select('is_active')
    .eq('id', user.id)
    .single()
  if (!profile || profile.is_active !== true) return fail(403, MESSAGES.forbidden)

  // The SAME permission the attach half requires, resolved the same way.
  // begin_customer_review_image_removal() resolves `verify` too, with no
  // administrator branch, so admitting anyone else here would be a promise the
  // definer function was never going to keep.
  const { data: allowed } = await caller.rpc('resolve_permission', {
    p_user_id: user.id,
    p_module_key: 'customer_review_requests',
    p_action_key: 'verify',
  })
  if (allowed !== true) return fail(403, MESSAGES.forbidden)

  let imageId: string
  try {
    const body = await req.json()
    const raw = body?.imageId
    if (typeof raw !== 'string' || !UUID_RE.test(raw)) return fail(400, MESSAGES.bad_request)
    imageId = raw
  } catch {
    return fail(400, MESSAGES.bad_request)
  }

  const admin = adminClient()
  if (!admin.ok) {
    console.error('[customer-reviews:images] missing env:', admin.missing.join(', '))
    return fail(503, MESSAGES.unavailable)
  }
  const service = admin.client

  // THE RESUME READ, and it deliberately does NOT filter `removal_started_at`.
  //
  // Marking a row hides it from every list — that is what marking is for. But
  // this is the path that finishes an interrupted removal, and a resume that
  // could not see the thing it is resuming would be no resume at all. It still
  // runs as the CALLER, so their own RLS decides.
  const reader: PhotoVisibilityReader = {
    async isVisibleToCaller(id) {
      const { data, error } = await caller
        .from('customer_review_test_card_screenshots')
        .select('id')
        .eq('id', id)
        .maybeSingle()
      if (error) return { visible: false, failed: true }
      return { visible: !!data, failed: false }
    },
  }

  const removal: PhotoRemovalService = {
    async beginRemoval(id, actorId): Promise<BeginResult> {
      const { data, error } = await service.rpc(
        'begin_customer_review_image_removal',
        { p_image_id: id, p_actor_id: actorId },
      )
      if (error) {
        // The database's own refusal codes, mapped to outcomes. The message
        // text is never forwarded.
        const code = error.message ?? ''
        if (code.includes('CUSTOMER_REVIEW_IMAGE_NOT_FOUND')) return { outcome: 'gone' }
        if (code.includes('CUSTOMER_REVIEW_TEST_NOT_FOUND'))  return { outcome: 'gone' }
        if (code.includes('CUSTOMER_REVIEW_TEST_LOCKED'))     return { outcome: 'locked' }
        if (code.includes('CUSTOMER_REVIEW_TEST_DELETED'))    return { outcome: 'locked' }
        if (code.includes('CUSTOMER_REVIEW_TEST_UNAUTHORIZED')) return { outcome: 'forbidden' }
        return { outcome: 'error' }
      }
      const path = (data as { storage_path?: string } | null)?.storage_path
      if (typeof path !== 'string' || path.length === 0) return { outcome: 'error' }
      return { outcome: 'ready', storagePath: path }
    },

    async deleteObject(storagePath) {
      const { error } = await service.storage.from(REVIEW_IMAGE_BUCKET).remove([storagePath])
      if (!error) return { ok: true, missing: false }
      return { ok: false, missing: isMissingObjectError(error) }
    },

    async finishRemoval(id) {
      const { error } = await service.rpc('finish_customer_review_image_removal', { p_image_id: id })
      return { ok: !error }
    },
  }

  return respondTo(await runPhotoRemoval({ reader, service: removal }, user.id, imageId), imageId)
}

/**
 * One outcome, one response.
 *
 * `already_removed` is a 200 on purpose, and it is the same 200 a genuine
 * removal returns. A completed removal reporting as a failure was the defect a
 * sibling route already fixed; a completed removal reporting DIFFERENTLY from
 * an unresolvable id would be a disclosure. Both are answered identically.
 */
function respondTo(outcome: RemovalOutcome, imageId: string) {
  switch (outcome.status) {
    case 'removed':
    case 'already_removed':
      return ok({ removed: imageId })
    case 'refused':
      return outcome.reason === 'locked'
        ? fail(409, MESSAGES.remove_locked)
        : fail(403, MESSAGES.forbidden)
    case 'failed':
      return outcome.reason === 'row'
        ? fail(500, MESSAGES.remove_partial)
        : fail(500, MESSAGES.remove_failed)
  }
}
