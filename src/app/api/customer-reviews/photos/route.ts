import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomUUID } from 'node:crypto'

import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import {
  IMAGE_REJECTION_MESSAGES,
  inspectImageBytes,
} from '@/lib/customerReviews/imageBytes'
import {
  MAX_PROJECT_PHOTOS,
  REVIEW_PHOTO_BUCKET,
  REVIEW_PHOTO_MAX_BYTES,
} from '@/lib/customerReviews/photos'

// THE ONLY WAY AN IMAGE ENTERS THIS MODULE.
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
//   3. read the request THROUGH THEIR OWN RLS, so a request they may not see
//      does not exist as far as this route is concerned;
//   4. apply the kind/status rule (project photo while preparing, proof after
//      sending) and the ownership rule;
//   5. read the whole file into memory and INSPECT ITS BYTES;
//   6. only then upload, to a path this server generates;
//   7. insert the metadata with the INSPECTED type and size;
//   8. if that insert fails, remove the object again.
//
// NOTHING THE CLIENT SENDS NAMES A LOCATION. The body carries a request id, a
// kind, and a file. The bucket is a constant, the object key is generated here
// from the request id and a fresh uuid, and `uploaded_by` is the authenticated
// user — never a field. A caller cannot choose where their bytes land, cannot
// write into another request's folder, and cannot register somebody else's
// object.
//
// PRIVACY. No response and no log line carries a filename, a customer name, a
// phone number, a signed URL, a storage path or a byte of content. Rejections
// are prewritten sentences chosen from a closed set (IMAGE_REJECTION_MESSAGES);
// an unanticipated failure contributes no text of its own.

export const runtime = 'nodejs'

/** Reading and hashing a 5 MB image is fast, but not instant on a cold start. */
export const maxDuration = 30

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** The two kinds, and nothing else. */
const KINDS = ['project_photo', 'review_proof'] as const
type PhotoKind = (typeof KINDS)[number]

/**
 * Every sentence this route can return, and it returns nothing else.
 *
 * An allow-list rather than a formatter: the alternative is a template that one
 * day interpolates an error somebody forgot was attacker-influenced.
 */
const MESSAGES = {
  unauthenticated: 'Sign in to continue.',
  forbidden:       'You do not have permission to attach photographs to this request.',
  not_found:       'That request is not available.',
  wrong_status:    'Photographs can only be attached while the request is being prepared.',
  proof_status:    'A proof image can only be attached once the invitation has been sent.',
  no_file:         'No file was received.',
  bad_request:     'That request could not be processed.',
  too_many:        `You can attach up to ${MAX_PROJECT_PHOTOS} photographs.`,
  duplicate:       'That photograph is already attached to this request.',
  one_proof:       'Only one proof image can be attached. Remove the current one first.',
  upload_failed:   'That photo could not be stored. Try again.',
  unavailable:     'Photo uploads are not configured on this deployment.',
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
    .select('role, is_active')
    .eq('id', user.id)
    .single()
  if (!profile || profile.is_active !== true) return fail(403, MESSAGES.forbidden)

  const isAdmin = profile.role === 'admin'
  if (!isAdmin) {
    const { data: allowed } = await caller.rpc('resolve_permission', {
      p_user_id: user.id,
      p_module_key: 'customer_review_requests',
      p_action_key: 'use',
    })
    if (allowed !== true) return fail(403, MESSAGES.forbidden)
  }

  // ── 3. What was sent ──────────────────────────────────────────────────────
  let requestId: string
  let kind: PhotoKind
  let bytes: Uint8Array
  let displayName: string
  try {
    const form = await req.formData()

    const rawId = form.get('requestId')
    if (typeof rawId !== 'string' || !UUID_RE.test(rawId)) return fail(400, MESSAGES.bad_request)
    requestId = rawId

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
    if ((file as File).size > REVIEW_PHOTO_MAX_BYTES) {
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

  // ── 4. May they attach to THIS request ────────────────────────────────────
  //
  // Read as the caller. can_view_customer_review_request() decides, so a request
  // belonging to somebody else returns no row and this route cannot tell the
  // difference between "not yours" and "does not exist" — which is the answer
  // the employee should get too.
  const { data: request } = await caller
    .from('customer_review_requests')
    .select('id, status, created_by')
    .eq('id', requestId)
    .maybeSingle()
  if (!request) return fail(404, MESSAGES.not_found)

  const isOwner = request.created_by === user.id
  if (!isOwner && !isAdmin) return fail(403, MESSAGES.forbidden)

  if (kind === 'project_photo') {
    // Mirrors can_edit_customer_review_request(): preparation stage only.
    if (request.status !== 'draft' && request.status !== 'ready_to_send') {
      return fail(409, MESSAGES.wrong_status)
    }
  } else if (request.status !== 'sent' && request.status !== 'customer_responded') {
    // Proof is evidence attached AFTER the outreach happened.
    return fail(409, MESSAGES.proof_status)
  }

  // ── 5. What the bytes actually are ────────────────────────────────────────
  //
  // The real length, the real container, and a container that accounts for the
  // whole file. This is the check that the browser's `file.type` was standing
  // in for, and it is the reason the stored mime_type is now a fact.
  const inspection = inspectImageBytes(bytes, REVIEW_PHOTO_MAX_BYTES)
  if (!inspection.ok) {
    return fail(
      inspection.reason === 'too_large' ? 413 : 415,
      IMAGE_REJECTION_MESSAGES[inspection.reason],
    )
  }

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
  const digest = createHash('sha256').update(bytes).digest('hex')

  const { data: existing, error: existingError } = await service
    .from('customer_review_request_photos')
    .select('id, kind, content_sha256')
    .eq('request_id', requestId)
  if (existingError) return fail(500, MESSAGES.upload_failed)

  const sameKind = (existing ?? []).filter(row => row.kind === kind)
  const limit = kind === 'project_photo' ? MAX_PROJECT_PHOTOS : 1
  if (sameKind.length >= limit) {
    return fail(409, kind === 'project_photo' ? MESSAGES.too_many : MESSAGES.one_proof)
  }

  // REPEATED CLICKS, answered by the content rather than by a timer. Two
  // requests carrying identical bytes for the same record are one upload; the
  // second is refused whatever raced with what, and a genuinely different photo
  // is never blocked.
  if ((existing ?? []).some(row => row.content_sha256 === digest)) {
    return fail(409, MESSAGES.duplicate)
  }

  // ── 8. The path, generated HERE ───────────────────────────────────────────
  //
  // The request id first, because the storage SELECT policy reads ownership out
  // of split_part(name, '/', 1) and the metadata CHECK requires the two to
  // agree. Nothing the caller typed contributes a character.
  const extension = inspection.mime === 'image/jpeg' ? 'jpg'
    : inspection.mime === 'image/png' ? 'png'
    : 'webp'
  const storagePath = `${requestId}/${kind}/${randomUUID()}.${extension}`

  const { error: uploadError } = await service.storage
    .from(REVIEW_PHOTO_BUCKET)
    .upload(storagePath, bytes, {
      // The INSPECTED type, not the declared one. What is stored and what is
      // served are the same fact.
      contentType: inspection.mime,
      upsert: false,
    })
  if (uploadError) return fail(500, MESSAGES.upload_failed)

  // ── 9. The metadata, from the inspection ──────────────────────────────────
  const { data: row, error: rowError } = await service
    .from('customer_review_request_photos')
    .insert({
      request_id: requestId,
      kind,
      storage_path: storagePath,
      // Display only, and bounded. The filename is the one thing the caller
      // supplies that is kept, and it never reaches a path or a response.
      file_name: displayName,
      mime_type: inspection.mime,
      byte_size: bytes.length,
      content_sha256: digest,
      uploaded_by: user.id,
    })
    .select('id, kind, storage_path, file_name, mime_type, byte_size, uploaded_by, uploaded_at')
    .single()

  if (rowError || !row) {
    // COMPENSATION. The object exists and nothing points at it; the metadata row
    // is what makes it discoverable and what the path constraint checks. Remove
    // it before returning, so a failed attach leaves the request exactly as it
    // was rather than leaving a file nobody can find again.
    await service.storage.from(REVIEW_PHOTO_BUCKET).remove([storagePath])
    return fail(500, MESSAGES.upload_failed)
  }

  return ok({ photo: { ...row, request_id: requestId } })
}

/**
 * A filename fit to store and show, and nothing more.
 *
 * Path separators, traversal dots and control characters are removed rather than
 * escaped, because this value is display-only: it is never used to build the
 * object key (that is generated from a uuid), so there is nothing to preserve.
 * A name that sanitises to nothing becomes a constant.
 */
export function sanitizeDisplayName(name: string): string {
  let out = ''
  for (const ch of name ?? '') {
    const code = ch.codePointAt(0) ?? 0
    // Control characters go entirely; a NUL or an ESC in a stored name is
    // never anything but trouble downstream.
    if (code < 0x20 || code === 0x7f) continue
    // Path separators become spaces. The object key is generated from a uuid
    // and never from this value, so nothing is lost by flattening them — and
    // a name that cannot express a path cannot suggest one to a reader.
    if (ch === '/' || ch === String.fromCharCode(92)) { out += ' '; continue }
    out += ch
  }
  const cleaned = out.split('..').join(' ').trim().slice(0, 120)
  return cleaned === '' ? 'photo' : cleaned
}
