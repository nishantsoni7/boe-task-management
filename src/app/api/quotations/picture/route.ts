// POST /api/quotations/picture  { sourcePath, mode: 'clean' | 'change', instruction?, reference? }
//
// Image studio for a quotation product picture (phase 4, owner approved 2026-11-12). Reads the saved picture from
// the public quotation-images bucket, sends it to the same image model Edit PI uses, and stores the result as a NEW
// picture in the caller's own folder. Nothing on the quotation changes here: the builder shows the result beside
// the original and the person chooses "Use this picture" (then Save).
//
// WHO MAY: a signed-in person whose quotation_my_access() says create, edit or admin (the same people who may
// upload a picture). The storage write runs as the caller, so the bucket's own policy (own folder, .jpg) applies.
//
// COST: one press = ONE provider request, never retried (src/lib/imageEditor/falRequest.ts). FAL_KEY stays here.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { callFal, NO_RETRY_FAILURES, toDataUrl } from '@/lib/imageEditor/falRequest'
import { PI_IMAGE_EDIT_MODEL } from '@/lib/orders/customizationImage'
import { sniffImageFormat } from '@/lib/xlsxMediaOptimizer'
import { readReference, studioProblem, studioPrompt, type StudioMode } from '@/lib/quotations/pictureStudio'

export const runtime = 'nodejs'
export const maxDuration = 60

const ROUTE_BUDGET_MS = 57_000
const PROVIDER_TIMEOUT_MS = 50_000
const MAX_STORED_BYTES = 3 * 1024 * 1024 // the bucket's own limit

const recent = new Map<string, number[]>()
function rateLimited(userId: string): boolean {
  const now = Date.now()
  const hits = (recent.get(userId) ?? []).filter(t => now - t < 60_000)
  hits.push(now)
  recent.set(userId, hits)
  return hits.length > 6
}

const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: false, code, error, ...extra }, { status })

export async function POST(req: NextRequest) {
  const startedAt = Date.now()
  const s = await createClient()
  const { data: { user } } = await s.auth.getUser()
  if (!user) return fail(401, 'UNAUTHORIZED', 'Please sign in again.')

  let body: Record<string, unknown>
  try { body = (await req.json()) as Record<string, unknown> } catch { return fail(400, 'BAD_REQUEST', 'The request could not be read.') }
  const problem = studioProblem(body.mode, body.sourcePath, body.instruction)
  if (problem) return fail(400, 'BAD_REQUEST', problem)
  const reference = readReference(body.reference)
  if (reference === false) return fail(400, 'BAD_REQUEST', 'The reference picture must be a JPG, PNG or WebP under 2 MB.')
  const mode = body.mode as StudioMode
  const sourcePath = body.sourcePath as string
  const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : ''

  const { data: access, error: accessErr } = await s.rpc('quotation_my_access')
  const a = (access ?? {}) as { create?: boolean; edit?: boolean; admin?: boolean }
  if (accessErr || !(a.create || a.edit || a.admin)) return fail(403, 'FORBIDDEN', 'Your access cannot change quotation pictures.')

  const apiKey = process.env.FAL_KEY
  if (!apiKey) return fail(503, 'not_configured', 'The image service is not set up yet. Ask your administrator to configure it.')
  if (rateLimited(user.id)) return fail(429, 'RATE_LIMITED', 'Too many pictures in a minute. Wait a moment and try again.')

  // Everything refusable is refused BEFORE the paying call.
  const { data: blob, error: readErr } = await s.storage.from('quotation-images').download(sourcePath)
  if (readErr || !blob) return fail(404, 'SOURCE_MISSING', 'That picture could not be found. Upload it again.')
  const source = Buffer.from(await blob.arrayBuffer())
  if (sniffImageFormat(new Uint8Array(source)) !== 'jpeg') return fail(422, 'SOURCE_UNREADABLE', 'That picture could not be read. Upload it again.')

  const result = await callFal({
    modelId: PI_IMAGE_EDIT_MODEL,
    apiKey,
    timeoutMs: PROVIDER_TIMEOUT_MS,
    deadlineAt: startedAt + ROUTE_BUDGET_MS,
    expect: 1,
    body: {
      prompt: studioPrompt(mode, instruction, !!reference),
      image_urls: [toDataUrl(source, 'image/jpeg'), ...(reference ? [`data:${reference.mime};base64,${reference.base64}`] : [])],
      num_images: 1,
      aspect_ratio: 'auto',
      resolution: '1K',
      output_format: 'jpeg', // the bucket takes JPEG only, so no conversion is needed here
      limit_generations: true,
    },
  })
  if (!result.ok) {
    console.error('[quotation-picture] failed', { reason: result.reason, status: result.status, requestId: result.requestId, phase: result.phase })
    const status = result.reason === 'rate_limited' ? 429
      : result.reason === 'unsupported_image' || result.reason === 'moderation' || result.reason === 'empty_result' ? 422
        : result.reason === 'invalid_key' || result.reason === 'insufficient_credit' || result.reason === 'not_configured' ? 503 : 502
    return fail(status, result.reason, result.message, { noRetry: NO_RETRY_FAILURES.has(result.reason) })
  }

  const out = new Uint8Array(result.images[0].bytes)
  if (sniffImageFormat(out) !== 'jpeg' || out.length > MAX_STORED_BYTES) {
    return fail(422, 'empty_result', 'The image service did not return a usable picture. Please try again.')
  }
  const path = `${user.id}/${crypto.randomUUID()}.jpg`
  const { error } = await s.storage.from('quotation-images').upload(path, out, { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' })
  if (error) return fail(500, 'NOT_STORED', 'The picture was made but could not be stored. Please try again.')
  return NextResponse.json({ ok: true, path })
}
