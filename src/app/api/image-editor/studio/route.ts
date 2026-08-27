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
// THE API KEY
// -----------
// GEMINI_API_KEY, read here and passed to the adapter. It is never in a
// response body, never in a client bundle, and never in the URL of the provider
// call. With no key configured the route answers `configured: false` and the
// page says the service is not set up — it does not return a placeholder or a
// stock picture, because an image BOE cannot tell apart from a real edit is
// worse than no image.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import {
  validateSourceImage,
  MAX_SOURCE_IMAGE_BYTES,
  MAX_SOURCE_IMAGE_LABEL,
} from '@/lib/imageEditor/validation'
import { prepareSourceImage } from '@/lib/imageEditor/prepareSource'
import { generateStudioImage } from '@/lib/imageEditor/geminiStudioImage'

// sharp is a native module, and the provider call needs the whole request body
// in memory. Neither works on the edge runtime.
export const runtime = 'nodejs'

// Image editing is tens of seconds, not hundreds of milliseconds. The adapter's
// own timeout sits just under this so a slow provider produces a clean "please
// try again" rather than a platform-level 504.
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

  const apiKey = process.env.GEMINI_API_KEY
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

  const result = await generateStudioImage({
    base64: prepared.base64,
    mimeType: prepared.mimeType,
    apiKey,
    model: process.env.GEMINI_IMAGE_MODEL,
  })

  if (!result.ok) {
    // Provider text can echo request content and carries no meaning for an
    // employee. It goes to the server log; the browser gets the sentence above.
    if (result.detail) console.error('[image-editor/studio]', result.reason, result.detail)
    else console.error('[image-editor/studio]', result.reason)

    const status = result.reason === 'timeout' ? 504 : result.reason === 'no_image' ? 422 : 502
    return NextResponse.json({ error: result.message }, { status })
  }

  return NextResponse.json({
    configured: true,
    image: {
      // A data URL, so the page can render it, compare it and download it with
      // no storage bucket behind any of those three.
      dataUrl: `data:${result.image.mimeType};base64,${result.image.base64}`,
      mimeType: result.image.mimeType,
    },
  })
}
