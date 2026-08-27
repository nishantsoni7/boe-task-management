// The studio image, built locally from the cut-out. No model, no provider, no
// randomness — the same cut-out composes to the same bytes every time.
//
// SERVER ONLY (sharp is a native module).
//
// WHAT THIS IS ALLOWED TO DO
// --------------------------
// Place, scale and light. That is the whole list:
//
//   * find the product inside the transparent cut-out and crop to it;
//   * scale it — aspect ratio locked — to sit inside a 2048x2048 frame with an
//     even margin on all four sides;
//   * draw a soft contact shadow whose SHAPE IS THE PRODUCT'S OWN ALPHA MASK, so
//     it falls under the feet the product actually stands on, and the gaps
//     between legs and spindles stay gaps;
//   * flatten the result onto a soft warm-white background.
//
// WHAT IT IS NOT ALLOWED TO DO
// ----------------------------
// Nothing is redrawn, regenerated, reshaped, rotated or invented. There is no
// colour correction of any kind: not brightness, not white balance, not
// saturation, not a curve. Every product pixel in the output is the
// corresponding pixel of the photograph, resampled once by the resize and
// composited unmodified. A finish that looks slightly dark in the photograph
// looks slightly dark in the result, and that is the correct behaviour for a
// catalogue image of a real object BOE will ship.

import sharp from 'sharp'
import type { OverlayOptions, Sharp } from 'sharp'

/** One size, per the brief. Square. */
export const CANVAS_PX = 2048

/** Margin on every side, as a fraction of the canvas. 8% leaves the product
 *  filling the frame without crowding it, and leaves room beneath it for the
 *  shadow to fall inside the canvas. */
export const MARGIN_RATIO = 0.08

/** Soft warm white — off-white with a little warmth in it, not paper white and
 *  not cream. */
export const BACKGROUND = { r: 250, g: 247, b: 242 } as const

/** The shadow's colour: a warm near-black, so it reads as a shadow on a warm
 *  surface rather than a grey smudge. Its opacity comes from the alpha mask. */
const SHADOW_COLOR = { r: 60, g: 50, b: 42 } as const

/** How much of the product's own height, measured from its lowest pixels, forms
 *  the shadow's shape. A tenth is enough to catch feet, castors and the bottom
 *  of a plinth without dragging the whole silhouette onto the floor. */
const CONTACT_BAND_RATIO = 0.10

/** How tall the squashed shadow is, as a fraction of the product's height. */
const SHADOW_HEIGHT_RATIO = 0.055

/** Peak shadow opacity. Subtle on purpose: this is contact, not a spotlight. */
const SHADOW_OPACITY = 0.32

/** A pixel is "product" at or above this alpha. Low, so a soft segmented edge
 *  is treated as product rather than trimmed off it. */
const ALPHA_THRESHOLD = 8

export type ComposeResult =
  | {
      ok: true
      png: Buffer
      /** Where the product ended up, for tests and for the log. */
      placement: { left: number; top: number; width: number; height: number }
    }
  | { ok: false; error: string }

/** The tight bounding box of everything at or above the alpha threshold. */
export function alphaBounds(
  alpha: Buffer | Uint8Array,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } | null {
  let minX = width, minY = height, maxX = -1, maxY = -1

  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      if (alpha[row + x] < ALPHA_THRESHOLD) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (maxX < 0) return null
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/**
 * The contact shadow, as an RGBA PNG, plus the padding that was added around it
 * so the blur has room to fall off instead of being clipped square.
 *
 * The shape is the bottom band of the product's own alpha, squashed flat and
 * blurred — which is why a chair with four legs casts four soft pools with the
 * floor showing between them, and a plinth casts one continuous one.
 */
async function buildShadow(productPng: Buffer, width: number, height: number) {
  // Clamped to the product itself. A wide, shallow cut-out — a table edge, or a
  // mask that caught only a sliver — has fewer rows than the band's floor of 4,
  // and `extract` at a negative offset throws rather than degrading.
  const bandHeight = Math.min(height, Math.max(4, Math.round(height * CONTACT_BAND_RATIO)))
  const shadowHeight = Math.max(6, Math.round(height * SHADOW_HEIGHT_RATIO))
  const sigma = Math.max(2, Math.round(width * 0.012))
  const pad = Math.ceil(sigma * 3)

  const alpha = await sharp(productPng)
    .ensureAlpha()
    .extractChannel(3)
    .extract({ left: 0, top: height - bandHeight, width, height: bandHeight })
    // Squashed to a flat band: the product's footprint seen from a low angle.
    .resize(width, shadowHeight, { fit: 'fill' })
    .raw()
    .toBuffer()

  // Opacity applied here rather than through sharp's `linear`, which sits at a
  // fixed point in sharp's pipeline and does not reliably follow an extract and
  // a resize in the same chain. One pass over a band of a few hundred thousand
  // bytes, and what it does is obvious. Scaling before the blur is equivalent to
  // scaling after it, blur being linear.
  for (let i = 0; i < alpha.length; i++) alpha[i] = Math.round(alpha[i] * SHADOW_OPACITY)

  const png = await sharp({
    create: {
      width, height: shadowHeight, channels: 3,
      background: SHADOW_COLOR,
    },
  })
    .joinChannel(alpha, { raw: { width, height: shadowHeight, channels: 1 } })
    // The extension keeps the SHADOW's own colour with zero alpha, so the blur
    // has nothing but transparency to bleed into — no dark fringe.
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { ...SHADOW_COLOR, alpha: 0 } })
    .blur(sigma)
    .png()
    .toBuffer()

  return { png, pad, shadowHeight }
}

/**
 * Compose one transparent cut-out into the finished studio image.
 *
 * Deterministic: same input bytes, same output bytes.
 */
export async function composeStudioImage(cutoutPng: Buffer): Promise<ComposeResult> {
  let source: Sharp
  let width: number
  let height: number

  try {
    source = sharp(cutoutPng, { failOn: 'error' }).ensureAlpha()
    const meta = await source.metadata()
    width = meta.width ?? 0
    height = meta.height ?? 0
  } catch {
    return { ok: false, error: 'The cut-out could not be read. Please try again.' }
  }

  if (!width || !height) return { ok: false, error: 'The cut-out could not be read. Please try again.' }

  // The alpha channel decides everything below: where the product is, how big it
  // is, and where it touches the floor.
  const alpha = await sharp(cutoutPng).ensureAlpha().extractChannel(3).raw().toBuffer()
  const bounds = alphaBounds(alpha, width, height)
  if (!bounds) {
    return {
      ok: false,
      error: 'No product could be separated from that photograph. Try a photograph with the product clearly visible.',
    }
  }

  const margin = Math.round(CANVAS_PX * MARGIN_RATIO)
  const box = CANVAS_PX - margin * 2

  try {
    // Cropped to the product, then scaled to fit the box. `fit: 'inside'` is what
    // locks the aspect ratio: the product is never stretched, only made smaller or
    // larger as a whole.
    const product = await sharp(cutoutPng)
      .ensureAlpha()
      .extract(bounds)
      .resize(box, box, { fit: 'inside', withoutEnlargement: false })
      .png()
      .toBuffer()

    const productMeta = await sharp(product).metadata()
    const pw = productMeta.width ?? 0
    const ph = productMeta.height ?? 0

    // Centred, so the margins are balanced left/right and top/bottom.
    const left = Math.round((CANVAS_PX - pw) / 2)
    const top  = Math.round((CANVAS_PX - ph) / 2)

    const shadow = await buildShadow(product, pw, ph)

    // The shadow sits at the product's feet: mostly below the bottom edge, biting
    // slightly into it so the product does not appear to float.
    const shadowTop = top + ph - Math.round(shadow.shadowHeight * 0.55) - shadow.pad
    const shadowLeft = left - shadow.pad

    const composites: OverlayOptions[] = []
    // Clamped rather than assumed: an extreme aspect ratio must not push the
    // shadow off the canvas and turn a finished image into an exception.
    if (
      shadowTop >= 0 && shadowLeft >= 0 &&
      shadowTop + shadow.shadowHeight + shadow.pad * 2 <= CANVAS_PX &&
      shadowLeft + pw + shadow.pad * 2 <= CANVAS_PX
    ) {
      composites.push({ input: shadow.png, top: shadowTop, left: shadowLeft })
    }
    composites.push({ input: product, top, left })

    // Composited to raw pixels rather than straight to PNG: the flatten below has
    // to happen in its own pipeline. sharp orders its operations internally, not
    // by call order, and a `flatten` chained onto a `composite` is applied before
    // the compositing it is meant to follow — leaving an alpha channel on a
    // catalogue image, which prints as a black square. Raw in, raw out, one PNG
    // encode at the end.
    const composited = await sharp({
      create: { width: CANVAS_PX, height: CANVAS_PX, channels: 3, background: BACKGROUND },
    })
      .composite(composites)
      .raw()
      .toBuffer()

    const png = await sharp(composited, {
      raw: { width: CANVAS_PX, height: CANVAS_PX, channels: 4 },
    })
      .flatten({ background: BACKGROUND })
      .png({ compressionLevel: 9 })
      .toBuffer()

    return { ok: true, png, placement: { left, top, width: pw, height: ph } }
  } catch (e) {
    // A cut-out with a shape no fixture anticipated must produce a message, not
    // a 500. The dimensions go to the log so the shape can be reproduced.
    console.error('[composeStudioImage] failed on', `${width}x${height}`, e)
    return { ok: false, error: 'That photograph could not be composed into a studio image. Please try again.' }
  }
}
