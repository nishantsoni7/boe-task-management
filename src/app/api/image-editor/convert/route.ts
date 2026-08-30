// POST /api/image-editor/convert
//
// Re-encodes one finished studio image as PNG, JPG or WebP so an employee can
// download the format they need. Backs the download menu on /image-editor.
//
// WHAT THIS IS NOT
// ----------------
// It is not a second generation. It never calls fal, it holds no provider key,
// and it cannot cost BOE anything: the bytes it re-encodes are an image already
// paid for, sent back up from the browser that is holding it. A conversion is a
// format change and nothing else — same pixels, same dimensions.
//
// AUTH
// ----
// The same bearer check as the studio route, for the same reason: this runs
// sharp on an uploaded file, and an open endpoint that decodes arbitrary images
// is an invitation. It is rate limited too — generously, because the work is
// local CPU rather than money, but not unboundedly.
//
// Nothing is stored: the upload is read into memory, re-encoded, returned, and
// gone when the request ends.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { hasPermission } from '@/lib/permissions/resolver'
import { isAdminRole } from '@/lib/permissions/moduleVisibility'
import { IMAGE_EDITOR_MODULE_KEY } from '@/lib/permissions/imageEditor'
import { NextRequest, NextResponse } from 'next/server'
import { convertImage, isDownloadFormat } from '@/lib/imageEditor/imageFormats'

// sharp is a native module.
export const runtime = 'nodejs'
export const maxDuration = 30

/** A studio image is about a megapixel; this leaves room for any of the three
 *  shapes in a lossless format without inviting arbitrary large uploads. */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024

// Per user, in memory. Higher than the generation limit because a conversion
// costs CPU rather than credit — a person downloading one image in all three
// formats must not be told to wait.
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 40

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

/** Whether this caller may re-encode. Admins bypass, as everywhere else. */
async function canConvert(
  svc: SupabaseClient,
  userId: string,
  role: string | null | undefined,
): Promise<boolean> {
  if (isAdminRole(role)) return true
  if (!role) return false
  return hasPermission(svc, userId, IMAGE_EDITOR_MODULE_KEY, 'view')
}

export async function POST(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: { user }, error: authErr } = await svc.auth.getUser(token)
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await svc.from('users').select('id, role').eq('id', user.id).single()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ── Permission ──────────────────────────────────────────────────────────────
  //
  // 'view' only, and deliberately so. This route re-encodes an image the caller
  // is already holding in their browser — it calls no provider and costs
  // nothing. Requiring 'create' would mean an employee whose Use access was
  // revoked could no longer download work they had already generated, which is
  // punishment rather than access control.
  //
  // 'view' is still the module's parent gate, so somebody who cannot open the
  // Image Editor cannot use this route as a side door into sharp.
  if (!(await canConvert(svc, user.id, profile.role))) {
    return NextResponse.json(
      { error: 'You do not have permission to use the Image Editor.' },
      { status: 403 },
    )
  }

  if (rateLimited(user.id)) {
    return NextResponse.json(
      { error: 'That is a lot of downloads at once. Please wait a moment and try again.' },
      { status: 429 },
    )
  }

  let file: File
  let format: unknown
  try {
    const form = await req.formData()
    const uploaded = form.get('image')
    if (!uploaded || typeof uploaded === 'string') {
      return NextResponse.json({ error: 'No image to convert.' }, { status: 400 })
    }
    file = uploaded as File
    format = form.get('format')
  } catch {
    return NextResponse.json({ error: 'Failed to read the image.' }, { status: 400 })
  }

  // An allowlist, not a pass-through: the format names a sharp encoder, and
  // only these three may be reached.
  if (!isDownloadFormat(format)) {
    return NextResponse.json({ error: 'That download format is not supported.' }, { status: 400 })
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: 'That image could not be converted.' }, { status: 400 })
  }

  const converted = await convertImage(bytes, format)
  if (!converted.ok) {
    return NextResponse.json({ error: converted.error }, { status: 422 })
  }

  return NextResponse.json({
    image: {
      dataUrl: `data:${converted.image.contentType};base64,${converted.image.bytes.toString('base64')}`,
      mimeType: converted.image.contentType,
      extension: converted.image.extension,
      width: converted.image.width,
      height: converted.image.height,
    },
  })
}
