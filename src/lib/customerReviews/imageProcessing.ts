import sharp from 'sharp'

import {
  inspectImageBytes,
  type ImageRejection,
  type SupportedImageMime,
} from './imageBytes'

// DECODE, RE-ENCODE, AND STORE THE RESULT — never the bytes that arrived.
//
// SERVER ONLY. This module imports sharp (a native addon) and must never be
// reached from a client component.
//
// WHY A RE-ENCODE RATHER THAN A CHECK
// -----------------------------------
// inspectImageBytes() parses a container. That is a real gate — it decides the
// format from a signature and refuses anything outside a closed allow-list —
// but it is NOT a decoder, and a structural parser cannot honestly claim to
// reject every malformed or embedded-payload file. Bytes that parse as a
// container can still be a corrupt image, and a container can carry a payload
// in a place a parser does not look.
//
// So the accepted file is decoded by a real decoder and written out again, and
// the OUTPUT is what reaches storage. What that buys, concretely:
//
//   * the stored object is bytes libvips produced, not bytes a caller supplied;
//   * anything appended to the original is gone, because it was never part of
//     the decoded image;
//   * EXIF is gone. That is a PRIVACY fix, not only a safety one: a phone
//     photograph of a customer's restaurant carries GPS coordinates, a device
//     serial and a timestamp, and BOE has no business storing any of it;
//   * a file that decodes to nothing usable fails here rather than becoming a
//     broken thumbnail later.
//
// WHY THE STRUCTURAL GATE STILL RUNS FIRST, and this is the part that matters:
// sharp ACCEPTS SVG and rasterises it. An SVG is a document — it can carry
// script and external references — and it is not one of the three formats this
// module allows. inspectImageBytes() refuses it before sharp is ever handed the
// bytes. Removing that first pass would quietly widen the accepted set.
//
// WHY sharp AND NOT A NEW DEPENDENCY
// ----------------------------------
// sharp is already in package.json and already runs server-side in production
// (src/app/api/showroom/quotation/[id]/route.ts, src/lib/orders/
// confirmedPdfRender.ts). Nothing was added and package-lock.json is untouched.

/** Must equal the bucket's file_size_limit. Applied to the OUTPUT as well. */
export const PROCESSED_MAX_BYTES = 5 * 1024 * 1024

/**
 * A ceiling on decoded pixels, against a decompression bomb.
 *
 * A few kilobytes of PNG can declare 30000×30000 and cost gigabytes to decode.
 * 50 megapixels is far above any phone photograph and far below trouble.
 */
export const MAX_DECODED_PIXELS = 50_000_000

export type ProcessedImage = {
  ok: true
  /** The bytes to store — libvips output, not the upload. */
  bytes: Uint8Array
  mime: SupportedImageMime
  width: number
  height: number
  /** True when the re-encode changed the byte length, which it usually does. */
  reencoded: boolean
}

export type ImageProcessingFailure = {
  ok: false
  /** Reuses the inspector's closed set, plus the two only a decoder can find. */
  reason: ImageRejection | 'undecodable' | 'too_many_pixels'
}

const FORMAT: Record<SupportedImageMime, 'jpeg' | 'png' | 'webp'> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/**
 * Validate, decode and re-encode. The returned bytes are what to store.
 *
 * THE ORDER IS THE GUARANTEE:
 *   1. the structural gate decides the format from a closed allow-list, so SVG,
 *      HTML, PDF, archives and everything else never reach a decoder;
 *   2. libvips decodes it, which is what catches damage a parser cannot see;
 *   3. it is written out in the SAME format, with no metadata carried over;
 *   4. the output is size-checked again, because a re-encode can grow.
 */
export async function processReviewImage(
  bytes: Uint8Array,
  maxBytes: number = PROCESSED_MAX_BYTES,
): Promise<ProcessedImage | ImageProcessingFailure> {
  const inspection = inspectImageBytes(bytes, maxBytes)
  if (!inspection.ok) return { ok: false, reason: inspection.reason }

  const format = FORMAT[inspection.mime]

  try {
    // failOn 'warning' is deliberately strict: libvips will otherwise decode a
    // subtly damaged image and produce something plausible.
    const pipeline = sharp(Buffer.from(bytes), {
      failOn: 'warning',
      limitInputPixels: MAX_DECODED_PIXELS,
      // The container has already been identified; naming it stops libvips
      // choosing a different loader for the same bytes.
      animated: false,
    })

    const metadata = await pipeline.metadata()

    // The decoder and the parser must agree about what this is. A disagreement
    // is not something to reconcile — it is a file pretending to be two things.
    if (metadata.format !== format) return { ok: false, reason: 'unknown_format' }
    if (!metadata.width || !metadata.height) return { ok: false, reason: 'bad_dimensions' }
    if (metadata.width * metadata.height > MAX_DECODED_PIXELS) {
      return { ok: false, reason: 'too_many_pixels' }
    }

    // .rotate() with no argument applies the EXIF orientation before the
    // orientation tag is dropped, so an upright photograph stays upright.
    // No .withMetadata(): sharp strips EXIF, ICC, XMP and IPTC by default, and
    // that default is exactly what is wanted here.
    const output = await pipeline
      .rotate()
      .toFormat(format, format === 'jpeg' ? { quality: 88 } : {})
      .toBuffer()

    if (output.length === 0) return { ok: false, reason: 'undecodable' }
    if (output.length > maxBytes) return { ok: false, reason: 'too_large' }

    return {
      ok: true,
      bytes: new Uint8Array(output),
      mime: inspection.mime,
      width: metadata.width,
      height: metadata.height,
      reencoded: output.length !== bytes.length,
    }
  } catch {
    // Every decoder failure is one answer. Which one it was is libvips's
    // business, and its message can quote the input.
    return { ok: false, reason: 'undecodable' }
  }
}

/** The sentence for the two failures only a decoder can report. */
export const PROCESSING_REJECTION_MESSAGES: Record<'undecodable' | 'too_many_pixels', string> = {
  undecodable:     'That image could not be read. It may be damaged.',
  too_many_pixels: 'That image is too large to process. Try a smaller photograph.',
}
