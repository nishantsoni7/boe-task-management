// Downloading the same studio image as PNG, JPG or WebP.
//
// SERVER ONLY (sharp is a native module).
//
// This is a FORMAT change and nothing else. The provider's image is the master:
// no resize, no crop, no sharpening, no colour work. What comes out has the same
// pixels and the same dimensions as what went in, encoded differently — which is
// why a conversion can never quietly become a second edit of the product.
//
// It also never calls fal. Converting a result BOE has already paid for must
// not cost a second generation, so this reads bytes the browser already holds
// and hands them back in another wrapper.

import sharp from 'sharp'
import type { Sharp } from 'sharp'
import { DOWNLOAD_FORMATS, isDownloadFormat, type DownloadFormat } from './downloadFormats'

export { DOWNLOAD_FORMATS, isDownloadFormat }
export type { DownloadFormat }

export type ConvertedImage = {
  bytes: Buffer
  contentType: string
  extension: DownloadFormat
  width: number
  height: number
}

const CONTENT_TYPES: Record<DownloadFormat, string> = {
  png:  'image/png',
  jpg:  'image/jpeg',
  webp: 'image/webp',
}

/**
 * Quality settings.
 *
 * PNG is lossless, so it is the honest choice for a master copy and the one
 * BOE's provider already returns. JPG and WebP are asked for at 95 with no
 * chroma subsampling — high enough that cane weave and stitching survive a
 * conversion that exists to make a file smaller or more portable, not to
 * degrade it.
 */
const JPEG_QUALITY = 95
const WEBP_QUALITY = 95

export type ConvertResult =
  | { ok: true; image: ConvertedImage }
  | { ok: false; error: string }

/**
 * Re-encode one image. Never throws.
 *
 * A file that cannot be decoded comes back as a refusal rather than an
 * exception, because the only caller is a route serving a download and a 500
 * there tells an employee nothing.
 */
export async function convertImage(bytes: Buffer, format: DownloadFormat): Promise<ConvertResult> {
  try {
    const pipeline = sharp(bytes, { failOn: 'error' })
    const meta = await pipeline.metadata()
    if (!meta.width || !meta.height) {
      return { ok: false, error: 'That image could not be read.' }
    }

    let encoded: Sharp
    if (format === 'png') {
      encoded = pipeline.png({ compressionLevel: 9 })
    } else if (format === 'jpg') {
      // Flattened onto white: a JPEG has no alpha, and without this a
      // transparent area would come out black rather than as background.
      encoded = pipeline
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: '4:4:4' })
    } else {
      encoded = pipeline.webp({ quality: WEBP_QUALITY })
    }

    const { data, info } = await encoded.toBuffer({ resolveWithObject: true })
    return {
      ok: true,
      image: {
        bytes: data,
        contentType: CONTENT_TYPES[format],
        extension: format,
        width: info.width,
        height: info.height,
      },
    }
  } catch {
    return { ok: false, error: 'That image could not be converted.' }
  }
}
