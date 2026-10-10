import type { createClient } from '@/lib/supabase/client'
import { SCAN_LONG_SIDE, type ScanApiResponse, type ScanKind, type ScanResult } from './scan'

// The browser's half of scanning: shrink the photograph, send it, hand back the
// reading. A phone photo is 4–10 MB; at 1800 px on the long side a card is still
// perfectly legible and the upload is a few hundred KB — fast even on hall Wi-Fi.

type Supabase = ReturnType<typeof createClient>

export class ScanError extends Error {
  readonly code: Extract<ScanApiResponse, { ok: false }>['code']
  constructor(code: ScanError['code'], message: string) {
    super(message)
    this.name = 'ScanError'
    this.code = code
  }
}

/** Scale to SCAN_LONG_SIDE and re-encode as JPEG. EXIF orientation is applied by the decoder. */
export async function shrinkPhoto(file: Blob): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new ScanError('failed', 'This photo could not be opened. Take it again, or use a JPG or PNG.')
  }
  try {
    const scale = Math.min(1, SCAN_LONG_SIDE / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new ScanError('failed', 'This browser cannot prepare the photo. Type the details instead.')
    ctx.drawImage(bitmap, 0, 0, w, h)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    if (!blob) throw new ScanError('failed', 'This browser cannot prepare the photo. Type the details instead.')
    return blob
  } finally {
    bitmap.close()
  }
}

export async function scanPhoto(supabase: Supabase, photo: Blob, kind: ScanKind): Promise<ScanResult> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new ScanError('auth', 'Your session ended. Sign in again, then scan.')

  const body = new FormData()
  body.set('image', new File([photo], 'scan.jpg', { type: 'image/jpeg' }))
  body.set('kind', kind)

  let res: Response
  try {
    res = await fetch('/api/exhibition-leads/scan', {
      method: 'POST', body, headers: { Authorization: `Bearer ${session.access_token}` },
    })
  } catch {
    throw new ScanError('failed', 'No connection. Check the network, or type the details.')
  }
  const json = await res.json().catch(() => null) as ScanApiResponse | null
  if (!json) throw new ScanError('failed', 'Could not read the photo right now. Try again, or type the details.')
  if (!json.ok) throw new ScanError(json.code, json.error)
  return json.result
}
