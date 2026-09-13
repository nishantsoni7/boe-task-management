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
  parseCustomSubmissionInput,
} from '@/lib/customerReviews/customSubmissions'

// POST /api/customer-reviews/custom-submissions — Submit Custom Review.
//
// An employee hands over proof that a review THEY arranged was published: the
// type, the published date, an optional remark and a screenshot. The record is
// created Pending Verification; nothing here — and nothing a browser can call —
// awards a credit. A verifier approves or rejects it through the definer RPCs.
//
// WHY A ROUTE. The screenshot spans the private bucket and the metadata row,
// and no client role may write either (no storage INSERT policy, no table
// INSERT privilege). The same byte pipeline as /api/customer-reviews/photos:
//
//   1. authenticate the caller from their own session;
//   2. resolve customer_review_requests.use — the permission to do review work;
//   3. validate the fields (parseCustomSubmissionInput, the form's own rules);
//   4. read the file, DECODE AND RE-ENCODE it — the stored object is libvips
//      output, never the upload;
//   5. upload under a path generated here from a fresh submission id;
//   6. register it through create_customer_review_custom_submission() on the
//      service role, with the actor taken from step 1 — never from the form;
//   7. if registration fails, remove the object again.
//
// NOTHING THE CLIENT SENDS NAMES A PERSON OR A LOCATION. The body carries a
// type, a date, a remark and a file. The submitter is the session's user, the
// bucket is a constant and the object key is generated.

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
} as const

const NO_STORE = { 'Cache-Control': 'no-store, private' }

const fail = (status: number, message: string) =>
  NextResponse.json({ error: message }, { status, headers: NO_STORE })

export async function POST(req: NextRequest) {
  // ── 1. Who is calling ─────────────────────────────────────────────────────
  const caller = await createClient()
  const { data: { user }, error: authError } = await caller.auth.getUser()
  if (authError || !user) return fail(401, MESSAGES.unauthenticated)

  const { data: profile } = await caller
    .from('users')
    .select('is_active')
    .eq('id', user.id)
    .single()
  if (!profile || profile.is_active !== true) return fail(403, MESSAGES.forbidden)

  // ── 2. Do they hold `use` ─────────────────────────────────────────────────
  // Resolved for every caller; the role is not read. The database asks again.
  const { data: allowed } = await caller.rpc('resolve_permission', {
    p_user_id: user.id,
    p_module_key: 'customer_review_requests',
    p_action_key: 'use',
  })
  if (allowed !== true) return fail(403, MESSAGES.forbidden)

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

  // The declared size first, so an oversized body is refused before it is read.
  if (proof.size > TEST_SCREENSHOT_MAX_BYTES) return fail(413, IMAGE_REJECTION_MESSAGES.too_large)

  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await proof.arrayBuffer())
  } catch {
    return fail(400, MESSAGES.bad_request)
  }
  const displayName = sanitizeDisplayName(proof.name)

  // ── 4. What the bytes actually are ────────────────────────────────────────
  const processed = await processReviewImage(bytes, TEST_SCREENSHOT_MAX_BYTES)
  if (!processed.ok) {
    const message = processed.reason === 'undecodable' || processed.reason === 'too_many_pixels'
      ? PROCESSING_REJECTION_MESSAGES[processed.reason]
      : IMAGE_REJECTION_MESSAGES[processed.reason]
    return fail(processed.reason === 'too_large' ? 413 : 415, message)
  }
  const stored = processed.bytes

  // ── 5. The privileged client, and the path generated HERE ─────────────────
  const admin = adminClient()
  if (!admin.ok) {
    console.error('[customer-reviews:custom-submissions] missing env:', admin.missing.join(', '))
    return fail(503, MESSAGES.unavailable)
  }
  const service = admin.client

  const submissionId = randomUUID()
  const digest = createHash('sha256').update(stored).digest('hex')
  const extension = processed.mime === 'image/jpeg' ? 'jpg'
    : processed.mime === 'image/png' ? 'png'
    : 'webp'
  // The submission id first: the bucket's SELECT policy reads it, and the
  // table's CHECK requires the two to agree.
  const storagePath = `${submissionId}/proof/${randomUUID()}.${extension}`

  const { error: uploadError } = await service.storage
    .from(CUSTOM_PROOF_BUCKET)
    .upload(storagePath, stored, { contentType: processed.mime, upsert: false })
  if (uploadError) return fail(500, MESSAGES.upload_failed)

  // ── 6. Registration, with the actor from the session ──────────────────────
  const { data, error } = await service.rpc('create_customer_review_custom_submission', {
    p_submission_id:        submissionId,
    p_actor_id:             user.id,
    p_review_type:          parsed.value.reviewType,
    p_published_on:         parsed.value.publishedOn,
    p_remark:               parsed.value.remark,
    p_proof_storage_path:   storagePath,
    p_proof_file_name:      displayName,
    p_proof_mime_type:      processed.mime,
    p_proof_byte_size:      stored.length,
    p_proof_content_sha256: digest,
  })

  if (error || !data) {
    // ── 7. Compensation: a failed registration leaves no orphaned object ───
    await service.storage.from(CUSTOM_PROOF_BUCKET).remove([storagePath])
    const raw = error?.message ?? ''
    // The database's own sentences, which are prewritten and name nobody.
    if (raw.startsWith('CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED')) return fail(403, customSubmissionErrorMessage(raw, MESSAGES.forbidden))
    if (raw.startsWith('CUSTOMER_REVIEW_CUSTOM_DUPLICATE'))    return fail(409, customSubmissionErrorMessage(raw, MESSAGES.failed))
    if (raw.startsWith('CUSTOMER_REVIEW_CUSTOM_INVALID'))      return fail(422, customSubmissionErrorMessage(raw, MESSAGES.failed))
    return fail(500, MESSAGES.failed)
  }

  return NextResponse.json({ submission: data }, { status: 200, headers: NO_STORE })
}
