import type { createClient } from '@/lib/supabase/client'
import { INVENTORY_BUCKET } from './constants'

type Supabase = ReturnType<typeof createClient>

const MAX_EDGE = 1600

/** Scale so the longer side is at most `maxEdge`; never enlarge. */
export function fitWithin(width: number, height: number, maxEdge: number = MAX_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { width, height }
  const k = maxEdge / longest
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }
}

/**
 * A phone photograph is 4-12 MB. The bucket takes up to 3 MB and a customer on WhatsApp does not need more
 * than 1600 px, so every picture is re-drawn on a canvas and saved as a JPEG first. The browser applies the
 * camera's rotation while decoding, so an upright phone shot stays upright.
 */
export async function toJpeg(file: Blob, quality = 0.86): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('This browser cannot prepare the picture')
    ctx.fillStyle = '#ffffff' // a transparent PNG becomes white, not black
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(bitmap, 0, 0, width, height)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
    if (!blob) throw new Error('The picture could not be prepared')
    return blob
  } finally {
    bitmap.close()
  }
}

/** '{uploader}/{uuid}.jpg' — the shape the bucket policy and the table CHECK both require. */
export const newImagePath = (userId: string) => `${userId}/${crypto.randomUUID()}.jpg`

export async function uploadImage(s: Supabase, userId: string, file: Blob): Promise<string> {
  const jpeg = await toJpeg(file)
  const path = newImagePath(userId)
  const { error } = await s.storage.from(INVENTORY_BUCKET).upload(path, jpeg, {
    contentType: 'image/jpeg', upsert: false, cacheControl: '31536000',
  })
  if (error) throw new Error(error.message || 'The picture could not be uploaded')
  return path
}

/** An absolute, public address: it must open for a customer who is not signed in. */
export function imageUrl(s: Supabase, path: string): string {
  return s.storage.from(INVENTORY_BUCKET).getPublicUrl(path).data.publicUrl
}

/** Remove uploads that were never attached to a product (the form was abandoned). Best effort. */
export async function discardUploads(s: Supabase, paths: string[]): Promise<void> {
  if (!paths.length) return
  try { await s.storage.from(INVENTORY_BUCKET).remove(paths) } catch { /* the bucket policy refuses anything that is attached */ }
}
