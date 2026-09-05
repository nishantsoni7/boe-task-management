// The project image library — the constants, the path rule, and the validation
// both ends of an upload share.
//
// WHAT A PROJECT IMAGE GROUP IS. One project's photographs, held together so
// that an image review can point at the SET rather than at four images somebody
// picked one at a time. Picking images individually is exactly the thing that
// would put two projects into one candidate's post; picking a group cannot.
//
// HOW IT DIFFERS FROM A REVIEW IMAGE. `review_image` (./reviewImages) attaches
// up to four photographs TO ONE REVIEW, in the review's own folder, while that
// review is still a pending draft. A group image belongs to a PROJECT, is
// reused across reviews and across employees over time, and has no review of
// its own. They share a shape and nothing else — different table, different
// bucket, different lifetime.
//
// THIS FILE HOLDS NO CREDENTIAL and reads no environment. It is imported by a
// route AND by a Client Component, so it must stay safe for both.

import type { SupportedImageMime } from './imageBytes'

/**
 * A SECOND PRIVATE BUCKET, and the reason is not tidiness.
 *
 * `customer-review-test-screenshots` has a storage SELECT policy that resolves
 * ownership by reading split_part(name, '/', 1) as a CARD id. A project image is
 * not owned by a card — it is owned by a group that several cards may point at —
 * so putting one there would mean either a path whose first segment is a lie, or
 * that policy widened to accept two meanings for one segment. Both are worse
 * than a second bucket with the same shape.
 *
 * SAME SHAPE, DELIBERATELY: private, 5 MB, JPEG/PNG/WebP, no client INSERT and
 * no client DELETE policy on storage.objects. The bytes arrive only through the
 * service role, after the route has decoded and re-encoded them.
 */
export const GROUP_IMAGE_BUCKET = 'customer-review-project-images'

/** Must match allowed_mime_types on the bucket. Still images only. */
export const GROUP_IMAGE_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

/** Must equal file_size_limit on the same bucket. 5 MB. */
export const GROUP_IMAGE_MAX_BYTES = 5 * 1024 * 1024

export const GROUP_IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp'
export const GROUP_IMAGE_TYPES_LABEL = 'JPG, PNG or WEBP'

/**
 * HOW MANY IMAGES A PROJECT GROUP MAY HOLD.
 *
 * Higher than the four a single review carries, because a group is a project's
 * whole set and different reviews may show different parts of it. It is a bound
 * on storage rather than a rule about a post, which is why it is generous and
 * why exceeding it is a plain refusal rather than a slot collision — there are
 * no slots here, and nothing depends on which image is which.
 */
export const MAX_GROUP_IMAGES = 20

/** The longest an internal project label may be. Matches the column CHECK. */
export const MAX_GROUP_LABEL = 120

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
 * The `includes('.')` guard is load-bearing for the same reason it is in
 * photos.ts: `'photo'.split('.').pop()` is `'photo'`.
 */
function extOf(fileName: string): string {
  if (!fileName.includes('.')) return ''
  return fileName.split('.').pop()?.toLowerCase() ?? ''
}

/**
 * The MIME type to upload as, or null when the file is not one we accept.
 *
 * Prefers the browser-reported type; falls back to the extension only when the
 * browser reported nothing. An extension can never launder a disallowed type.
 */
export function groupImageContentType(file: { name: string; type: string }): string | null {
  if ((GROUP_IMAGE_ALLOWED_TYPES as readonly string[]).includes(file.type)) return file.type
  if (file.type) return null
  return EXT_TYPES[extOf(file.name)] ?? null
}

/**
 * Validate a candidate image. Returns a sentence to show, or null.
 *
 * A COURTESY, EXPLICITLY NOT THE BOUNDARY — the same standing its twins in
 * photos.ts and reviewImages.ts have. It saves a five-megabyte round trip to be
 * told no, and it is the only thing here that looks at a filename or a
 * browser-reported type, both of which are claims.
 *
 * The boundary is POST /api/customer-reviews/image-groups, which reads the
 * bytes and decodes the image, and which is the only writer the database admits.
 */
export function validateGroupImage(file: { name: string; type: string; size: number }): string | null {
  if (file.size === 0) return 'That file is empty.'
  if (file.size > GROUP_IMAGE_MAX_BYTES) return 'Each image must be under 5 MB.'
  if (!groupImageContentType(file)) return `Only ${GROUP_IMAGE_TYPES_LABEL} images can be added.`
  return null
}

export type GroupLabelCheck =
  | { ok: true; label: string }
  | { ok: false; error: string }

/**
 * The one field a caller supplies, bounded before it reaches the database.
 *
 * Same rule both ends, so the form cannot accept a name the server will reject
 * and the database cannot be handed one the form would have refused.
 */
export function validateGroupLabel(raw: unknown): GroupLabelCheck {
  if (typeof raw !== 'string') return { ok: false, error: 'Give the project group a name.' }
  const label = raw.trim()
  if (!label) return { ok: false, error: 'Give the project group a name.' }
  if (label.length > MAX_GROUP_LABEL) {
    return { ok: false, error: `A project name is limited to ${MAX_GROUP_LABEL} characters.` }
  }
  return { ok: true, label }
}

/** The file extension to store a processed image under. */
export function extensionForGroupMime(mime: SupportedImageMime): string {
  return mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'webp'
}

/**
 * A safe object key under the group's folder.
 *
 * THE FIRST PATH SEGMENT IS ALWAYS THE GROUP ID, because the storage policy
 * reads ownership out of split_part(name, '/', 1) and the metadata row's
 * customer_review_group_image_path_matches_group constraint checks the two
 * agree. Nothing a caller typed reaches the path — the uuid is generated by the
 * server and the extension comes from what the bytes decoded as.
 */
export function buildGroupImagePath(groupId: string, unique: string, extension: string): string {
  return `${groupId}/${unique}.${extension}`
}
