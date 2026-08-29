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
// BOE is refused. No permission grant is read.
//
// WHAT IS STORED
// --------------
// Nothing. The upload is read into memory, prepared, sent to the provider, and
// the result is returned in the response body. No Supabase Storage object, no
// table, no temporary file on disk.
//
// HOW THE IMAGE IS MADE
// ---------------------
// ONE provider call, and it does one thing: `fal-ai/bria/background/remove`
// returns the product on transparency. Everything after that is local:
//
//   measure the alpha -> gate the enlargement -> plan the padding
//   -> decontaminate the edge -> one proportional resize -> edge-safe sharpen
//   -> composite over a locally drawn sweep, with locally drawn shadows
//
// THE RULE
// --------
// The final visible furniture is the cut-out and nothing else. No generative
// model repaints the product, because one did: asked to place the chair into a
// generated scene, Bria Product Shot turned the fan of thin spindles under the
// seat into a dark continuous mass and filled the openings between them.
// Placing a product into a generated scene means harmonising it with that
// scene's light, and harmonising is repainting. So the model segments, and BOE
// draws everything else.
//
// COST
// ----
// One call of this route is ONE billable request. A queue of five images is
// five requests, made one after another by the browser — nothing here batches
// and nothing here loops. The adapter never retries, including after a timeout:
// a request that may already have been billed is not quietly billed again.
//
// THE API KEY
// -----------
// FAL_KEY, read here and passed to the adapter. It is never in a response body,
// never in a client bundle, and never in the URL of the provider call. With no
// key configured the route answers `configured: false` and the page says the
// service is not set up — it does not return a placeholder, because an image
// BOE cannot tell apart from a real one is worse than no image.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import {
  validateSourceImage,
  MAX_SOURCE_IMAGE_BYTES,
  MAX_SOURCE_IMAGE_LABEL,
} from '@/lib/imageEditor/validation'
import { prepareSourceImage } from '@/lib/imageEditor/prepareSource'
import { removeBackground, NO_RETRY_FAILURES, type CutoutFailure } from '@/lib/imageEditor/briaBackgroundRemove'
import { measureCutout, prepareCutoutForShot } from '@/lib/imageEditor/prepareCutout'
import { planPadding, checkEnlargement, MAX_ENLARGEMENT } from '@/lib/imageEditor/studioMaster'
import { composeStudioScene } from '@/lib/imageEditor/studioScene'

// sharp is a native module and the whole image is held in memory. Neither works
// on the edge runtime.
export const runtime = 'nodejs'

export const maxDuration = 60

// ─── The time budget ──────────────────────────────────────────────────────────
//
// One provider call and some local work share one request:
//
//   local work         4s   prepare, measure, edge repair, resize, sharpen,
//                           sweep and shadows at 1440 x 1440, encode
//   background remove  25s  sync_mode: true, so the cut-out arrives INLINE in
//                           the response body. No separate download, and none
//                           is reserved. The body is a multi-megabyte base64
//                           data URI and streaming it is part of this budget —
//                           eighteen seconds once was not, and cutting the body
//                           off mid-stream was reported as an empty result.
//                     ────
//                       29s  against a 50s budget, inside a 60s ceiling
//
// The sum is only the intent. The guarantee is the deadline below: the
// adapter's timeout is clamped to what is left of it, so a slow upload degrades
// the provider call rather than overrunning the platform.

/** Of maxDuration, leaving headroom for the platform and for serialising a
 *  1440 x 1440 master into the response. */
const ROUTE_BUDGET_MS = 50_000

/** Everything sharp does. Larger than it was because the canvas is now
 *  1440 x 1440 and the sweep is drawn pixel by pixel. */
const LOCAL_WORK_MS = 4_000

/** Background removal. The response body carries the whole cut-out inline. */
const CUTOUT_TIMEOUT_MS = 25_000

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

function statusFor(reason: CutoutFailure): number {
  switch (reason) {
    case 'timeout':             return 504
    case 'rate_limited':        return 429
    case 'unsupported_image':
    case 'moderation':
    case 'empty_result':        return 422
    case 'invalid_key':
    case 'insufficient_credit': return 503
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

  // ── The one provider call ───────────────────────────────────────────────────
  const cutout = await removeBackground({
    bytes: prepared.bytes,
    mimeType: prepared.mimeType,
    apiKey,
    timeoutMs: CUTOUT_TIMEOUT_MS,
    deadlineAt,
  })

  if (!cutout.ok) {
    // The provider's own response text never reaches the log or the browser: a
    // category, a phase, a status code and fal's request id are enough to chase
    // a failure, and none can carry image data or a credential.
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

  // ── Local from here on. No network, no model. ───────────────────────────────
  const measured = await measureCutout(cutout.png)
  if (!measured.ok) {
    console.warn('[image-editor/studio] unusable cut-out, request', cutout.requestId || '-')
    return NextResponse.json({ error: measured.error, noRetry: true }, { status: 422 })
  }

  const product = { width: measured.bounds.width, height: measured.bounds.height }

  // The quality gate. A product too small for the master would have to be
  // enlarged, and enlarging invents nothing — so it is refused with the height
  // the photograph would have needed, rather than made soft.
  const verdict = checkEnlargement(product)
  if (!verdict.ok) {
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

  const scene = await composeStudioScene(shaped.png, plan)
  if (!scene.ok) {
    console.error('[image-editor/studio] compose failed, request', cutout.requestId || '-')
    return NextResponse.json({ error: scene.error, noRetry: true }, { status: 422 })
  }

  console.info(
    '[image-editor/studio] ok:',
    `request ${cutout.requestId || '-'} ${cutout.durationMs} ms`,
    `product ${product.width}x${product.height}`,
    `enlargement ${shaped.scale.toFixed(3)}x`,
    `placed ${plan.product.width}x${plan.product.height}`,
    `padding [${plan.paddingValues.join(', ')}]`,
    `height share ${(plan.heightShare * 100).toFixed(1)}%`,
    `master ${scene.metrics.canvas.width}x${scene.metrics.canvas.height}`,
    `edges repaired ${shaped.edges.repaired}`,
    `feet ${scene.metrics.contactColumns} columns`,
    plan.widthLimited ? 'width-limited' : '',
  )

  return NextResponse.json({
    configured: true,
    image: {
      dataUrl: `data:image/png;base64,${scene.png.toString('base64')}`,
      mimeType: 'image/png',
    },
  })
}
