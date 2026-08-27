// Getting the uploaded photograph to the provider with as many of its original
// pixels intact as possible.
//
// SERVER ONLY (sharp is a native module).
//
// WHAT CHANGED, AND WHY IT MATTERED
// ---------------------------------
// This used to downscale every photograph to a 4096px longest edge and
// re-encode anything over 4 MB. Measured on a 48 MP phone photograph, that
// handed PhotoRoom 12.6 MP instead of 48.8 MP — and since the product is only a
// part of the frame, those are exactly the pixels the composition later needed
// and had to invent by enlargement. Both rules are gone. The photograph now
// reaches the provider untouched unless something forces a change:
//
//   1. EXIF orientation. A phone stores "rotate me 90°" as metadata; a provider
//      reading raw pixels does not honour it, and BOE's rule is that the
//      uploaded viewing direction is kept. This one is worth a re-encode.
//   2. A photograph beyond MAX_SOURCE_EDGE_PX, which exists as a memory and
//      request-size guard, not as a quality decision.
//
// When neither applies — the common case — the original bytes are forwarded
// byte for byte, with no recompression at all.

import sharp from 'sharp'
import type { Metadata, Sharp } from 'sharp'

/**
 * The largest photograph forwarded as-is.
 *
 * A safety ceiling on memory and request size, NOT a claim about PhotoRoom's
 * documented limits — those could not be read from this environment. 8192px
 * comfortably exceeds any current phone or DSLR frame, so in practice nothing
 * is resized; lower it if the provider starts refusing large uploads.
 */
export const MAX_SOURCE_EDGE_PX = 8192

/** Quality used when a re-encode is unavoidable. High enough, with no chroma
 *  subsampling, that the loss is invisible against the detail at stake. */
const JPEG_QUALITY = 97

export type PreparedSource =
  | {
      ok: true
      bytes: Buffer
      mimeType: string
      width: number
      height: number
      /** False when the original bytes are being forwarded untouched. */
      reencoded: boolean
    }
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

  const width = meta.width ?? 0
  const height = meta.height ?? 0
  if (!width || !height) {
    return { ok: false, error: 'That image could not be read. Upload a different photograph.' }
  }

  const needsRotate = (meta.orientation ?? 1) > 1
  const needsResize = Math.max(width, height) > MAX_SOURCE_EDGE_PX

  if (!needsRotate && !needsResize) {
    return { ok: true, bytes, mimeType, width, height, reencoded: false }
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
        kernel: 'lanczos3',
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
      reencoded: true,
    }
  } catch {
    return { ok: false, error: 'That image could not be read. Upload a different photograph.' }
  }
}
