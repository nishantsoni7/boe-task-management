import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { istToday } from '@/lib/istDate'
import { IMAGE_REJECTION_MESSAGES } from '@/lib/customerReviews/imageBytes'
import {
  PROCESSING_REJECTION_MESSAGES,
  processReviewImage,
} from '@/lib/customerReviews/imageProcessing'
import { TEST_SCREENSHOT_MAX_BYTES, sanitizeDisplayName } from '@/lib/customerReviews/photos'
import {
  CUSTOM_PROOF_BUCKET,
  customSubmissionErrorMessage,
  customSubmissionFailureStatus,
  parseCustomReapplicationInput,
  parseCustomSubmissionInput,
  parseMatchFields,
} from '@/lib/customerReviews/customSubmissions'
import { differenceHash } from '@/lib/customerReviews/imageHash'
import {
  DUPLICATE_UNAVAILABLE_TITLE,
  DUPLICATE_WARNING_TITLE,
} from '@/lib/customerReviews/duplicateDetection'
import {
  contentFingerprint,
  normalizedFields,
  runDuplicateCheck,
  toDatabaseArgument,
  toEmployeeView,
  type DuplicateOutcome,
} from '@/lib/customerReviews/duplicateCheck.server'
import {
  istMonthBoundsUtc,
  istMonthOf,
  monthRulesFromSettings,
  submissionAllowance,
} from '@/lib/customerReviews/customMonthlyRules'
import { parseBoeCreditSettingsRow } from '@/lib/boeCredits/settings'

// POST  /api/customer-reviews/custom-submissions — Submit Custom Review.
// PATCH /api/customer-reviews/custom-submissions — Reapply for Approval.
//
// An employee hands over proof that a review THEY arranged was published: the
// type, the published date, an optional remark and a screenshot. The record is
// created Pending Approval; nothing here — and nothing a browser can call —
// awards a credit. A verifier approves or rejects it through the definer RPCs,
// and a rejected review is corrected and reapplied, on the SAME row, by PATCH.
//
// WHY A ROUTE. The screenshot spans the private bucket and the metadata row,
// and no client role may write either (no storage INSERT policy, no table
// INSERT privilege). The same byte pipeline as /api/customer-reviews/photos:
//
//   1. authenticate the caller from their own session;
//   2. resolve customer_review_requests.use — the permission to do review work;
//   3. validate the fields (parseCustomSubmissionInput, the form's own rules),
//      and — before anything is uploaded — the monthly rules, as a courtesy;
//   4. read the file, DECODE AND RE-ENCODE it — the stored object is libvips
//      output, never the upload;
//   5. upload under a path generated here from a fresh submission id;
//   6. register it through create_customer_review_custom_submission() on the
//      service role, with the actor taken from step 1 — never from the form.
//      The database applies the monthly cap and the image mix under a lock;
//   7. if registration fails, remove the object again.
//
// NOTHING THE CLIENT SENDS NAMES A PERSON OR A LOCATION. The body carries a
// type, a date, a remark and a file (and, to reapply, the review's own id). The
// submitter is the session's user, the bucket is a constant and the object key
// is generated.

export const runtime = 'nodejs'

/** Reading and re-encoding a 5 MB image is fast, but not instant on a cold start. */
export const maxDuration = 30

const MESSAGES = {
  unauthenticated: 'Sign in to continue.',
  forbidden:       'You do not have permission to submit a custom review.',
  bad_request:     'That request could not be processed.',
  upload_failed:   'That screenshot could not be stored. Try again.',
  unavailable:     'Screenshot uploads are not configured on this deployment.',
  failed:          'That submission could not be saved. Try again.',
  not_found:       'That review could not be found.',
  not_rejected:    'Only a rejected review can be reapplied.',
  not_editable:    'A rejected review is corrected with Edit & Reapply.',
} as const

const NO_STORE = { 'Cache-Control': 'no-store, private' }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const fail = (status: number, message: string) =>
  NextResponse.json({ error: message }, { status, headers: NO_STORE })

type Caller = Awaited<ReturnType<typeof createClient>>

/** Steps 1 and 2, shared: the active session user holding `use`, or a refusal. */
async function authorize(caller: Caller): Promise<{ userId: string } | NextResponse> {
  const { data: { user }, error: authError } = await caller.auth.getUser()
  if (authError || !user) return fail(401, MESSAGES.unauthenticated)

  const { data: profile } = await caller
    .from('users')
    .select('is_active')
    .eq('id', user.id)
    .single()
  if (!profile || profile.is_active !== true) return fail(403, MESSAGES.forbidden)

  // Resolved for every caller; the role is not read. The database asks again.
  const { data: allowed } = await caller.rpc('resolve_permission', {
    p_user_id: user.id,
    p_module_key: 'customer_review_requests',
    p_action_key: 'use',
  })
  if (allowed !== true) return fail(403, MESSAGES.forbidden)
  return { userId: user.id }
}

/** A database refusal, in the database's own prewritten words, which name nobody. */
function failFromDatabase(raw: string): NextResponse {
  const status = customSubmissionFailureStatus(raw)
  return status == null ? fail(500, MESSAGES.failed) : fail(status, customSubmissionErrorMessage(raw, MESSAGES.failed))
}

/** Step 4, shared: the re-encoded bytes, or the refusal a person can act on. */
async function processProof(proof: File): Promise<
  | { ok: true; bytes: Uint8Array; mime: 'image/jpeg' | 'image/png' | 'image/webp'; displayName: string; digest: string; extension: string }
  | { ok: false; response: NextResponse }
> {
  // The declared size first, so an oversized body is refused before it is read.
  if (proof.size > TEST_SCREENSHOT_MAX_BYTES) return { ok: false, response: fail(413, IMAGE_REJECTION_MESSAGES.too_large) }

  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await proof.arrayBuffer())
  } catch {
    return { ok: false, response: fail(400, MESSAGES.bad_request) }
  }

  const processed = await processReviewImage(bytes, TEST_SCREENSHOT_MAX_BYTES)
  if (!processed.ok) {
    const message = processed.reason === 'undecodable' || processed.reason === 'too_many_pixels'
      ? PROCESSING_REJECTION_MESSAGES[processed.reason]
      : IMAGE_REJECTION_MESSAGES[processed.reason]
    return { ok: false, response: fail(processed.reason === 'too_large' ? 413 : 415, message) }
  }
  const stored = processed.bytes
  return {
    ok: true,
    bytes: stored,
    mime: processed.mime,
    displayName: sanitizeDisplayName(proof.name),
    digest: createHash('sha256').update(stored).digest('hex'),
    extension: processed.mime === 'image/jpeg' ? 'jpg' : processed.mime === 'image/png' ? 'png' : 'webp',
  }
}

// ── The duplicate check ───────────────────────────────────────────────────────
//
// Runs on every save that changes what a review says or shows — the server is
// what decides, whatever the browser already showed. A possible duplicate (or a
// check that could not run) is answered 409 with the reason CATEGORIES and a
// token, BEFORE anything is uploaded or stored; the employee then edits, cancels
// or resends with `acknowledgeDuplicate` = that token ("Submit anyway"). The
// token binds the choice to the warning that was shown: if the matches changed in
// between, the employee is warned again. The database refuses a flagged or
// unavailable result the employee did not acknowledge, and stores the matches,
// the reasons and that the employee proceeded.
//
// A warning never rejects a review and never touches a reward.

type SavedRow = { sha256: string; phash: string | null }

type DuplicateGate =
  | { block: NextResponse }
  | {
      /** The database argument, or null when the content is the same as the last check. */
      argument: ReturnType<typeof toDatabaseArgument> | null
      phash: string | null
      nameNorm: string | null
      textNorm: string | null
    }

async function duplicateGate(args: {
  service: SupabaseClient
  actorId: string
  /** The review being edited or reapplied. */
  submissionId: string | null
  reviewerName: string | null
  reviewText: string | null
  /** A newly chosen screenshot, or null to keep the saved one. */
  image: { digest: string; bytes: Uint8Array } | null
  acknowledged: string | null
}): Promise<DuplicateGate> {
  const { nameNorm, textNorm } = normalizedFields(args.reviewerName, args.reviewText)

  let saved: SavedRow | null = null
  let lastFingerprint: string | null = null
  if (args.submissionId) {
    const { data: row } = await args.service
      .from('customer_review_custom_submissions')
      .select('proof_content_sha256, proof_phash')
      .eq('id', args.submissionId)
      .maybeSingle()
    const r = row as { proof_content_sha256: string; proof_phash: string | null } | null
    if (r) saved = { sha256: r.proof_content_sha256, phash: r.proof_phash }
    const { data: last } = await args.service
      .from('customer_review_custom_duplicate_checks')
      .select('content_fingerprint')
      .eq('submission_id', args.submissionId)
      .order('seq', { ascending: false })
      .limit(1)
      .maybeSingle()
    lastFingerprint = (last as { content_fingerprint: string } | null)?.content_fingerprint ?? null
  }

  let phash: string | null = saved?.phash ?? null
  let hashFailed = false
  let sha256 = saved?.sha256 ?? ''
  if (args.image) {
    sha256 = args.image.digest
    try {
      phash = await differenceHash(args.image.bytes)
    } catch {
      phash = null
      hashFailed = true
    }
  }
  if (!sha256) hashFailed = true

  // Content the last check already covered: nothing new to warn about.
  const fingerprint = contentFingerprint(sha256, nameNorm, textNorm)
  if (!hashFailed && lastFingerprint === fingerprint) {
    return { argument: null, phash: args.image ? phash : null, nameNorm, textNorm }
  }

  const outcome: DuplicateOutcome = hashFailed
    ? { status: 'unavailable', matches: [], fingerprint, token: 'unavailable', refs: new Map() }
    : await runDuplicateCheck({
        service: args.service,
        actorId: args.actorId,
        excludeId: args.submissionId,
        reviewerName: args.reviewerName,
        reviewText: args.reviewText,
        sha256,
        phash,
      })

  if (outcome.status !== 'clear' && args.acknowledged !== outcome.token) {
    return {
      block: NextResponse.json(
        {
          error: outcome.status === 'unavailable' ? DUPLICATE_UNAVAILABLE_TITLE : DUPLICATE_WARNING_TITLE,
          code: 'possible_duplicate',
          duplicate: toEmployeeView(outcome, args.actorId),
          token: outcome.token,
        },
        { status: 409, headers: NO_STORE },
      ),
    }
  }

  return {
    argument: toDatabaseArgument(outcome, outcome.status !== 'clear'),
    phash: args.image ? phash : null,
    nameNorm,
    textNorm,
  }
}

/** The fields every save reads besides the ones each verb already parses. */
function readMatchFields(form: FormData):
  | { ok: true; reviewerName: string | null; reviewText: string | null; acknowledged: string | null }
  | { ok: false; response: NextResponse } {
  const parsed = parseMatchFields({ reviewerName: form.get('reviewerName'), reviewText: form.get('reviewText') })
  if (!parsed.ok) return { ok: false, response: fail(422, parsed.message) }
  const ack = form.get('acknowledgeDuplicate')
  return {
    ok: true,
    reviewerName: parsed.value.reviewerName,
    reviewText: parsed.value.reviewText,
    acknowledged: typeof ack === 'string' && ack !== '' ? ack : null,
  }
}

export async function POST(req: NextRequest) {
  // ── 1–2. Who is calling, and do they hold `use` ───────────────────────────
  const caller = await createClient()
  const auth = await authorize(caller)
  if (auth instanceof NextResponse) return auth
  const user = { id: auth.userId }

  // ── 3. What was sent ──────────────────────────────────────────────────────
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return fail(400, MESSAGES.bad_request)
  }

  const file = form.get('file')
  const proof = file && typeof file !== 'string' && (file as File).size > 0 ? (file as File) : null

  const parsed = parseCustomSubmissionInput({
    reviewType:  form.get('reviewType'),
    publishedOn: form.get('publishedOn'),
    remark:      form.get('remark'),
    hasProof:    proof !== null,
  }, istToday())
  if (!parsed.ok || !proof) return fail(422, parsed.ok ? MESSAGES.bad_request : parsed.issues[0].message)

  // ── 3b. The monthly rules, before five megabytes are uploaded ─────────────
  // A COURTESY, NOT THE BOUNDARY: the registration re-counts under a lock and
  // is what decides. Read through the caller's own RLS (their rows; the
  // settings every employee may read). If either read fails, the database is
  // left to answer.
  const { from, to } = istMonthBoundsUtc(istMonthOf(new Date()))
  const [mine, settingsRow] = await Promise.all([
    caller
      .from('customer_review_custom_submissions')
      .select('review_type')
      .eq('submitted_by', user.id)
      .gte('submitted_at', from)
      .lt('submitted_at', to),
    caller
      .from('boe_credit_settings')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])
  if (!mine.error && !settingsRow.error && settingsRow.data) {
    const settings = parseBoeCreditSettingsRow(settingsRow.data as Record<string, unknown>)
    if (settings.ok) {
      const rows = (mine.data ?? []) as { review_type: string }[]
      const allowance = submissionAllowance(
        { submitted: rows.length, imageReviews: rows.filter(r => r.review_type === 'image').length },
        monthRulesFromSettings(settings.settings),
      )
      if (!allowance.canSubmitAny) return fail(422, allowance.limitMessage ?? MESSAGES.failed)
      if (parsed.value.reviewType === 'text' && !allowance.canSubmitText) {
        return fail(422, allowance.textBlockedMessage ?? MESSAGES.failed)
      }
    }
  }

  const match = readMatchFields(form)
  if (!match.ok) return match.response

  // ── 4. What the bytes actually are ────────────────────────────────────────
  const image = await processProof(proof)
  if (!image.ok) return image.response

  // ── 5. The privileged client, the duplicate check, and the path generated HERE
  const admin = adminClient()
  if (!admin.ok) {
    console.error('[customer-reviews:custom-submissions] missing env:', admin.missing.join(', '))
    return fail(503, MESSAGES.unavailable)
  }
  const service = admin.client

  const gate = await duplicateGate({
    service, actorId: user.id, submissionId: null,
    reviewerName: match.reviewerName, reviewText: match.reviewText,
    image: { digest: image.digest, bytes: image.bytes }, acknowledged: match.acknowledged,
  })
  if ('block' in gate) return gate.block

  const submissionId = randomUUID()
  // The submission id first: the bucket's SELECT policy reads it, and the
  // table's CHECK requires the two to agree.
  const storagePath = `${submissionId}/proof/${randomUUID()}.${image.extension}`

  const { error: uploadError } = await service.storage
    .from(CUSTOM_PROOF_BUCKET)
    .upload(storagePath, image.bytes, { contentType: image.mime, upsert: false })
  if (uploadError) return fail(500, MESSAGES.upload_failed)

  // ── 6. Registration, with the actor from the session ──────────────────────
  const { data, error } = await service.rpc('create_customer_review_custom_submission', {
    p_submission_id:        submissionId,
    p_actor_id:             user.id,
    p_review_type:          parsed.value.reviewType,
    p_published_on:         parsed.value.publishedOn,
    p_remark:               parsed.value.remark,
    p_proof_storage_path:   storagePath,
    p_proof_file_name:      image.displayName,
    p_proof_mime_type:      image.mime,
    p_proof_byte_size:      image.bytes.length,
    p_proof_content_sha256: image.digest,
    p_reviewer_name:        match.reviewerName,
    p_review_text:          match.reviewText,
    p_reviewer_name_norm:   gate.nameNorm,
    p_review_text_norm:     gate.textNorm,
    p_proof_phash:          gate.phash,
    p_duplicate:            gate.argument,
  })

  if (error || !data) {
    // ── 7. Compensation: a failed registration leaves no orphaned object ───
    await service.storage.from(CUSTOM_PROOF_BUCKET).remove([storagePath])
    return failFromDatabase(error?.message ?? '')
  }

  return NextResponse.json({ submission: data }, { status: 200, headers: NO_STORE })
}

// ── Reapply for Approval ──────────────────────────────────────────────────────
//
// THE SAME ROW. The employee's own rejected review goes back to Pending
// Approval with their corrections and an optional note. The screenshot is
// optional: without one the current proof stays; with one it is re-encoded and
// stored beside the old, which is KEPT — the history names it.
//
// reapply_customer_review_custom_submission() decides, on the service role with
// the session's actor: ownership, rejected-only, the image mix if the type
// changes, a closed month. A retry of a reapplication that already went through
// comes back `already_pending` and changes nothing.

export async function PATCH(req: NextRequest) {
  const caller = await createClient()
  const auth = await authorize(caller)
  if (auth instanceof NextResponse) return auth
  const actorId = auth.userId

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return fail(400, MESSAGES.bad_request)
  }

  const submissionId = form.get('submissionId')
  if (typeof submissionId !== 'string' || !UUID_RE.test(submissionId)) return fail(400, MESSAGES.bad_request)

  const parsed = parseCustomReapplicationInput({
    reviewType:  form.get('reviewType'),
    publishedOn: form.get('publishedOn'),
    remark:      form.get('remark'),
    note:        form.get('note'),
  }, istToday())
  if (!parsed.ok) return fail(422, parsed.issues[0].message)

  // Read AS THE CALLER, before any upload. RLS returns only rows they may see;
  // a review that is not theirs is answered exactly like one that does not
  // exist. The database checks ownership again.
  const { data: current } = await caller
    .from('customer_review_custom_submissions')
    .select('id, submitted_by, status')
    .eq('id', submissionId)
    .maybeSingle()
  const row = current as { id: string; submitted_by: string; status: string } | null
  if (!row || row.submitted_by !== actorId) return fail(404, MESSAGES.not_found)
  if (row.status === 'approved') return fail(409, MESSAGES.not_rejected)

  const match = readMatchFields(form)
  if (!match.ok) return match.response

  const file = form.get('file')
  const proof = file && typeof file !== 'string' && (file as File).size > 0 ? (file as File) : null
  const image = proof ? await processProof(proof) : null
  if (image && !image.ok) return image.response

  const admin = adminClient()
  if (!admin.ok) {
    console.error('[customer-reviews:custom-submissions] missing env:', admin.missing.join(', '))
    return fail(503, MESSAGES.unavailable)
  }
  const service = admin.client

  const gate = await duplicateGate({
    service, actorId, submissionId,
    reviewerName: match.reviewerName, reviewText: match.reviewText,
    image: image && image.ok ? { digest: image.digest, bytes: image.bytes } : null, acknowledged: match.acknowledged,
  })
  if ('block' in gate) return gate.block

  // Under this review's own id, so the bucket policy and the table CHECK agree.
  const newPath = image && image.ok ? `${submissionId}/proof/${randomUUID()}.${image.extension}` : null
  if (image && image.ok && newPath) {
    const { error: uploadError } = await service.storage
      .from(CUSTOM_PROOF_BUCKET)
      .upload(newPath, image.bytes, { contentType: image.mime, upsert: false })
    if (uploadError) return fail(500, MESSAGES.upload_failed)
  }

  const { data, error } = await service.rpc('reapply_customer_review_custom_submission', {
    p_submission_id:        submissionId,
    p_actor_id:             actorId,
    p_review_type:          parsed.value.reviewType,
    p_published_on:         parsed.value.publishedOn,
    p_remark:               parsed.value.remark,
    p_candidate_note:       parsed.value.note,
    p_proof_storage_path:   newPath,
    p_proof_file_name:      image && image.ok ? image.displayName : null,
    p_proof_mime_type:      image && image.ok ? image.mime : null,
    p_proof_byte_size:      image && image.ok ? image.bytes.length : null,
    p_proof_content_sha256: image && image.ok ? image.digest : null,
    p_reviewer_name:        match.reviewerName,
    p_review_text:          match.reviewText,
    p_reviewer_name_norm:   gate.nameNorm,
    p_review_text_norm:     gate.textNorm,
    p_proof_phash:          gate.phash,
    p_duplicate:            gate.argument,
  })

  const result = data as { submission?: unknown; already_pending?: boolean } | null
  if (error || !result) {
    if (newPath) await service.storage.from(CUSTOM_PROOF_BUCKET).remove([newPath])
    return failFromDatabase(error?.message ?? '')
  }
  // A retry that found the review already pending did not use the new object.
  if (result.already_pending && newPath) {
    await service.storage.from(CUSTOM_PROOF_BUCKET).remove([newPath])
  }

  return NextResponse.json(
    { submission: result.submission, already_pending: result.already_pending === true },
    { status: 200, headers: NO_STORE },
  )
}

// ── Edit your own review ──────────────────────────────────────────────────────
//
// PUT edits a PENDING or APPROVED review in place: the same row, the same
// submission date and month, an incremented edit counter and a history row. An
// approved review goes back to Pending Approval with its credit HELD — never
// paid twice; rejecting the edit reverses it. A rejected review is corrected
// through PATCH (Edit & Reapply), so this route refuses it.
//
// OWNERSHIP IS ENFORCED THREE TIMES: the caller reads the row under their own
// RLS (a row that is not theirs is answered like one that does not exist), the
// route compares submitted_by with the session user, and the database function
// compares again with the actor the route passes — no client role can write the
// table, so there is no other way in. The screenshot, when replaced, is
// re-encoded like every other proof and the old object is KEPT (history names it).
//
// REPEATS. `expectedEditCount` is the counter the employee opened the form on.
// A repeat of an edit that already went through answers `unchanged`; a stale
// counter with different content is refused (409).

export async function PUT(req: NextRequest) {
  const caller = await createClient()
  const auth = await authorize(caller)
  if (auth instanceof NextResponse) return auth
  const actorId = auth.userId

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return fail(400, MESSAGES.bad_request)
  }

  const submissionId = form.get('submissionId')
  if (typeof submissionId !== 'string' || !UUID_RE.test(submissionId)) return fail(400, MESSAGES.bad_request)

  const expectedRaw = form.get('expectedEditCount')
  const expectedEditCount = typeof expectedRaw === 'string' && /^\d{1,6}$/.test(expectedRaw) ? Number(expectedRaw) : null
  if (expectedEditCount === null) return fail(400, MESSAGES.bad_request)

  const parsed = parseCustomSubmissionInput({
    reviewType:  form.get('reviewType'),
    publishedOn: form.get('publishedOn'),
    remark:      form.get('remark'),
    hasProof:    true,
  }, istToday())
  if (!parsed.ok) return fail(422, parsed.issues[0].message)

  const { data: current } = await caller
    .from('customer_review_custom_submissions')
    .select('id, submitted_by, status, deleted_at')
    .eq('id', submissionId)
    .maybeSingle()
  const row = current as { id: string; submitted_by: string; status: string; deleted_at: string | null } | null
  if (!row || row.submitted_by !== actorId || row.deleted_at) return fail(404, MESSAGES.not_found)
  if (row.status === 'rejected') return fail(409, MESSAGES.not_editable)

  const match = readMatchFields(form)
  if (!match.ok) return match.response

  const file = form.get('file')
  const proof = file && typeof file !== 'string' && (file as File).size > 0 ? (file as File) : null
  const image = proof ? await processProof(proof) : null
  if (image && !image.ok) return image.response

  const admin = adminClient()
  if (!admin.ok) {
    console.error('[customer-reviews:custom-submissions] missing env:', admin.missing.join(', '))
    return fail(503, MESSAGES.unavailable)
  }
  const service = admin.client

  const gate = await duplicateGate({
    service, actorId, submissionId,
    reviewerName: match.reviewerName, reviewText: match.reviewText,
    image: image && image.ok ? { digest: image.digest, bytes: image.bytes } : null, acknowledged: match.acknowledged,
  })
  if ('block' in gate) return gate.block

  const newPath = image && image.ok ? `${submissionId}/proof/${randomUUID()}.${image.extension}` : null
  if (image && image.ok && newPath) {
    const { error: uploadError } = await service.storage
      .from(CUSTOM_PROOF_BUCKET)
      .upload(newPath, image.bytes, { contentType: image.mime, upsert: false })
    if (uploadError) return fail(500, MESSAGES.upload_failed)
  }

  const { data, error } = await service.rpc('edit_customer_review_custom_submission', {
    p_submission_id:        submissionId,
    p_actor_id:             actorId,
    p_review_type:          parsed.value.reviewType,
    p_published_on:         parsed.value.publishedOn,
    p_remark:               parsed.value.remark,
    p_expected_edit_count:  expectedEditCount,
    p_proof_storage_path:   newPath,
    p_proof_file_name:      image && image.ok ? image.displayName : null,
    p_proof_mime_type:      image && image.ok ? image.mime : null,
    p_proof_byte_size:      image && image.ok ? image.bytes.length : null,
    p_proof_content_sha256: image && image.ok ? image.digest : null,
    p_reviewer_name:        match.reviewerName,
    p_review_text:          match.reviewText,
    p_reviewer_name_norm:   gate.nameNorm,
    p_review_text_norm:     gate.textNorm,
    p_proof_phash:          gate.phash,
    p_duplicate:            gate.argument,
  })

  const result = data as { submission?: unknown; unchanged?: boolean; sent_back_for_approval?: boolean } | null
  if (error || !result) {
    if (newPath) await service.storage.from(CUSTOM_PROOF_BUCKET).remove([newPath])
    return failFromDatabase(error?.message ?? '')
  }
  // An unchanged answer did not use the new object.
  if (result.unchanged && newPath) {
    await service.storage.from(CUSTOM_PROOF_BUCKET).remove([newPath])
  }

  return NextResponse.json(
    {
      submission: result.submission,
      unchanged: result.unchanged === true,
      sent_back_for_approval: result.sent_back_for_approval === true,
    },
    { status: 200, headers: NO_STORE },
  )
}

// ── Delete your own review ────────────────────────────────────────────────────
//
// A SOFT delete. The row, its proof and its history stay for verifiers (and as
// duplicate-check evidence); the employee no longer sees it. A posted credit is
// reversed once, in the same transaction. Repeats answer `already_deleted`.

export async function DELETE(req: NextRequest) {
  const caller = await createClient()
  const auth = await authorize(caller)
  if (auth instanceof NextResponse) return auth
  const actorId = auth.userId

  const body = await req.json().catch(() => null) as { submissionId?: unknown } | null
  const submissionId = body?.submissionId
  if (typeof submissionId !== 'string' || !UUID_RE.test(submissionId)) return fail(400, MESSAGES.bad_request)

  const { data: current } = await caller
    .from('customer_review_custom_submissions')
    .select('id, submitted_by')
    .eq('id', submissionId)
    .maybeSingle()
  const row = current as { id: string; submitted_by: string } | null
  if (!row || row.submitted_by !== actorId) return fail(404, MESSAGES.not_found)

  const admin = adminClient()
  if (!admin.ok) {
    console.error('[customer-reviews:custom-submissions] missing env:', admin.missing.join(', '))
    return fail(503, MESSAGES.unavailable)
  }

  const { data, error } = await admin.client.rpc('delete_customer_review_custom_submission', {
    p_submission_id: submissionId,
    p_actor_id:      actorId,
  })
  const result = data as { already_deleted?: boolean; credits_reversed?: number | string } | null
  if (error || !result) return failFromDatabase(error?.message ?? '')

  return NextResponse.json(
    { deleted: true, already_deleted: result.already_deleted === true, credits_reversed: Number(result.credits_reversed ?? 0) },
    { status: 200, headers: NO_STORE },
  )
}
