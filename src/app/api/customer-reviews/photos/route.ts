import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomUUID } from 'node:crypto'

import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { IMAGE_REJECTION_MESSAGES } from '@/lib/customerReviews/imageBytes'
import {
  PROCESSING_REJECTION_MESSAGES,
  processReviewImage,
} from '@/lib/customerReviews/imageProcessing'
import {
  MAX_TEST_SCREENSHOTS,
  TEST_SCREENSHOT_BUCKET,
  TEST_SCREENSHOT_MAX_BYTES,
  sanitizeDisplayName,
} from '@/lib/customerReviews/photos'
import {
  isMissingObjectError,
  runPhotoRemoval,
  type BeginResult,
  type PhotoRemovalService,
  type PhotoVisibilityReader,
  type RemovalOutcome,
} from '@/lib/customerReviews/photoRemovalFlow'

// THE ONLY WAY AN IMAGE ENTERS OR LEAVES THIS MODULE.
//
// POST adds one. DELETE removes one. Both are here because both are the same
// kind of thing: an operation that spans the private bucket and the metadata
// table, which no client may perform half of.
//
// WHAT THE IMAGE IS. A screenshot the tester took of their own WhatsApp screen
// after sending an internal test message. IT IS NOT PROOF OF A REVIEW — there
// is no review anywhere in this module — and it is not proof of delivery
// either. It is the artefact a verifier looks at to decide whether the WORKFLOW
// was exercised, and that is the only claim made about it.
//
// WHY A ROUTE AT ALL
// ------------------
// The first cut uploaded straight from the browser and recorded `file.type` and
// `file.size` as the stored mime_type and byte_size. Both are claims: the
// browser derives the type from the extension, the extension comes from whoever
// named the file, and the bucket's allowed_mime_types checks the Content-Type of
// the upload request — a third claim. Nothing had read a byte.
//
// So the storage INSERT policy and the metadata INSERT policy were withdrawn
// from `authenticated` (migration 20261017000000 §6 and §10). A browser can no
// longer write an object or register one. This route is the only writer, and it
// holds the service-role credential that makes it so.
//
// THE ORDER OF WORK, and it is the order that matters:
//
//   1. authenticate the caller, as the CALLER — not as the server;
//   2. resolve customer_review_requests.use for them;
//   3. read the card THROUGH THEIR OWN RLS, so a card they may not see does not
//      exist as far as this route is concerned;
//   4. apply the OWNERSHIP rule — `card.booked_by = the caller`, with no
//      administrator exception, because attaching and removing a screenshot are
//      tester actions — and the status rule (only while they still hold it);
//   5. read the whole file into memory, gate it structurally, then DECODE AND
//      RE-ENCODE it — the stored object is libvips output, never the upload;
//   6. only then upload, to a path this server generates;
//   7. insert the metadata describing the RE-ENCODED bytes;
//   8. if that insert fails, remove the object again.
//
// NOTHING THE CLIENT SENDS NAMES A LOCATION. The body carries a card id, a
// kind, and a file. The bucket is a constant, the object key is generated here
// from the card id and a fresh uuid, and `uploaded_by` is the authenticated
// user — never a field. A caller cannot choose where their bytes land, cannot
// write into another card's folder, and cannot register somebody else's object.
//
// PRIVACY. No response and no log line carries a filename, a phone number, a
// signed URL, a storage path or a byte of content. Rejections are prewritten
// sentences chosen from a closed set (IMAGE_REJECTION_MESSAGES); an
// unanticipated failure contributes no text of its own.

export const runtime = 'nodejs'

/** Reading and hashing a 5 MB image is fast, but not instant on a cold start. */
export const maxDuration = 30

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * ONE KIND, and nothing else.
 *
 * Kept as a list rather than collapsed to a literal because it is what the
 * request body is validated against, and a list of one is the shape that stays
 * correct if a second kind is ever justified. There are no project photographs
 * and no review proof here: there are no projects and no reviews.
 */
const KINDS = ['test_screenshot'] as const
type PhotoKind = (typeof KINDS)[number]

/**
 * Every sentence this route can return, and it returns nothing else.
 *
 * An allow-list rather than a formatter: the alternative is a template that one
 * day interpolates an error somebody forgot was attacker-influenced.
 */
const MESSAGES = {
  unauthenticated: 'Sign in to continue.',
  forbidden:       'You do not have permission to attach a screenshot to this review.',
  not_found:       'That review is not available.',
  wrong_status:    'A screenshot can only be attached while you still hold the card.',
  no_file:         'No file was received.',
  bad_request:     'That request could not be processed.',
  too_many:        `You can attach ${MAX_TEST_SCREENSHOTS} screenshot per review. Remove the current one first.`,
  duplicate:       'That screenshot is already attached to this review.',
  upload_failed:   'That screenshot could not be stored. Try again.',
  unavailable:     'Screenshot uploads are not configured on this deployment.',
  remove_locked:   'This test has been handed over, so its screenshot is frozen. Ask a verifier to return the card if it needs changing.',
  remove_failed:   'That screenshot could not be removed. Try again.',
  remove_partial:  'The image was removed but the record could not be updated. Try again.',
} as const

const fail = (status: number, message: string) =>
  NextResponse.json({ error: message }, {
    status,
    // Private data, and a per-caller answer. Nothing about this response may be
    // cached by a proxy or a browser.
    headers: { 'Cache-Control': 'no-store, private' },
  })

const ok = (body: Record<string, unknown>) =>
  NextResponse.json(body, { status: 200, headers: { 'Cache-Control': 'no-store, private' } })

export async function POST(req: NextRequest) {
  // ── 1. Who is calling ─────────────────────────────────────────────────────
  //
  // The cookie-scoped client, so this is the signed-in browser session and not
  // a token somebody put in a header.
  const caller = await createClient()
  const { data: { user }, error: authError } = await caller.auth.getUser()
  if (authError || !user) return fail(401, MESSAGES.unauthenticated)

  // ── 2. Are they active, and do they hold `use` ────────────────────────────
  const { data: profile } = await caller
    .from('users')
    .select('is_active')
    .eq('id', user.id)
    .single()
  if (!profile || profile.is_active !== true) return fail(403, MESSAGES.forbidden)

  // THE RESOLVED PERMISSION, FOR EVERY CALLER, WITH NO SHORTCUT.
  //
  // This used to read `if (!isAdmin) { …resolve… }`. Attaching a screenshot is
  // a tester action, so it needs `use` — and an administrator whose `use` had
  // been revoked was admitted here without the engine being asked, then
  // stopped only by the ownership check below. Two different reasons to refuse,
  // and the one that fired was the wrong one.
  //
  // The role is no longer read at all: the profile select above asks for
  // is_active and nothing else.
  const { data: allowed } = await caller.rpc('resolve_permission', {
    p_user_id: user.id,
    p_module_key: 'customer_review_requests',
    p_action_key: 'use',
  })
  if (allowed !== true) return fail(403, MESSAGES.forbidden)

  // ── 3. What was sent ──────────────────────────────────────────────────────
  let cardId: string
  let kind: PhotoKind
  let bytes: Uint8Array
  let displayName: string
  try {
    const form = await req.formData()

    const rawId = form.get('cardId')
    if (typeof rawId !== 'string' || !UUID_RE.test(rawId)) return fail(400, MESSAGES.bad_request)
    cardId = rawId

    const rawKind = form.get('kind')
    if (typeof rawKind !== 'string' || !(KINDS as readonly string[]).includes(rawKind)) {
      return fail(400, MESSAGES.bad_request)
    }
    kind = rawKind as PhotoKind

    const file = form.get('file')
    if (!file || typeof file === 'string') return fail(400, MESSAGES.no_file)

    // The declared size is checked first so an oversized body is refused before
    // it is read into memory; the REAL length is checked again below, because
    // this one is still the client's claim.
    if ((file as File).size > TEST_SCREENSHOT_MAX_BYTES) {
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

  // ── 4. May they attach to THIS card ───────────────────────────────────────
  //
  // Read as the caller. The card's SELECT policy decides, so a card belonging
  // to somebody else returns no row and this route cannot tell the difference
  // between "not yours" and "does not exist" — which is the answer the tester
  // should get too.
  const { data: card } = await caller
    .from('customer_review_test_cards')
    .select('id, status, booked_by')
    .eq('id', cardId)
    .maybeSingle()
  if (!card) return fail(404, MESSAGES.not_found)

  // THE HOLDER, AND ONLY THE HOLDER — no administrator branch.
  //
  // Attaching a screenshot is a tester action, so being an administrator does
  // not authorise doing it on a card somebody else booked. RLS lets a verifier
  // and an admin READ every card, which is what verification needs; reading is
  // not holding, and this is the line that says so.
  if (card.booked_by !== user.id) return fail(403, MESSAGES.forbidden)

  // WHILE THEY STILL HOLD IT, and no later. Once a card is submitted the
  // evidence is what a verifier is about to look at, and once it is verified
  // the evidence is what they looked at; neither may change underneath them.
  // Mirrors begin_customer_review_test_screenshot_removal()'s status rule on
  // the removal side, so a screenshot can be added and withdrawn in exactly the
  // same window.
  if (card.status !== 'booked') return fail(409, MESSAGES.wrong_status)

  // ── 5. What the bytes actually are ────────────────────────────────────────
  //
  // The real length, the real container, and a container that accounts for the
  // whole file. This is the check that the browser's `file.type` was standing
  // in for, and it is the reason the stored mime_type is now a fact.
  const processed = await processReviewImage(bytes, TEST_SCREENSHOT_MAX_BYTES)
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
    // The NAMES of the missing variables, never their values, and only to the
    // server log — the caller is told the deployment is not configured.
    console.error('[customer-reviews:photos] missing env:', admin.missing.join(', '))
    return fail(503, MESSAGES.unavailable)
  }
  const service = admin.client

  // ── 7. Limits that need the existing rows ─────────────────────────────────
  // Hashed over the STORED bytes, so two uploads of the same screenshot that
  // differed only in metadata collapse to one attachment.
  const digest = createHash('sha256').update(stored).digest('hex')

  const { data: existing, error: existingError } = await service
    .from('customer_review_test_card_screenshots')
    .select('id, content_sha256, removal_started_at')
    .eq('card_id', cardId)
  if (existingError) return fail(500, MESSAGES.upload_failed)

  // A row already marked for removal does not count against the limit and is
  // not a duplicate: it is on its way out, and every reader already treats it
  // as gone. Counting it would make a failed removal permanently block the
  // replacement it exists to allow.
  const live = (existing ?? []).filter(row => row.removal_started_at === null)

  // ── THIS COUNT IS A COURTESY, NOT THE GUARANTEE ───────────────────────────
  //
  // It is a READ FOLLOWED BY A WRITE. Two concurrent uploads with different
  // content both read zero here and both proceed — the count is correct for
  // each request and wrong for the card. No amount of care at this point fixes
  // that.
  //
  // What fixes it is a partial unique index in the database
  // (customer_review_screenshot_one_live_per_card, migration 20261017000000
  // §4): the second inserter blocks on the index and fails with 23505. Step 9
  // below turns that into the SAME sentence this check produces, so a tester
  // sees one answer however the race went.
  //
  // The check stays because it is cheaper and kinder: it refuses before five
  // megabytes are decoded, re-encoded and uploaded.
  if (live.length >= MAX_TEST_SCREENSHOTS) return fail(409, MESSAGES.too_many)

  // REPEATED CLICKS, answered by the content rather than by a timer. Two
  // requests carrying identical bytes for the same card are one upload; the
  // second is refused whatever raced with what, and a genuinely different image
  // is never blocked. Backed by its own partial unique index for the same
  // reason as above.
  if (live.some(row => row.content_sha256 === digest)) {
    return fail(409, MESSAGES.duplicate)
  }

  // ── 8. The path, generated HERE ───────────────────────────────────────────
  //
  // The card id first, because the storage SELECT policy reads ownership out of
  // split_part(name, '/', 1) and the metadata CHECK requires the two to agree.
  // Nothing the caller typed contributes a character.
  const extension = processed.mime === 'image/jpeg' ? 'jpg'
    : processed.mime === 'image/png' ? 'png'
    : 'webp'
  const storagePath = `${cardId}/${kind}/${randomUUID()}.${extension}`

  const { error: uploadError } = await service.storage
    .from(TEST_SCREENSHOT_BUCKET)
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
      kind,
      storage_path: storagePath,
      // Display only, and bounded. The filename is the one thing the caller
      // supplies that is kept, and it never reaches a path or a response.
      file_name: displayName,
      mime_type: processed.mime,
      byte_size: stored.length,
      content_sha256: digest,
      uploaded_by: user.id,
    })
    .select('id, kind, storage_path, file_name, mime_type, byte_size, uploaded_by, uploaded_at')
    .single()

  if (rowError || !row) {
    // COMPENSATION. The object exists and nothing points at it; the metadata row
    // is what makes it discoverable and what the path constraint checks. Remove
    // it before returning, so a failed attach leaves the card exactly as it was
    // rather than leaving a file nobody can find again.
    await service.storage.from(TEST_SCREENSHOT_BUCKET).remove([storagePath])

    // ── THE RACE, ARRIVING AS A UNIQUE VIOLATION ────────────────────────────
    //
    // 23505 here means another request won: either it registered a live
    // screenshot for this card first (one-live-per-card), or it registered
    // these same bytes first (unique-live-content). Both are the states the
    // count in step 7 was trying to prevent and could not, because it read
    // before it wrote.
    //
    // The loser is told exactly what the count would have told it, so the
    // outcome does not depend on which check caught it. The two indexes are
    // distinguished by NAME rather than by guessing from the message text.
    if (rowError?.code === '23505') {
      const constraint = `${rowError.message ?? ''} ${rowError.details ?? ''}`
      return fail(409, constraint.includes('unique_live_content')
        ? MESSAGES.duplicate
        : MESSAGES.too_many)
    }
    return fail(500, MESSAGES.upload_failed)
  }

  return ok({ photo: { ...row, card_id: cardId } })
}

// ══ REMOVING ONE ════════════════════════════════════════════════════════════
//
// ONE OPERATION, because it spans two systems and no transaction covers both.
//
// A browser can no longer delete either half: the metadata table has no DELETE
// policy and no DELETE privilege for `authenticated`, and the bucket has no
// DELETE policy at all (migration 20261017000000 §6 and §10). Half a removal
// is how an orphaned object or a permanently broken preview gets made, so
// neither half is separately reachable.
//
// THE THREE STEPS, and the middle one is why there are three:
//
//   MARK    begin_customer_review_test_screenshot_removal() re-checks the authorization
//           in SQL, locks the row, and stamps removal_started_at/removal_by.
//           Every read filters the row out from this moment, so the
//           photograph is already gone as far as the application is
//           concerned.
//   OBJECT  the file is deleted from the private bucket.
//   ROW     finish_customer_review_test_screenshot_removal() deletes the metadata, and
//           the delete trigger writes the photo_removed entry to the
//           append-only trail — crediting removal_by, because the delete
//           itself arrives through the service role where auth.uid() is null.
//
// A FAILURE BETWEEN THEM IS EXPLICIT. If the object deletion fails, the row
// stays marked and still names its path, so nothing is orphaned and a retry
// converges. If the row deletion fails, the caller is told the image is gone
// but the record is not — which is true, and which a retry also converges,
// because both functions are idempotent.

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

  // `use` is required even of an admin correcting somebody else's upload —
  // an administrator who does not hold the module has no business in it. The
  // role short-circuit that follows is about WHOSE photograph they may touch.
  // THE RESOLVED PERMISSION, FOR EVERY CALLER — the DELETE half of the same
  // correction. Withdrawing a screenshot is a tester action too, and
  // begin_customer_review_test_screenshot_removal() resolves `use` with no
  // administrator branch, so admitting one here was a promise the definer
  // function was never going to keep.
  const { data: allowed } = await caller.rpc('resolve_permission', {
    p_user_id: user.id,
    p_module_key: 'customer_review_requests',
    p_action_key: 'use',
  })
  if (allowed !== true) return fail(403, MESSAGES.forbidden)

  let photoId: string
  try {
    const body = await req.json()
    const raw = body?.photoId
    if (typeof raw !== 'string' || !UUID_RE.test(raw)) return fail(400, MESSAGES.bad_request)
    photoId = raw
  } catch {
    return fail(400, MESSAGES.bad_request)
  }

  const admin = adminClient()
  if (!admin.ok) {
    console.error('[customer-reviews:photos] missing env:', admin.missing.join(', '))
    return fail(503, MESSAGES.unavailable)
  }
  const service = admin.client

  // THE RESUME READ, and it is deliberately unlike every other read in this
  // module: it does NOT filter `removal_started_at`.
  //
  // Marking a row hides it from every list and detail screen — that is what
  // marking is for. But this is the path that finishes an interrupted removal,
  // and a resume that could not see the thing it is resuming would be no
  // resume at all. The omission used to be accidental; it is now deliberate,
  // and photoRemovalRetry.test.ts fails if anybody adds the filter here.
  //
  // It still runs as the CALLER, so their own RLS decides. What it does NOT do
  // is turn "no row" into a distinct answer — see runPhotoRemoval.
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
        'begin_customer_review_test_screenshot_removal',
        { p_screenshot_id: id, p_actor_id: actorId },
      )
      if (error) {
        // The database's own refusal codes, mapped to outcomes. The message
        // text is never forwarded: it is written for a person, but it is not
        // this route's to choose.
        const code = error.message ?? ''
        if (code.includes('CUSTOMER_REVIEW_TEST_SCREENSHOT_NOT_FOUND')) return { outcome: 'gone' }
        if (code.includes('CUSTOMER_REVIEW_TEST_LOCKED')) return { outcome: 'locked' }
        if (code.includes('CUSTOMER_REVIEW_TEST_UNAUTHORIZED')) return { outcome: 'forbidden' }
        return { outcome: 'error' }
      }
      const path = (data as { storage_path?: string } | null)?.storage_path
      if (typeof path !== 'string' || path.length === 0) return { outcome: 'error' }
      return { outcome: 'ready', storagePath: path }
    },

    async deleteObject(storagePath) {
      const { error } = await service.storage.from(TEST_SCREENSHOT_BUCKET).remove([storagePath])
      if (!error) return { ok: true, missing: false }
      return { ok: false, missing: isMissingObjectError(error) }
    },

    async finishRemoval(id) {
      const { error } = await service.rpc('finish_customer_review_test_screenshot_removal', { p_screenshot_id: id })
      return { ok: !error }
    },
  }

  return respondTo(await runPhotoRemoval({ reader, service: removal }, user.id, photoId), photoId)
}

/**
 * One outcome, one response.
 *
 * `already_removed` is a 200 on purpose, and it is the same 200 a genuine
 * removal returns. A completed removal reporting as a failure was the defect;
 * a completed removal reporting DIFFERENTLY from an unresolvable id would be a
 * disclosure. Both are answered here, identically.
 */
function respondTo(outcome: RemovalOutcome, photoId: string) {
  switch (outcome.status) {
    case 'removed':
    case 'already_removed':
      return ok({ removed: photoId })
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
// MOVED TO src/lib/customerReviews/photos.ts, and re-exported here so the
// import path uploadRoute.test.ts already uses keeps working. It moved because
// /api/customer-reviews/images needs the identical function, and a route
// importing another route to get a pure string helper is a dependency nothing
// gains from.
export { sanitizeDisplayName }
