// POST /api/image-editor/studio
//
// Takes one factory-background furniture photograph and returns one square
// studio image. Backs /image-editor and nothing else.
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
// One provider call and nothing else. `fal-ai/bria/product-shot` re-photographs
// the uploaded product into the studio scene held server-side in
// src/lib/imageEditor/briaProductShot.ts, and what it returns IS the finished
// image. There is no local composition, no cut-out, no drawn shadow and no
// resizing of the result: the 1000x1000 the model returns is what the employee
// downloads.
//
// COST
// ----
// One press of Generate is one billable request for exactly one result. Every
// setting that decides that — the model id, num_results, the placement type —
// is fixed in the adapter and unreachable from the browser, which sends nothing
// but the photograph. The adapter never retries, including after a timeout: a
// request that may already have been billed is not quietly billed again. The
// per-user rate limiter below is unchanged.
//
// THE API KEY
// -----------
// FAL_KEY, read here and passed to the adapter. It is never in a response body,
// never in a client bundle, and never in the URL of the provider call. With no
// key configured the route answers `configured: false` and the page says the
// service is not set up — it does not return a placeholder or a stock picture,
// because an image BOE cannot tell apart from a real one is worse than no
// image.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import {
  validateSourceImage,
  MAX_SOURCE_IMAGE_BYTES,
  MAX_SOURCE_IMAGE_LABEL,
} from '@/lib/imageEditor/validation'
import { prepareSourceImage } from '@/lib/imageEditor/prepareSource'
import {
  generateProductShot,
  NO_RETRY_FAILURES,
  type ProductShotFailure,
} from '@/lib/imageEditor/briaProductShot'

// sharp is a native module and the whole image is held in memory. Neither works
// on the edge runtime.
export const runtime = 'nodejs'

// Generation is tens of seconds, not hundreds of milliseconds. The adapter's own
// timeout sits just under this so a slow provider produces a clean "please try
// again" rather than a platform-level 504.
export const maxDuration = 60

// ─── Rate limiting ────────────────────────────────────────────────────────────
//
// Per user, in memory, same shape and the same reasoning as /api/payroll/ask:
// this is a spend guard on a route that costs money per call, not a security
// control. Lower ceiling because an image costs more than an answer.

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

function statusFor(reason: ProductShotFailure): number {
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

  const result = await generateProductShot({
    bytes: prepared.bytes,
    mimeType: prepared.mimeType,
    apiKey,
  })

  if (!result.ok) {
    // The provider's own response text never reaches the log or the browser:
    // a category, a status code and fal's request id are enough to chase a
    // failure, and none of them can carry image data or a credential.
    console.error(
      '[image-editor/studio] failed:',
      `category ${result.reason}`,
      `status ${result.status ?? '-'}`,
      `request ${result.requestId || '-'}`,
      `${result.durationMs} ms`,
    )

    return NextResponse.json(
      {
        error: result.message,
        // Some failures cannot be helped by pressing the button again — a
        // refused key, an empty account, a photograph the model will not take.
        // The page offers a different photograph instead of a retry.
        ...(NO_RETRY_FAILURES.has(result.reason) ? { noRetry: true } : {}),
      },
      { status: statusFor(result.reason) },
    )
  }

  console.info(
    '[image-editor/studio] ok:',
    `request ${result.requestId || '-'}`,
    `${result.durationMs} ms`,
    `${result.image.width ?? '?'}x${result.image.height ?? '?'}`,
    result.image.contentType,
  )

  return NextResponse.json({
    configured: true,
    image: {
      // Straight from the provider, at its native size and format. Nothing is
      // upscaled, recompressed or recomposed.
      dataUrl: result.image.dataUrl,
      mimeType: result.image.contentType,
    },
  })
}
