// Which product images this system can actually keep — one rule, one place.
//
// WHY THIS MODULE EXISTS. The rule used to be stated twice: the parser accepted
// six sniffed formats, and the persistence layer accepted three. A PI whose
// product photograph was a GIF or a BMP therefore passed every check the
// employee could see — no blocking issue, a rendered preview, a successful
// "Draft saved" — and then quietly reached the database with no representative
// image at all. The gap only surfaced later, at submission, long after the
// employee had moved on.
//
// So the accepted set lives here, and the parser, the preview and the server
// payload builder all read it from this module. A format that cannot be stored
// is now refused at the point a person can still do something about it: the
// parser raises a blocking issue for a representative image and a warning for a
// customization image, and both name the product row.
//
// WHY THESE THREE. They are what the order-files bucket admits
// (20260908000000) and what order_submission_item_images.mime_type allows
// (20260909000000). Widening this set means widening both, in that order.
//
// The sniffer deliberately still RECOGNISES gif, bmp and tiff — that is how a
// message can say "this is a GIF" instead of "this is unreadable".

import type { PiProductImage } from './types'

/** The only formats that may be persisted. */
export const PI_STORABLE_IMAGE_FORMATS = ['png', 'jpeg', 'webp'] as const

export type PiStorableImageFormat = (typeof PI_STORABLE_IMAGE_FORMATS)[number]

/** Sniffed format → the MIME type the object is stored under. */
export const PI_STORABLE_IMAGE_MIME: Record<PiStorableImageFormat, string> = {
  png:  'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

/** Stored MIME type → the extension its object key carries. */
export const PI_STORABLE_IMAGE_EXTENSION: Record<string, string> = {
  'image/png':  'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/** What an employee is told to use instead. */
export const PI_ACCEPTED_IMAGE_LABEL = 'PNG, JPG/JPEG or WebP'

export function isStorableImageFormat(format: PiProductImage['format']): boolean {
  return (PI_STORABLE_IMAGE_FORMATS as readonly string[]).includes(format)
}

/**
 * The MIME type an image may be stored under, or null when it may not be
 * stored at all.
 *
 * Keyed on the type the parser SNIFFED from the magic bytes, never on a file
 * extension or a declared header, so a .png that is really a TIFF is refused
 * rather than mislabelled.
 */
export function storableImageMime(mimeType: string | null): string | null {
  if (!mimeType) return null
  return mimeType in PI_STORABLE_IMAGE_EXTENSION ? mimeType : null
}

/**
 * How a rejected image is named in a message a person reads: "a GIF image",
 * "an unrecognised image". Never the raw enum value.
 */
export function describeImageFormat(format: PiProductImage['format']): string {
  switch (format) {
    case 'gif':  return 'a GIF image'
    case 'bmp':  return 'a BMP image'
    case 'tiff': return 'a TIFF image'
    case 'png':  return 'a PNG image'
    case 'jpeg': return 'a JPEG image'
    case 'webp': return 'a WebP image'
    default:     return 'an unrecognised image'
  }
}
