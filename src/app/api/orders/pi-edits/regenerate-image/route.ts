// ── Regenerate a product picture for a customization (Edit PI) ───────────────
//
// POST { submissionId, itemId, sourcePath, instruction, references? }
//
// Takes the picture a line shows now (the standard product, or an earlier
// regeneration of it), applies the instruction — normally the one the person
// checked under "Understood as" (../interpret-customization) — and stores the
// result as a NEW content-addressed product image for that line, the same key
// shape the plain photo upload uses. Up to two reference pictures (a catalogue
// photo, a phone sketch) go with it for the changed parts. Nothing on the PI
// changes here: the picture becomes part of the PI only when the person presses
// "Use this image" and then saves the edit, exactly like Replace photo.
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
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { isUuid, sha256Hex, MAX_IMAGE_OBJECT_BYTES } from '@/lib/orders/submissionPayload'
import { isCanonicalPiImageKey } from '@/lib/orders/piImageKey'
import { sniffImageFormat } from '@/lib/xlsxMediaOptimizer'
import { callFal, NO_RETRY_FAILURES, toDataUrl, type FalFailure } from '@/lib/imageEditor/falRequest'
import {
  PI_IMAGE_EDIT_MODEL, buildEditPrompt, instructionProblem, INSTRUCTION_MESSAGES, parseReferences,
} from '@/lib/orders/customizationImage'
import {
  SOURCE_MESSAGES, loadSourcePicture, makeRateLimiter, mayChangePiPhotos,
} from '@/lib/orders/customizationImageServer'
import { ATTEMPTS, updateOwnAttempt } from '@/lib/orders/customizationLearningServer'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Notes on the person's own attempt what was sent and what came back, for the
 * Learning page. Best effort: no attempt id, or no learning tables, changes nothing.
 */
async function noteOnAttempt(
  service: SupabaseClient, attemptId: string | null, owner: { userId: string; submissionId: string },
  instruction: string, outcome: 'generated' | 'failed', resultPath: string | null,
) {
  if (!attemptId) return
  const { data } = await service.from(ATTEMPTS).select('understood_instruction')
    .eq('id', attemptId).eq('created_by', owner.userId).eq('submission_id', owner.submissionId).maybeSingle()
  if (!data) return
  const understood = String((data as { understood_instruction: string }).understood_instruction ?? '')
  await updateOwnAttempt(service, attemptId, owner, {
    final_instruction: instruction.trim().slice(0, 1500),
    instruction_edited: instruction.trim() !== understood.trim(),
    outcome,
    ...(resultPath ? { result_path: resultPath } : {}),
    updated_at: new Date().toISOString(),
  })
}

export const runtime = 'nodejs'
export const maxDuration = 60

const ROUTE_BUDGET_MS = 57_000
const PROVIDER_TIMEOUT_MS = 50_000

const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' } as const
const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const

const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error: code, message, ...extra }, { status })

// Same reasoning as /api/image-editor/studio: a spend guard, not a security control.
const rateLimited = makeRateLimiter(6)

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
  const references = parseReferences(body.references)
  const attemptId = typeof body.attemptId === 'string' && isUuid(body.attemptId) ? body.attemptId : null
  if (!isUuid(submissionId) || !isUuid(itemId) || !isCanonicalPiImageKey(sourcePath, { submissionId }) || references === null) {
    return fail(400, 'BAD_REQUEST', 'The request could not be read.')
  }
  const problem = instructionProblem(instruction)
  if (problem) return fail(400, 'INSTRUCTION', INSTRUCTION_MESSAGES[problem])

  const may = await mayChangePiPhotos(authClient, submissionId)
  if (may === 'not_found') return fail(404, 'NOT_FOUND', 'This PI is not available to you.')
  if (may === 'forbidden') return fail(403, 'FORBIDDEN', 'You cannot change the photos on this PI.')

  const apiKey = process.env.FAL_KEY
  if (!apiKey) return fail(503, 'not_configured', 'The image service is not set up yet. Ask your administrator to configure it.')
  const admin = adminClient()
  if (!admin.ok) return fail(500, 'SERVER_NOT_CONFIGURED', 'Image regeneration is not configured on this deployment.')

  if (rateLimited(user.id)) return fail(429, 'RATE_LIMITED', 'Too many pictures in a minute. Wait a moment and try again.')

  // Everything refusable is refused BEFORE the paying call.
  const source = await loadSourcePicture(admin.client, sourcePath)
  if (!source.ok) return fail(source.code === 'SOURCE_MISSING' ? 404 : 422, source.code, SOURCE_MESSAGES[source.code])

  const result = await callFal({
    modelId: PI_IMAGE_EDIT_MODEL,
    apiKey,
    timeoutMs: PROVIDER_TIMEOUT_MS,
    deadlineAt: startedAt + ROUTE_BUDGET_MS,
    expect: 1,
    body: {
      prompt: buildEditPrompt(instruction, references.length),
      image_urls: [
        toDataUrl(source.jpeg, 'image/jpeg'),
        ...references.map(r => `data:${r.mimeType};base64,${r.base64}`),
      ],
      num_images: 1,
      aspect_ratio: 'auto',
      resolution: '1K',
      output_format: 'png',
      limit_generations: true,
    },
  })
  if (!result.ok) {
    console.error('[pi-regenerate-image] failed', { reason: result.reason, status: result.status, requestId: result.requestId, phase: result.phase })
    await noteOnAttempt(admin.client, attemptId, { userId: user.id, submissionId }, instruction, 'failed', null)
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

  await noteOnAttempt(admin.client, attemptId, { userId: user.id, submissionId }, instruction, 'generated', storagePath)
  return NextResponse.json({ ok: true, storage_path: storagePath, sha256, mime_type: MIME[format] })
}
