// Getting the uploaded photograph into the shape the provider is happy with.
//
// SERVER ONLY (sharp is a native module). Three things happen here, and nothing
// else — in particular nothing that changes what the product looks like:
//
//   1. EXIF orientation is baked in. A phone photograph carries "rotate me 90°"
//      as metadata; a provider reading raw pixels does not honour it, and BOE's
//      rule is that the uploaded viewing direction is kept. Without this step a
//      portrait photograph is edited sideways.
//   2. Very large photographs are scaled down to a 4096px longest edge. The
//      finished image is 2048x2048 with the product filling most of it, so
//      detail beyond this buys nothing and costs upload time.
//   3. Anything re-encoded comes back as high-quality JPEG, so the request body
//      stays small.
//
// A photograph that needs none of the three is passed through byte-for-byte.

import sharp from 'sharp'
import type { Metadata, Sharp } from 'sharp'

/** Longest edge sent to the provider. Twice the finished canvas, so the product
 *  still has pixels to spare after it is cropped to its bounding box and scaled
 *  back up to fill the 2048px frame. */
export const MAX_SOURCE_EDGE_PX = 4096

/** Above this, re-encode even if the dimensions are fine — a 9 MB JPEG is
 *  usually a low-compression export, not extra detail. */
export const REENCODE_ABOVE_BYTES = 4 * 1024 * 1024

/** High enough that re-encoding does not visibly touch upholstery texture or
 *  wood grain, which is exactly what must survive this step. */
const JPEG_QUALITY = 92

export type PreparedSource =
  | { ok: true; bytes: Buffer; mimeType: string; width: number; height: number }
  | { ok: false; error: string }

export async function prepareSourceImage(bytes: Buffer, mimeType: string): Promise<PreparedSource> {
  let image: Sharp
  let meta: Metadata
  try {
    image = sharp(bytes, { failOn: 'error' })
    meta = await image.metadata()
  } catch {
    return { ok: false, error: 'That image could not be read. Upload a different photograph.' }
  }

  const width  = meta.width  ?? 0
  const height = meta.height ?? 0
  if (!width || !height) {
    return { ok: false, error: 'That image could not be read. Upload a different photograph.' }
  }

  const needsRotate = (meta.orientation ?? 1) > 1
  const needsResize = Math.max(width, height) > MAX_SOURCE_EDGE_PX
  const needsShrink = bytes.byteLength > REENCODE_ABOVE_BYTES

  if (!needsRotate && !needsResize && !needsShrink) {
    return { ok: true, bytes, mimeType, width, height }
  }

  try {
    // .rotate() with no argument means "apply the EXIF orientation", not "turn
    // the picture" — the pixels end up the way the photographer saw them.
    let pipeline = image.rotate()
    if (needsResize) {
      pipeline = pipeline.resize({
        width:  MAX_SOURCE_EDGE_PX,
        height: MAX_SOURCE_EDGE_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
    }
    const { data, info } = await pipeline
      .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: '4:4:4' })
      .toBuffer({ resolveWithObject: true })

    return {
      ok: true,
      bytes: data,
      mimeType: 'image/jpeg',
      width:  info.width,
      height: info.height,
    }
  } catch {
    return { ok: false, error: 'That image could not be read. Upload a different photograph.' }
  }
}
