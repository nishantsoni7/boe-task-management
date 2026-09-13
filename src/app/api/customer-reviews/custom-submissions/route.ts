import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomUUID } from 'node:crypto'

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
} from '@/lib/customerReviews/customSubmissions'
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

  // ── 4. What the bytes actually are ────────────────────────────────────────
  const image = await processProof(proof)
  if (!image.ok) return image.response

  // ── 5. The privileged client, and the path generated HERE ─────────────────
  const admin = adminClient()
  if (!admin.ok) {
    console.error('[customer-reviews:custom-submissions] missing env:', admin.missing.join(', '))
    return fail(503, MESSAGES.unavailable)
  }
  const service = admin.client

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
