// ── A reference picture of a fabric or finish (20270431000000) ─────────────
//
// Stores ONE picture under the PI's own fabric-finish key —
// submissions/{pi}/fabric-finish/{line}/{sha256}.{ext}, the shape the save
// function's check requires — and returns the key. Nothing on the PI changes:
// the picture becomes part of a finish choice only when the line is saved
// (order_submission_fabric_finish_save_typed), which re-checks the key.
//
// Private, like every product image: the order-files bucket has no public
// read, and this uploads with the service role only after the database has
// said the person may type on this PI's sheet.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { isUuid, sha256Hex, MAX_IMAGE_OBJECT_BYTES } from '@/lib/orders/submissionPayload'
import { sniffImageFormat } from '@/lib/xlsxMediaOptimizer'

export const runtime = 'nodejs'

const fail = (status: number, code: string, message: string) =>
  NextResponse.json({ error: code, message }, { status })

const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' } as const
const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const
/** The line's identity as the key allows it: an item number or a row id. */
const LINE_KEY = /^[A-Za-z0-9._-]{1,60}$/

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return fail(401, 'UNAUTHORIZED', 'Please sign in again.')

  let form: FormData
  try { form = await req.formData() } catch { return fail(400, 'BAD_REQUEST', 'The picture could not be read.') }
  const submissionId = String(form.get('submissionId') ?? '')
  const itemSequence = String(form.get('itemSequence') ?? '').trim()
  const file = form.get('file')
  if (!isUuid(submissionId) || !LINE_KEY.test(itemSequence) || !(file instanceof Blob)) {
    return fail(400, 'BAD_REQUEST', 'The picture could not be read.')
  }
  if (file.size === 0 || file.size > MAX_IMAGE_OBJECT_BYTES) {
    return fail(400, 'PHOTO_SIZE', 'A picture must be between 1 byte and 10 MB.')
  }

  // Who may: the person who may type on this PI's sheet now, as the database decides.
  const may = await authClient.rpc('can_edit_order_submission_fabric_finish', { p_submission_id: submissionId })
  if (may.error || may.data !== true) {
    return fail(403, 'FORBIDDEN', 'You cannot change the fabric and finish details of this PI.')
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const format = sniffImageFormat(bytes)
  if (format !== 'png' && format !== 'jpeg' && format !== 'webp') {
    return fail(400, 'PHOTO_TYPE', 'A picture must be a PNG, JPEG or WebP image.')
  }
  const sha256 = sha256Hex(bytes)
  const storagePath = `submissions/${submissionId}/fabric-finish/${itemSequence}/${sha256}.${EXT[format]}`

  const admin = adminClient()
  if (!admin.ok) return fail(500, 'SERVER_NOT_CONFIGURED', 'Picture upload is not configured on this deployment.')
  // Content-addressed: the same bytes for the same line are the same key, so a
  // retried upload is not a second picture.
  const { error } = await admin.client.storage.from('order-files')
    .upload(storagePath, bytes, { contentType: MIME[format], upsert: true })
  if (error) return fail(500, 'PHOTO_NOT_STORED', 'The picture could not be stored. Please try again.')

  return NextResponse.json({ ok: true, storage_path: storagePath, sha256, mime_type: MIME[format] })
}
