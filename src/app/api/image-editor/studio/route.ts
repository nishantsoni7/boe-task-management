// POST /api/image-editor/studio
//
// Takes one factory-background furniture photograph and returns one square
// studio master. Backs /image-editor and nothing else.
//
// AUTH
// ----
// Any authenticated BOE user, checked the same way every other route in this
// repository checks it: a bearer token, resolved server-side, then confirmed
// against the `users` table so a valid Supabase token that belongs to nobody in
// BOE is refused. No permission grant is read — this prototype adds no module
// row and no Control Center entry.
//
// WHAT IS STORED
// --------------
// Nothing. The upload is read into memory, prepared, sent to the provider, and
// the result is returned in the response body. No Supabase Storage object, no
// table, no temporary file on disk. When the request ends, both images are gone.
//
// HOW THE IMAGE IS MADE
// ---------------------
// Two provider calls, in order, and the split between them is the whole design:
//
//   1. `fal-ai/bria/background/remove` returns the product on transparency.
//      This is not the picture — it is how the product's real pixel size is
//      learned, which is the one thing padding cannot be computed without.
//   2. the cut-out is cropped to the product, its soft edge is stripped of the
//      factory background's colour, and it is scaled so it will fill 53% of a
//      1000 x 1000 master. `fal-ai/bria/product-shot` is then asked for the
//      studio scene around it with `placement_type: 'manual_padding'`.
//
// The scene — background, lighting, contact and cast shadows — is the model's,
// and it is the one the product owner accepted. The SIZE is arithmetic, because
// two earlier paid results proved wording cannot hold a size: one invented a
// circular backdrop, the next shrank the chair to a fifth of the frame. The
// accepted third result was right about everything except that the chair was
// still too small, and that is what padding fixes.
//
// COST
// ----
// One call of this route is TWO billable requests: the cut-out and the studio
// image. That is the price of a framing that is computed rather than requested.
// A queue of five images is ten requests, made one after another by the browser
// — nothing here batches, and nothing here loops. Neither adapter retries,
// including after a timeout: a request that may already have been billed is not
// quietly billed again. The per-user rate limiter below is the spend ceiling.
//
// The browser sends the photograph and nothing else. There is no output shape
// to choose any more: the master is square, and landscape or portrait is a crop
// of it made later by somebody who can see the picture.
//
// THE API KEY
// -----------
// FAL_KEY, read here and passed to both adapters. It is never in a response
// body, never in a client bundle, and never in the URL of a provider call. With
// no key configured the route answers `configured: false` and the page says the
// service is not set up — it does not return a placeholder or a stock picture,
// because an image BOE cannot tell apart from a real one is worse than no image.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import {
  validateSourceImage,
  MAX_SOURCE_IMAGE_BYTES,
  MAX_SOURCE_IMAGE_LABEL,
} from '@/lib/imageEditor/validation'
import { prepareSourceImage } from '@/lib/imageEditor/prepareSource'
import { removeBackground, NO_RETRY_FAILURES } from '@/lib/imageEditor/briaBackgroundRemove'
import { measureCutout, prepareCutoutForShot } from '@/lib/imageEditor/prepareCutout'
import { planPadding, checkEnlargement, MAX_ENLARGEMENT } from '@/lib/imageEditor/studioMaster'
import { generateStudioShot, isNoRetry, type StudioFailure } from '@/lib/imageEditor/briaProductShot'

// sharp is a native module and the whole image is held in memory. Neither works
// on the edge runtime.
export const runtime = 'nodejs'

export const maxDuration = 60

// ─── The time budget ──────────────────────────────────────────────────────────
//
// Two provider calls and some local work share one request, and every part of
// that has to be accounted for or the platform kills the request mid-flight and
// an employee gets a blank 504 instead of a sentence.
//
// The accounting, against maxDuration above:
//
//   local work        ~2s   prepare, measure, edge repair, resize, encode
//   background remove  25s  sync_mode: true, so the cut-out arrives INLINE in
//                           the response body. No separate download, and none
//                           is reserved — but the body itself is a multi-
//                           megabyte base64 data URI, and streaming it is part
//                           of this budget. Eighteen seconds was not enough,
//                           and cutting the body off mid-stream is what the
//                           incident behind this comment looked like.
//   product shot       20s  unchanged
//   hosted download     8s  the studio stage only: sync_mode is not sent there,
//                           so fal answers with a URL that has to be fetched
//                          ────
//                            55s  against a 56s budget, inside a 60s ceiling
//
// The sum is not the guarantee, though — it is only the intent. The guarantee
// is DEADLINE_AT below: every timeout is clamped to what is left of it, so an
// unexpected slow path degrades the next step instead of overrunning.

/** Of maxDuration, leaving headroom for the platform and for serialising the
 *  finished master into the response. */
const ROUTE_BUDGET_MS = 56_000

/** Everything sharp does: prepare, measure, repair the edge, resize, encode.
 *  Measured at well under a second for a megapixel photograph. */
const LOCAL_WORK_MS = 2_000

/** Background removal. The response body carries the whole cut-out inline. */
const CUTOUT_TIMEOUT_MS = 25_000

/** The studio scene is the slow one, even with `fast: true`. Unchanged. */
const STUDIO_TIMEOUT_MS = 20_000

// ─── Rate limiting ────────────────────────────────────────────────────────────
//
// Per user, in memory, same shape and the same reasoning as /api/payroll/ask:
// this is a spend guard on a route that costs money per call, not a security
// control.
//
// Six is deliberately left where it was even though a call now costs two
// requests: it is exactly the five-image queue plus one, so the ceiling still
// admits the largest run the page can start, and the real guard on spend is
// that a person has to press Generate.

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 6

const recentCalls = new Map<string, number[]>()

function rateLimited(userId: string): boolean {
  const now = Date.now()
  const recent = (recentCalls.get(userId) ?? []).filter(t => now - t < RATE_LIMIT_WINDOW_MS)

  if (recent.length >= RATE_LIMIT_MAX) {
    recentCalls.set(userId, recent)
    return true
  }

  recent.push(now)
  recentCalls.set(userId, recent)

  if (recentCalls.size > 500) {
    for (const [id, times] of recentCalls) {
      if (times.every(t => now - t >= RATE_LIMIT_WINDOW_MS)) recentCalls.delete(id)
    }
  }
  return false
}

// ─── Failure → status ─────────────────────────────────────────────────────────
//
// The distinctions the page cannot make for itself. A refused key and a busy
// provider both mean "no image", but one of them is worth retrying and the
// other needs an administrator, and the status code is how that reaches any
// future caller as well as the browser.

function statusFor(reason: StudioFailure): number {
  switch (reason) {
    case 'timeout':             return 504
    case 'rate_limited':        return 429
    case 'unsupported_image':
    case 'moderation':
    case 'empty_result':        return 422
    case 'invalid_key':
    case 'insufficient_credit':
    case 'reference_missing':   return 503
    default:                    return 502
  }
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Anchored before anything else, so reading a large upload counts against the
  // budget rather than quietly eating into the provider's share. The local work
  // is subtracted rather than hoped for: what is reserved here is the time
  // still needed AFTER the last provider call to encode the master and answer.
  const deadlineAt = Date.now() + ROUTE_BUDGET_MS - LOCAL_WORK_MS

  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: { user }, error: authErr } = await svc.auth.getUser(token)
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await svc.from('users').select('id').eq('id', user.id).single()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const apiKey = process.env.FAL_KEY
  // Answered before the upload is read: with no key there is nothing this route
  // can do with the bytes, and the page needs to say so honestly.
  if (!apiKey) return NextResponse.json({ configured: false }, { status: 200 })

  if (rateLimited(user.id)) {
    return NextResponse.json(
      { error: 'That is a lot of images at once. Please wait a moment and try again.' },
      { status: 429 },
    )
  }

  let file: File
  try {
    const form = await req.formData()
    const uploaded = form.get('image')
    if (!uploaded || typeof uploaded === 'string') {
      return NextResponse.json({ error: 'Choose a photograph to upload.' }, { status: 400 })
    }
    file = uploaded as File
  } catch {
    return NextResponse.json({ error: 'Failed to read the uploaded photograph.' }, { status: 400 })
  }

  // The same check the browser ran, run again here. The client-side one saves a
  // pointless upload; this one is the one that counts.
  const validation = validateSourceImage({ name: file.name, type: file.type, size: file.size })
  if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 })

  const bytes = Buffer.from(await file.arrayBuffer())
  // `file.size` is what the multipart part claimed. This is what actually
  // arrived, and it is what the size limit is enforced against.
  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: 'That file is empty. Choose another photograph.' }, { status: 400 })
  }
  if (bytes.byteLength > MAX_SOURCE_IMAGE_BYTES) {
    return NextResponse.json({ error: `That photograph is larger than ${MAX_SOURCE_IMAGE_LABEL}. Upload a smaller file.` }, { status: 400 })
  }

  const prepared = await prepareSourceImage(bytes, validation.mimeType)
  if (!prepared.ok) return NextResponse.json({ error: prepared.error }, { status: 400 })

  // ── Stage one: the cut-out, for its dimensions ──────────────────────────────
  const cutout = await removeBackground({
    bytes: prepared.bytes,
    mimeType: prepared.mimeType,
    apiKey,
    timeoutMs: CUTOUT_TIMEOUT_MS,
    deadlineAt,
  })

  if (!cutout.ok) {
    // The provider's own response text never reaches the log or the browser: a
    // category, a status code and fal's request id are enough to chase a
    // failure, and none of them can carry image data or a credential.
    console.error(
      '[image-editor/studio] cutout failed:',
      `category ${cutout.reason}`,
      `phase ${cutout.phase ?? '-'}`,
      `status ${cutout.status ?? '-'}`,
      `request ${cutout.requestId || '-'}`,
      `${cutout.durationMs} ms`,
    )

    return NextResponse.json(
      {
        error: cutout.message,
        ...(NO_RETRY_FAILURES.has(cutout.reason) ? { noRetry: true } : {}),
      },
      { status: statusFor(cutout.reason) },
    )
  }

  // ── Local: measure, plan the padding, crop and scale ────────────────────────
  const measured = await measureCutout(cutout.png)
  if (!measured.ok) {
    console.warn('[image-editor/studio] unusable cut-out, request', cutout.requestId || '-')
    return NextResponse.json({ error: measured.error, noRetry: true }, { status: 422 })
  }

  const product = { width: measured.bounds.width, height: measured.bounds.height }

  // The quality gate. A product too small to fill the master would have to be
  // enlarged, and enlarging invents nothing — so it is refused with the height
  // the photograph would have needed, before the second request is paid for.
  const verdict = checkEnlargement(product)
  if (!verdict.ok) {
    // Measurements only — sizes and ratios, never image data.
    console.warn('[image-editor/studio] refused on quality:',
      `product ${product.width}x${product.height}`,
      `would need ${verdict.scale.toFixed(2)}x (cap ${MAX_ENLARGEMENT})`,
      `needs about ${verdict.needed}px tall`,
      `request ${cutout.requestId || '-'}`)

    return NextResponse.json({ error: verdict.message, noRetry: true }, { status: 422 })
  }

  const plan = planPadding(product)

  const shaped = await prepareCutoutForShot(cutout.png, measured.bounds, plan.product)
  if (!shaped.ok) {
    console.error('[image-editor/studio] prepare failed, request', cutout.requestId || '-')
    return NextResponse.json({ error: shaped.error, noRetry: true }, { status: 422 })
  }

  // ── Stage two: the studio scene around it ───────────────────────────────────
  const studio = await generateStudioShot({
    cutoutPng: shaped.png,
    plan,
    apiKey,
    timeoutMs: STUDIO_TIMEOUT_MS,
    deadlineAt,
  })

  if (!studio.ok) {
    console.error(
      '[image-editor/studio] studio failed:',
      `category ${studio.reason}`,
      `phase ${studio.phase ?? '-'}`,
      `status ${studio.status ?? '-'}`,
      `request ${studio.requestId || '-'}`,
      `${studio.durationMs} ms`,
      // Only set for a missing reference, and it is a path, never file contents.
      studio.detail ?? '',
    )

    return NextResponse.json(
      {
        error: studio.message,
        ...(isNoRetry(studio.reason) ? { noRetry: true } : {}),
      },
      { status: statusFor(studio.reason) },
    )
  }

  console.info(
    '[image-editor/studio] ok:',
    `cutout request ${cutout.requestId || '-'} ${cutout.durationMs} ms`,
    `studio request ${studio.requestId || '-'} ${studio.durationMs} ms`,
    `product ${product.width}x${product.height}`,
    `scale ${plan.scale.toFixed(3)}x`,
    `placed ${plan.product.width}x${plan.product.height}`,
    `padding [${plan.paddingValues.join(', ')}]`,
    `height share ${(plan.heightShare * 100).toFixed(1)}%`,
    `edges repaired ${shaped.edges.repaired}`,
    shaped.edges.skippedThin ? `thin edges left alone ${shaped.edges.skippedThin}` : '',
    plan.widthLimited ? 'width-limited' : '',
  )

  return NextResponse.json({
    configured: true,
    image: {
      dataUrl: `data:${studio.contentType};base64,${studio.image.toString('base64')}`,
      mimeType: studio.contentType,
    },
  })
}
