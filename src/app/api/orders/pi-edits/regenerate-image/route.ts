// ── Regenerate a product picture for a customization (Edit PI) ───────────────
//
// POST { submissionId, itemId, sourcePath, instruction }
//
// Takes the picture a line shows now (the standard product, or an earlier
// regeneration of it), applies the written change, and stores the result as a
// NEW content-addressed product image for that line — the same key shape the
// plain photo upload uses. Nothing on the PI changes here: the picture becomes
// part of the PI only when the person presses "Use this image" and then saves
// the edit, exactly like Replace photo.
//
// WHO MAY: the people who may change photos on this PI (see ../photo/route.ts).
//
// COST: one press = ONE provider request. No retry of any kind, including after
// a timeout (the same rule as the Image Editor, src/lib/imageEditor/falRequest.ts,
// whose single-request adapter this reuses). FAL_KEY is read here, never sent
// to the browser, never put in a URL.
//
// The source is only ever read from THIS PI's own canonical image keys, so the
// route cannot be pointed at another object in the bucket.

import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { isUuid, sha256Hex, MAX_IMAGE_OBJECT_BYTES } from '@/lib/orders/submissionPayload'
import { isCanonicalPiImageKey } from '@/lib/orders/piImageKey'
import { sniffImageFormat } from '@/lib/xlsxMediaOptimizer'
import { callFal, NO_RETRY_FAILURES, toDataUrl, type FalFailure } from '@/lib/imageEditor/falRequest'
import {
  PI_IMAGE_EDIT_MODEL, buildEditPrompt, instructionProblem, INSTRUCTION_MESSAGES,
} from '@/lib/orders/customizationImage'

export const runtime = 'nodejs'
export const maxDuration = 60

const ROUTE_BUDGET_MS = 55_000
const PROVIDER_TIMEOUT_MS = 45_000
/** The picture is sent at most this wide/tall: enough to edit, small to upload. */
const SEND_MAX_SIDE = 1600

const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' } as const
const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const

const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error: code, message, ...extra }, { status })

// Per user, in memory: a spend guard on a route that costs money per press, not
// a security control (same reasoning as /api/image-editor/studio).
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 6
const recentCalls = new Map<string, number[]>()
function rateLimited(userId: string): boolean {
  const now = Date.now()
  const recent = (recentCalls.get(userId) ?? []).filter(t => now - t < WINDOW_MS)
  if (recent.length >= MAX_PER_WINDOW) { recentCalls.set(userId, recent); return true }
  recent.push(now)
  recentCalls.set(userId, recent)
  return false
}

const statusFor = (reason: FalFailure): number => {
  switch (reason) {
    case 'timeout': return 504
    case 'rate_limited': return 429
    case 'unsupported_image': case 'moderation': case 'empty_result': return 422
    case 'invalid_key': case 'insufficient_credit': case 'not_configured': return 503
    default: return 502
  }
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now()
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return fail(401, 'UNAUTHORIZED', 'Please sign in again.')

  let body: Record<string, unknown>
  try { body = (await req.json()) as Record<string, unknown> } catch { return fail(400, 'BAD_REQUEST', 'The request could not be read.') }
  const submissionId = typeof body.submissionId === 'string' ? body.submissionId : ''
  const itemId = typeof body.itemId === 'string' ? body.itemId : ''
  const sourcePath = typeof body.sourcePath === 'string' ? body.sourcePath : ''
  const instruction = typeof body.instruction === 'string' ? body.instruction : ''
  if (!isUuid(submissionId) || !isUuid(itemId) || !isCanonicalPiImageKey(sourcePath, { submissionId })) {
    return fail(400, 'BAD_REQUEST', 'The request could not be read.')
  }
  const problem = instructionProblem(instruction)
  if (problem) return fail(400, 'INSTRUCTION', INSTRUCTION_MESSAGES[problem])

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

  const apiKey = process.env.FAL_KEY
  if (!apiKey) return fail(503, 'not_configured', 'The image service is not set up yet. Ask your administrator to configure it.')
  const admin = adminClient()
  if (!admin.ok) return fail(500, 'SERVER_NOT_CONFIGURED', 'Image regeneration is not configured on this deployment.')

  if (rateLimited(user.id)) return fail(429, 'RATE_LIMITED', 'Too many pictures in a minute. Wait a moment and try again.')

  // Everything refusable is refused BEFORE the paying call.
  const download = await admin.client.storage.from('order-files').download(sourcePath)
  if (download.error || !download.data) return fail(404, 'SOURCE_MISSING', 'The product picture could not be read. Reload the page and try again.')
  const sourceBytes = new Uint8Array(await download.data.arrayBuffer())
  const sourceFormat = sniffImageFormat(sourceBytes)
  if ((sourceFormat !== 'png' && sourceFormat !== 'jpeg' && sourceFormat !== 'webp') || sourceBytes.length > MAX_IMAGE_OBJECT_BYTES) {
    return fail(422, 'SOURCE_UNSUPPORTED', 'This product picture cannot be edited. Replace it with a PNG, JPEG or WebP photo first.')
  }

  let toSend: Buffer
  try {
    toSend = await sharp(sourceBytes).rotate()
      .resize(SEND_MAX_SIDE, SEND_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 }).toBuffer()
  } catch {
    return fail(422, 'SOURCE_UNSUPPORTED', 'This product picture cannot be edited. Replace it with a PNG, JPEG or WebP photo first.')
  }

  const result = await callFal({
    modelId: PI_IMAGE_EDIT_MODEL,
    apiKey,
    timeoutMs: PROVIDER_TIMEOUT_MS,
    deadlineAt: startedAt + ROUTE_BUDGET_MS,
    expect: 1,
    body: {
      prompt: buildEditPrompt(instruction),
      image_url: toDataUrl(toSend, 'image/jpeg'),
      num_images: 1,
      output_format: 'png',
      safety_tolerance: '2',
    },
  })
  if (!result.ok) {
    console.error('[pi-regenerate-image] failed', { reason: result.reason, status: result.status, requestId: result.requestId, phase: result.phase })
    return fail(statusFor(result.reason), result.reason, result.message, { noRetry: NO_RETRY_FAILURES.has(result.reason) })
  }

  const out = new Uint8Array(result.images[0].bytes)
  const format = sniffImageFormat(out)
  if ((format !== 'png' && format !== 'jpeg' && format !== 'webp') || out.length > MAX_IMAGE_OBJECT_BYTES) {
    return fail(422, 'empty_result', 'The image service did not return a usable image. Please try again.')
  }
  const sha256 = sha256Hex(out)
  const storagePath = `submissions/${submissionId}/images/${itemId}/representative/0-${sha256}.${EXT[format]}`
  const { error } = await admin.client.storage.from('order-files')
    .upload(storagePath, out, { contentType: MIME[format], upsert: true })
  if (error) return fail(500, 'PHOTO_NOT_STORED', 'The picture was made but could not be stored. Please try again.')

  return NextResponse.json({ ok: true, storage_path: storagePath, sha256, mime_type: MIME[format] })
}
