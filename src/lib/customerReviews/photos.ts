// Project photographs and review proof — validation and object keys.
//
// Deliberately scoped to this module (not a general media system). Mirrors
// src/lib/paymentProof.ts, which is the established BOE private-storage
// pattern: a private bucket, a fully generated object key, and validation that
// matches the bucket's own limits exactly so a file that passes here cannot
// then be refused by Storage.
//
// WHAT THESE IMAGES ARE
//   project_photo  an ACTUAL photograph of work BOE did for this customer. Not
//                  stock imagery, not a rendering, not a photograph of somebody
//                  else's job.
//   review_proof   optional evidence, attached afterwards, that a review was
//                  published. Never a substitute for a review, and never
//                  something the module generates.
//
// SELECTING AN EXISTING PROJECT PHOTOGRAPH is not implemented, on purpose. BOE
// has no cross-module media library — the images that exist live inside Order
// submissions and Showroom products, each behind its own bucket and its own
// authorization rules — and building one to satisfy a "select existing" button
// would be a far larger piece of work than this module. Upload is the MVP path;
// see the module doc's Known limitations.

export const REVIEW_PHOTO_BUCKET = 'customer-review-photos'

/**
 * Must match allowed_mime_types on the bucket in
 * supabase/migrations/20261017000000_customer_review_outreach.sql. Still images
 * only — no PDF, no video, no container format.
 */
export const REVIEW_PHOTO_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

/** Must equal file_size_limit on the same bucket. 5 MB. */
export const REVIEW_PHOTO_MAX_BYTES = 5 * 1024 * 1024

/** How many project photographs one request may carry. Small on purpose. */
export const MAX_PROJECT_PHOTOS = 6

export const REVIEW_PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp'
export const REVIEW_PHOTO_TYPES_LABEL = 'JPG, PNG or WEBP'

/** Extension → MIME, used only when the browser leaves file.type blank. */
const EXT_TYPES: Record<string, string> = {
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  webp: 'image/webp',
}

/**
 * The extension, or '' when the filename has none.
 *
 * The `includes('.')` guard is load-bearing: `'photo'.split('.').pop()` is
 * `'photo'`, so without it a file with no extension would be stored as
 * `<uuid>.photo` and its whole name would have leaked into the object key.
 */
function extOf(fileName: string): string {
  if (!fileName.includes('.')) return ''
  return fileName.split('.').pop()?.toLowerCase() ?? ''
}

/**
 * The MIME type to upload as.
 *
 * Prefers the browser-reported type; falls back to the extension only when the
 * browser reported nothing at all. An extension can never launder a disallowed
 * type — a file that says it is a PDF is refused whatever it is called.
 */
export function reviewPhotoContentType(file: { name: string; type: string }): string | null {
  if ((REVIEW_PHOTO_ALLOWED_TYPES as readonly string[]).includes(file.type)) return file.type
  if (file.type) return null
  return EXT_TYPES[extOf(file.name)] ?? null
}

/**
 * Validate a candidate image. Returns a sentence to show, or null when the file
 * is acceptable.
 *
 * A COURTESY, EXPLICITLY NOT THE BOUNDARY. It saves a five-megabyte round trip
 * to be told no, and it is the only thing in this module that ever looks at a
 * filename or a browser-reported type — both of which are claims.
 *
 * The boundary is /api/customer-reviews/photos, which reads the bytes and parses
 * the container (see ./imageBytes), and which is the only writer the database
 * admits: the `authenticated` role holds neither a storage INSERT policy nor an
 * INSERT privilege on the metadata table. A file that gets past this function is
 * still refused there if it is not what it claims to be.
 */
export function validateReviewPhoto(file: { name: string; type: string; size: number }): string | null {
  if (file.size === 0) return 'That file is empty.'
  if (file.size > REVIEW_PHOTO_MAX_BYTES) return 'Each photo must be under 5 MB.'
  if (!reviewPhotoContentType(file)) return `Only ${REVIEW_PHOTO_TYPES_LABEL} images can be attached.`
  return null
}

/**
 * A safe, unique object key under the request's folder.
 *
 * NOT USED TO UPLOAD ANY MORE. The trusted route generates its own key from the
 * request id and a fresh uuid, because a path a client can choose is a path a
 * client can aim at another request's folder — and the browser cannot write an
 * object at all now. This is kept as the readable statement of the SHAPE both
 * sides rely on, and its test is what pins that shape:
 *
 * THE FIRST PATH SEGMENT IS ALWAYS THE REQUEST ID, because the storage policies
 * read ownership out of split_part(name, '/', 1) and the metadata row's
 * customer_review_photos_path_matches_request constraint checks the two agree.
 * Nothing a user typed reaches the path, only a sanitised extension.
 */
export function buildReviewPhotoPath(
  requestId: string,
  kind: 'project_photo' | 'review_proof',
  fileName: string,
): string {
  const ext = extOf(fileName).replace(/[^a-z0-9]/g, '') || 'jpg'
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  return `${requestId}/${kind}/${unique}.${ext}`
}

/** Human file size for the attachment list. */
export function formatPhotoSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
