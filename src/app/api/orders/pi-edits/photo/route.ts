// ── A product photo for Edit PI (20270103000000) ──────────────────────────────
//
// Stores ONE picture under the PI's own content-addressed image key —
// submissions/{pi}/images/{line}/representative/0-{sha256}.{ext}, the shape the
// image table's check constraint requires — and returns the key. Nothing on the
// PI changes: the picture becomes part of it only when the edit is applied (a
// draft) or when a proposed version is accepted (an approved PI).
//
// Private, like every product image: the order-files bucket has no public read,
// and this uploads with the service role only after the database has said the
// person may edit this PI (or propose a revision of it).

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

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return fail(401, 'UNAUTHORIZED', 'Please sign in again.')

  let form: FormData
  try { form = await req.formData() } catch { return fail(400, 'BAD_REQUEST', 'The photo could not be read.') }
  const submissionId = String(form.get('submissionId') ?? '')
  const itemId = String(form.get('itemId') ?? '')
  const file = form.get('file')
  if (!isUuid(submissionId) || !isUuid(itemId) || !(file instanceof Blob)) {
    return fail(400, 'BAD_REQUEST', 'The photo could not be read.')
  }
  if (file.size === 0 || file.size > MAX_IMAGE_OBJECT_BYTES) {
    return fail(400, 'PHOTO_SIZE', 'A photo must be between 1 byte and 10 MB.')
  }

  // Who may: the person who may edit this PI now, or propose a revision of it.
  const { data: sub } = await authClient.from('order_submissions')
    .select('id, order_id').eq('id', submissionId).maybeSingle()
  if (!sub) return fail(404, 'NOT_FOUND', 'This PI is not available to you.')
  const orderId = (sub as { order_id: string | null }).order_id
  const checks = orderId
    ? [authClient.rpc('can_propose_order_pi_edit', { p_order_id: orderId })]
    : [authClient.rpc('can_edit_order_submission', { p_submission_id: submissionId }),
       authClient.rpc('can_admin_edit_order_submission', { p_submission_id: submissionId })]
  const answers = await Promise.all(checks)
  if (!answers.some(a => !a.error && a.data === true)) {
    return fail(403, 'FORBIDDEN', 'You cannot change the photos on this PI.')
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const format = sniffImageFormat(bytes)
  if (format !== 'png' && format !== 'jpeg' && format !== 'webp') {
    return fail(400, 'PHOTO_TYPE', 'A product photo must be a PNG, JPEG or WebP image.')
  }
  const sha256 = sha256Hex(bytes)
  const storagePath = `submissions/${submissionId}/images/${itemId}/representative/0-${sha256}.${EXT[format]}`

  const admin = adminClient()
  if (!admin.ok) return fail(500, 'SERVER_NOT_CONFIGURED', 'Photo upload is not configured on this deployment.')
  // Content-addressed: the same bytes for the same line are the same key, so a
  // retried upload is not a second picture.
  const { error } = await admin.client.storage.from('order-files')
    .upload(storagePath, bytes, { contentType: MIME[format], upsert: true })
  if (error) return fail(500, 'PHOTO_NOT_STORED', 'The photo could not be stored. Please try again.')

  return NextResponse.json({ ok: true, storage_path: storagePath, sha256, mime_type: MIME[format] })
}
