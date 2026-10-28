import type { createClient } from '@/lib/supabase/client'
import { newSubmissionId } from '@/lib/exhibitionLeads/draft'

// Photographs of a vendor visit: shrunk in the browser, kept in the PRIVATE bucket under the uploader's own
// folder, shown through short-lived signed links. The path is '{uploader uuid}/{uuid}.jpg' — the shape the
// bucket policy, the table CHECK and log_vendor_visit all require.

type Supabase = ReturnType<typeof createClient>

export const VENDOR_PHOTO_BUCKET = 'vendor-visit-photos'
export const PHOTO_LONG_SIDE = 1800

export const newPhotoPath = (userId: string) => `${userId}/${newSubmissionId()}.jpg`

/** Scale to PHOTO_LONG_SIDE and re-encode as JPEG. EXIF orientation is applied by the decoder. */
export async function shrinkPhoto(file: Blob): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new Error('This photo could not be opened. Take it again, or use a JPG or PNG.')
  }
  try {
    const scale = Math.min(1, PHOTO_LONG_SIDE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('This browser cannot prepare the photo.')
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    if (!blob) throw new Error('This browser cannot prepare the photo.')
    return blob
  } finally {
    bitmap.close()
  }
}

export async function uploadVendorPhoto(supabase: Supabase, userId: string, photo: Blob): Promise<string> {
  const path = newPhotoPath(userId)
  const { error } = await supabase.storage.from(VENDOR_PHOTO_BUCKET).upload(path, photo, {
    contentType: 'image/jpeg', upsert: false, cacheControl: '3600',
  })
  if (error) throw new Error(error.message || 'The photo could not be uploaded')
  return path
}

/** Five minutes is plenty to look at it; the link is not kept. */
export async function signedVendorPhotoUrl(supabase: Supabase, path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(VENDOR_PHOTO_BUCKET).createSignedUrl(path, 300)
  return error ? null : data.signedUrl
}
