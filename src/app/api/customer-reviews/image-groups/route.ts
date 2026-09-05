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
  GROUP_IMAGE_BUCKET,
  GROUP_IMAGE_MAX_BYTES,
  MAX_GROUP_IMAGES,
  buildGroupImagePath,
  extensionForGroupMime,
} from '@/lib/customerReviews/imageGroups'
import {
  isMissingObjectError,
  runPhotoRemoval,
  type BeginResult,
  type PhotoRemovalService,
  type PhotoVisibilityReader,
  type RemovalOutcome,
} from '@/lib/customerReviews/photoRemovalFlow'

// THE ONLY WAY AN IMAGE ENTERS OR LEAVES A PROJECT IMAGE GROUP.
//
// POST adds one. DELETE removes one. Both are here for the reason the two
// sibling routes give: each is an operation spanning a private bucket and a
// metadata table, and no client may perform half of one.
//
// ── WHY THIS IS NOT /api/customer-reviews/images ───────────────────────────
//
// Same byte pipeline, different subject and different lifetime:
//
//                  review image                    project group image
//   belongs to     ONE review                      ONE project, reused across
//                                                  reviews and employees
//   window         while the review is pending     any time the project is not
//                                                  in a candidate's hands
//   bucket         ...test-screenshots             ...project-images
//   how many       four, as numbered slots         up to twenty, unnumbered
//
// The slots are the sharpest difference. A review image occupies one of four
// places because "at most four" has to survive a race; a group image occupies
// none, because nothing about a group depends on which image is which.
//
// ── WHAT A PROJECT IMAGE IS ────────────────────────────────────────────────
//
// A photograph of ONE completed project. An image review points at the GROUP,
// so a candidate posting one is posting photographs of a single project without
// anybody having had to remember not to mix two.
//
// ── THE ORDER OF WORK, and it is the order that matters ────────────────────
//
//   1. authenticate the caller, as the CALLER — not as the server;
//   2. resolve customer_review_requests.verify for them;
//   3. read the group THROUGH THEIR OWN RLS, so a group they may not see does
//      not exist as far as this route is concerned;
//   4. read the whole file into memory, gate it structurally, then DECODE AND
//      RE-ENCODE it — the stored object is libvips output, never the upload;
//   5. only then upload, to a path this server generates;
//   6. insert the metadata describing the RE-ENCODED bytes;
//   7. if that insert fails, remove the object again.
//
// NOTHING THE CLIENT SENDS NAMES A LOCATION. The body carries a group id and a
// file. The bucket is a constant, the object key is generated here from the
// group id and a fresh uuid, and `uploaded_by` is the authenticated user —
// never a field.
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
 * An allow-list rather than a formatter: a template is one careless
 * interpolation away from putting a database message, a path or a filename in
 * front of a person who should not see one.
 */
const MESSAGES = {
  unauthenticated: 'Sign in to continue.',
  forbidden:       'You do not have permission to manage the project image library.',
  not_found:       'That project group is not available.',
  no_file:         'No file was received.',
  bad_request:     'That request could not be processed.',
  too_many:        `A project group can hold ${MAX_GROUP_IMAGES} images. Remove one before adding another.`,
  duplicate:       'That image is already in this project group.',
  upload_failed:   'That image could not be stored. Try again.',
  unavailable:     'Image uploads are not configured on this deployment.',
  remove_locked:   'A candidate has already picked up a review using this project, so its images can no longer be changed.',
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

/**
 * The two questions every request here starts with, asked once.
 *
 * Active, and resolving `verify`. The role column is deliberately not selected:
 * managing the library is a verifier's action, and a verifier is somebody the
 * permission engine says holds `verify` — not somebody with a job title. Every
 * definer function this route calls resolves it again and is what decides.
 */
async function requireVerifier() {
  const caller = await createClient()
  const { data: { user }, error: authError } = await caller.auth.getUser()
  if (authError || !user) return { ok: false as const, response: fail(401, MESSAGES.unauthenticated) }

  const { data: profile } = await caller
    .from('users')
    .select('is_active')
    .eq('id', user.id)
    .single()
  if (!profile || profile.is_active !== true) {
    return { ok: false as const, response: fail(403, MESSAGES.forbidden) }
  }

  const { data: allowed } = await caller.rpc('resolve_permission', {
    p_user_id: user.id,
    p_module_key: 'customer_review_requests',
    p_action_key: 'verify',
  })
  if (allowed !== true) return { ok: false as const, response: fail(403, MESSAGES.forbidden) }

  return { ok: true as const, caller, userId: user.id }
}

export async function POST(req: NextRequest) {
  const auth = await requireVerifier()
  if (!auth.ok) return auth.response
  const { caller, userId } = auth

  // ── What was sent ─────────────────────────────────────────────────────────
  let groupId: string
  let bytes: Uint8Array
  let displayName: string
  try {
    const form = await req.formData()

    const rawId = form.get('groupId')
    if (typeof rawId !== 'string' || !UUID_RE.test(rawId)) return fail(400, MESSAGES.bad_request)
    groupId = rawId

    const file = form.get('file')
    if (!file || typeof file === 'string') return fail(400, MESSAGES.no_file)

    // The declared size is checked first so an oversized body is refused before
    // it is read into memory; the REAL length is checked again below, because
    // this one is still the client's claim.
    if ((file as File).size > GROUP_IMAGE_MAX_BYTES) {
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

  // ── May they add to THIS group ────────────────────────────────────────────
  //
  // Read as the caller. The group's SELECT policy decides, so a group they may
  // not see returns no row and this route cannot tell the difference between
  // "not yours" and "does not exist".
  const { data: group } = await caller
    .from('customer_review_image_groups')
    .select('id, archived_at')
    .eq('id', groupId)
    .maybeSingle()
  if (!group) return fail(404, MESSAGES.not_found)

  // ── What the bytes actually are ───────────────────────────────────────────
  //
  // The real length, the real container, and a container that accounts for the
  // whole file. This is what the browser's `file.type` was standing in for, and
  // it is the reason the stored mime_type is a fact rather than a claim.
  const processed = await processReviewImage(bytes, GROUP_IMAGE_MAX_BYTES)
  if (!processed.ok) {
    const message = processed.reason === 'undecodable' || processed.reason === 'too_many_pixels'
      ? PROCESSING_REJECTION_MESSAGES[processed.reason]
      : IMAGE_REJECTION_MESSAGES[processed.reason]
    return fail(processed.reason === 'too_large' ? 413 : 415, message)
  }

  // FROM HERE ON, `stored` is the file. The uploaded bytes are not written
  // anywhere, are not hashed, and are not described by the metadata row.
  const stored = processed.bytes

  const admin = adminClient()
  if (!admin.ok) {
    // The NAMES of the missing variables, never their values.
    console.error('[customer-reviews:image-groups] missing env:', admin.missing.join(', '))
    return fail(503, MESSAGES.unavailable)
  }
  const service = admin.client

  // Hashed over the STORED bytes, so two uploads of the same photograph that
  // differed only in metadata collapse to one image.
  const digest = createHash('sha256').update(stored).digest('hex')

  const { data: existing, error: existingError } = await service
    .from('customer_review_group_images')
    .select('id, content_sha256, removal_started_at')
    .eq('group_id', groupId)
  if (existingError) return fail(500, MESSAGES.upload_failed)

  // A row already marked for removal does not count against the limit: it is on
  // its way out, and every reader already treats it as gone.
  const live = (existing ?? []).filter(row => row.removal_started_at === null)

  // A COURTESY, NOT THE GUARANTEE, and here it really is only a courtesy. Two
  // concurrent uploads could both see nineteen. Unlike the four-slot rule on a
  // review, nothing depends on the exact count of a project group — twenty-one
  // photographs of a project is untidy, not wrong — so this is a bound on
  // storage enforced where it is cheap rather than a race to be closed with an
  // index. The DUPLICATE rule below is the one that has an index behind it.
  if (live.length >= MAX_GROUP_IMAGES) return fail(409, MESSAGES.too_many)

  // REPEATED CLICKS, answered by the content rather than by a timer, and backed
  // by customer_review_group_image_unique_live_content so the race is refused
  // by the table rather than by this read.
  if (live.some(row => row.content_sha256 === digest)) {
    return fail(409, MESSAGES.duplicate)
  }

  // ── The path, generated HERE ──────────────────────────────────────────────
  //
  // The group id first, because the storage SELECT policy reads ownership out
  // of split_part(name, '/', 1) and the metadata CHECK requires the two to
  // agree. Nothing the caller typed contributes a character.
  const storagePath = buildGroupImagePath(groupId, randomUUID(), extensionForGroupMime(processed.mime))

  const { error: uploadError } = await service.storage
    .from(GROUP_IMAGE_BUCKET)
    .upload(storagePath, stored, {
      // The re-encoded bytes, under the type they were encoded as. What is
      // stored and what is served are the same fact.
      contentType: processed.mime,
      upsert: false,
    })
  if (uploadError) return fail(500, MESSAGES.upload_failed)

  const { data: row, error: rowError } = await service
    .from('customer_review_group_images')
    .insert({
      group_id: groupId,
      storage_path: storagePath,
      // Display only, and bounded. The filename is the one thing the caller
      // supplies that is kept, and it never reaches a path or a response.
      file_name: displayName,
      mime_type: processed.mime,
      byte_size: stored.length,
      content_sha256: digest,
      uploaded_by: userId,
    })
    .select('id, group_id, storage_path, file_name, mime_type, byte_size, uploaded_by, uploaded_at, removal_started_at')
    .single()

  if (rowError || !row) {
    // COMPENSATION. The object exists and nothing points at it; the metadata
    // row is what makes it discoverable and what the path constraint checks.
    // Remove it before returning, so a failed add leaves the group exactly as
    // it was rather than leaving a file nobody can find again.
    await service.storage.from(GROUP_IMAGE_BUCKET).remove([storagePath])

    // 23505 here means another request registered these same bytes first.
    if (rowError?.code === '23505') return fail(409, MESSAGES.duplicate)
    return fail(500, MESSAGES.upload_failed)
  }

  return ok({ image: row })
}

// ══ REMOVING ONE ════════════════════════════════════════════════════════════
//
// ONE OPERATION, because it spans two systems and no transaction covers both.
// The three steps and the reasoning are the sibling routes', which this mirrors
// deliberately:
//
//   MARK    begin_customer_review_group_image_removal() re-checks the
//           authorization in SQL, REFUSES A GROUP A CANDIDATE IS ALREADY
//           WORKING FROM, locks the row and stamps removal_started_at. Every
//           read filters the row out from this moment.
//   OBJECT  the file is deleted from the private bucket.
//   ROW     finish_customer_review_group_image_removal() deletes the metadata.
//
// A FAILURE BETWEEN THEM IS EXPLICIT, and both functions are idempotent, so a
// retry converges from either half.

export async function DELETE(req: NextRequest) {
  const auth = await requireVerifier()
  if (!auth.ok) return auth.response
  const { caller, userId } = auth

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
    console.error('[customer-reviews:image-groups] missing env:', admin.missing.join(', '))
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
        .from('customer_review_group_images')
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
        'begin_customer_review_group_image_removal',
        { p_image_id: id, p_actor_id: actorId },
      )
      if (error) {
        // The database's own refusal codes, mapped to outcomes. The message
        // text is never forwarded.
        const code = error.message ?? ''
        if (code.includes('CUSTOMER_REVIEW_GROUP_IMAGE_NOT_FOUND')) return { outcome: 'gone' }
        if (code.includes('CUSTOMER_REVIEW_GROUP_IN_USE'))          return { outcome: 'locked' }
        if (code.includes('CUSTOMER_REVIEW_TEST_UNAUTHORIZED'))     return { outcome: 'forbidden' }
        return { outcome: 'error' }
      }
      const path = (data as { storage_path?: string } | null)?.storage_path
      if (typeof path !== 'string' || path.length === 0) return { outcome: 'error' }
      return { outcome: 'ready', storagePath: path }
    },

    async deleteObject(storagePath) {
      const { error } = await service.storage.from(GROUP_IMAGE_BUCKET).remove([storagePath])
      if (!error) return { ok: true, missing: false }
      return { ok: false, missing: isMissingObjectError(error) }
    },

    async finishRemoval(id) {
      const { error } = await service.rpc(
        'finish_customer_review_group_image_removal',
        { p_image_id: id },
      )
      return { ok: !error }
    },
  }

  return respondTo(await runPhotoRemoval({ reader, service: removal }, userId, imageId), imageId)
}

/**
 * One outcome, one response.
 *
 * `already_removed` is a 200 on purpose, and it is the same 200 a genuine
 * removal returns. A completed removal reporting as a failure was a defect a
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
