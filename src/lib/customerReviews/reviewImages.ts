// Review images — the constants, the slot rule, and the validation both ends
// of the upload share.
//
// WHAT THESE IMAGES ARE, AND HOW THEY DIFFER FROM THE OTHER KIND. A
// `test_screenshot` is a picture of BOE's own screen, attached by the tester
// holding a card, and it never goes anywhere. A `review_image` is a picture of
// the FURNITURE a review is about: it is attached by a VERIFIER while the draft
// is still pending, it survives approval, and it is offered to the person who
// shares the approved review. The two kinds live in one table and one bucket
// because the storage question — "may this person see this card?" — has the
// same answer for both. Everything else about them differs, which is why the
// route, the permission and the window are separate.
//
// THIS FILE HOLDS NO CREDENTIAL and reads no environment. It is imported by a
// route AND by a Client Component, so it must stay safe for both.

import type { SupportedImageMime } from './imageBytes'

/**
 * The same private bucket the screenshots use.
 *
 * DELIBERATE REUSE, not laziness. The bucket is already private, already capped
 * at 5 MB, already limited to JPEG/PNG/WebP, and its storage SELECT policy
 * resolves ownership through can_view_customer_review_test_card() on the first
 * path segment. That policy asks exactly the right question about a review
 * image too. A second bucket would be a second copy of it, and two copies of an
 * authorization rule is how one of them gets left behind.
 *
 * The name says "screenshots" because that is what the bucket held when it was
 * made. Renaming a bucket means moving every object in it, which is a real
 * migration with a real failure mode, in exchange for a better noun.
 */
export const REVIEW_IMAGE_BUCKET = 'customer-review-test-screenshots'

/** The `kind` discriminator on customer_review_test_card_screenshots. */
export const REVIEW_IMAGE_KIND = 'review_image' as const

/**
 * FOUR, AS SLOTS RATHER THAN AS A COUNT.
 *
 * Four images, so four slots, numbered 0 to 3. Every attached image holds one,
 * and `customer_review_image_one_live_per_slot` is a unique index over
 * (card_id, image_slot) — so two uploads racing for the last place cannot both
 * win, which a count read before an insert can never promise.
 *
 * The route still counts before it decodes five megabytes. That is a courtesy.
 * The index is the guarantee, and reviewImages.test.ts is what pins the two
 * together.
 */
export const MAX_REVIEW_IMAGES = 4

/** Every slot, in order. The lowest free one is the one an upload takes. */
export const REVIEW_IMAGE_SLOTS = [0, 1, 2, 3] as const

/** Must match allowed_mime_types on the bucket. Still images only. */
export const REVIEW_IMAGE_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

/** Must equal file_size_limit on the same bucket. 5 MB. */
export const REVIEW_IMAGE_MAX_BYTES = 5 * 1024 * 1024

export const REVIEW_IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp'
export const REVIEW_IMAGE_TYPES_LABEL = 'JPG, PNG or WEBP'

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
export function reviewImageContentType(file: { name: string; type: string }): string | null {
  if ((REVIEW_IMAGE_ALLOWED_TYPES as readonly string[]).includes(file.type)) return file.type
  if (file.type) return null
  return EXT_TYPES[extOf(file.name)] ?? null
}

/**
 * Validate a candidate image. Returns a sentence to show, or null.
 *
 * A COURTESY, EXPLICITLY NOT THE BOUNDARY — the same standing this function's
 * twin in photos.ts has. It saves a five-megabyte round trip to be told no, and
 * it is the only thing here that looks at a filename or a browser-reported
 * type, both of which are claims.
 *
 * The boundary is POST /api/customer-reviews/images, which reads the bytes and
 * decodes the image, and which is the only writer the database admits.
 */
export function validateReviewImage(file: { name: string; type: string; size: number }): string | null {
  if (file.size === 0) return 'That file is empty.'
  if (file.size > REVIEW_IMAGE_MAX_BYTES) return 'Each image must be under 5 MB.'
  if (!reviewImageContentType(file)) return `Only ${REVIEW_IMAGE_TYPES_LABEL} images can be attached.`
  return null
}

/**
 * The lowest slot nothing live is holding, or null when all four are taken.
 *
 * A GAP IS REUSED rather than appended past. Removing the image in slot 1 and
 * attaching another gives the new one slot 1, so the slots stay 0..3 and the
 * fourth attachment after three removals is still the fourth, not the seventh.
 *
 * Pure, and separately tested, because the route's answer and the index's
 * answer have to be the same answer for the error a verifier sees to make
 * sense.
 */
export function nextFreeSlot(taken: readonly number[]): number | null {
  const used = new Set(taken)
  for (const slot of REVIEW_IMAGE_SLOTS) {
    if (!used.has(slot)) return slot
  }
  return null
}

/** The file extension to store a processed image under. */
export function extensionForMime(mime: SupportedImageMime): string {
  return mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'webp'
}

/**
 * A safe object key under the card's folder.
 *
 * THE FIRST PATH SEGMENT IS ALWAYS THE CARD ID, because the storage policies
 * read ownership out of split_part(name, '/', 1) and the metadata row's
 * customer_review_screenshot_path_matches_card constraint checks the two agree.
 * Nothing a caller typed reaches the path — the uuid is generated by the
 * server and the extension comes from what the bytes decoded as.
 */
export function buildReviewImagePath(cardId: string, unique: string, extension: string): string {
  return `${cardId}/${REVIEW_IMAGE_KIND}/${unique}.${extension}`
}
