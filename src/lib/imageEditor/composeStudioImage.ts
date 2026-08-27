// The studio image, built locally from the cut-out. No model, no provider, no
// randomness — the same cut-out composes to the same bytes every time.
//
// SERVER ONLY (sharp is a native module).
//
// WHY THIS FILE LOOKS THE WAY IT DOES
// -----------------------------------
// The first version enlarged whatever the provider returned until it filled the
// frame. Measured on a 4032x3024 photograph: a product occupying 30% of the
// frame was enlarged 2.11x and lost 71% of its fine-detail energy; at 45% the
// enlargement was 1.40x and the loss 45%. That is the blur, and no amount of
// sharpening afterwards puts back detail the sensor never recorded.
//
// So enlargement is now capped, and a product too small to reach the frame
// within that cap is REFUSED with a message asking for a closer photograph,
// rather than delivered soft and called catalogue-ready.
//
// WHAT THIS IS ALLOWED TO DO
// --------------------------
// Place, scale, light and ground. Nothing is redrawn, regenerated, reshaped,
// rotated or invented; no angle is corrected, because any automatic estimate
// would resample the product and risk its geometry for a benefit nothing here
// can measure. Colour and exposure are corrected per photograph from its own
// statistics (enhanceProduct.ts), bounded so a well-exposed photograph receives
// almost nothing.

import sharp from 'sharp'
import type { OverlayOptions, Sharp } from 'sharp'
import {
  alphaBounds, alphaCentroidX, lowestOpaqueRows, contactColumns,
  toneStats, neutralStats, detailScore, ALPHA_OPAQUE, type Bounds,
} from './productMetrics'
import { decideTone, applyTone, type ToneDecision } from './enhanceProduct'

/** One size, per the brief. Square. */
export const CANVAS_PX = 2048

/** Margin on every side, as a fraction of the canvas. */
export const MARGIN_RATIO = 0.08

/**
 * The most the product may be enlarged.
 *
 * Chosen from measurement, not taste. Cane-weave detail energy retained through
 * the whole pipeline below, sharpening included, against the same product
 * composed at 1.00x:
 *
 *     0.80x  102%      1.24x   67%      2.00x   28%
 *     1.00x  100%      1.40x   61%      2.61x   21%
 *     1.16x   75%      1.60x   50%
 *
 * There is no knee to hide behind — it falls steadily — so this is a judgement
 * with numbers attached rather than a threshold the data picked. 1.25x keeps
 * two thirds of the finest texture and asks for a product about 45% of the
 * frame; the alternative worth knowing about is 1.15x, which keeps three
 * quarters and asks for about half the frame. What is NOT defensible is where
 * this started: 2.11x on a product filling 30% of the frame, which kept under
 * a third of the weave and is what "blurry" meant.
 *
 * The pattern measured is near-Nyquist and therefore a worst case; real cane at
 * this size loses less.
 */
export const MAX_ENLARGEMENT = 1.25

/**
 * Below this Laplacian standard deviation the product is soft in the SOURCE —
 * camera shake, a missed focus, a heavy phone denoiser. Deliberately low: it is
 * meant to catch photographs nothing could rescue, not to arbitrate sharpness.
 * It has not been calibrated against a large set of real factory photographs, so
 * it errs heavily toward accepting.
 */
export const MIN_DETAIL_SCORE = 3.5

/** Soft warm white. The gradient runs from this at the top to BACKGROUND_FOOT
 *  at the bottom — a suggestion of a lit sweep, not a visible ramp. */
export const BACKGROUND = { r: 251, g: 248, b: 243 } as const
export const BACKGROUND_FOOT = { r: 241, g: 236, b: 228 } as const

/** Shadow colour: near-neutral, a touch warm so it sits on this background
 *  rather than on top of it. */
const SHADOW_COLOR = { r: 74, g: 70, b: 66 } as const

/**
 * How far above the product's lowest point a column may end and still be
 * treated as standing on the floor.
 *
 * Generous — a good deal more than a level floor would need — because in a
 * three-quarter view the BACK feet sit visibly higher in the frame than the
 * front ones while resting on the same floor. A tight tolerance drops them, and
 * a chair with shadows under only its front feet looks like it is tipping.
 * Geometry well above this (a seat rail, an apron, a stretcher) is still
 * excluded, which is what keeps this a contact shadow rather than a silhouette.
 */
const CONTACT_RISE_RATIO = 0.12

/** The tight shadow at each foot. */
const CONTACT_THICKNESS_RATIO = 0.014
const CONTACT_OPACITY = 0.42

/** The wide, very soft pool that stops the product floating. */
const GROUND_THICKNESS_RATIO = 0.055
const GROUND_OPACITY = 0.12

/** Post-resize sharpening. Restrained: enough to recover what a resample costs,
 *  short of the crunch that makes an edited photograph look edited. */
const SHARPEN = { sigma: 0.9, m1: 0.4, m2: 1.6 } as const

/** How far in from the cut-out edge sharpening is allowed to reach. Keeps the
 *  alpha edge free of the pale outline that sharpening a cut-out produces. */
const EDGE_GUARD_SIGMA = 2

/** Below this alpha a pixel is part of the soft edge, and its colour is partly
 *  the old background's. Above it, the pixel is product and is left alone. */
const FRINGE_ALPHA = 250

/** How far the defringe reaches for replacement colour. Small: the colour comes
 *  from the product just inside the edge, not from across the leg. */
const FRINGE_SIGMA = 3

export type QualityRejection = {
  /** What the page shows. */
  message: string
  /** Why, for the server log — no image data, only measurements. */
  detail: string
}

export type ComposeMetrics = {
  cutout: { width: number; height: number }
  bounds: Bounds
  /** The product's longest edge in the cut-out, before any scaling. */
  effectivePx: number
  enlargement: number
  placement: { left: number; top: number; width: number; height: number }
  tone: ToneDecision
  detail: number
  contactColumns: number
}

export type ComposeResult =
  | { ok: true; png: Buffer; metrics: ComposeMetrics }
  | { ok: false; error: string; quality?: QualityRejection; metrics?: Partial<ComposeMetrics> }

// ─── Background ───────────────────────────────────────────────────────────────

/** The studio sweep: one vertical gradient, built by hand so it is exactly as
 *  subtle as intended and identical on every run. */
async function background(): Promise<Buffer> {
  const raw = Buffer.allocUnsafe(CANVAS_PX * CANVAS_PX * 3)

  for (let y = 0; y < CANVAS_PX; y++) {
    // Eased rather than linear: the fall-off belongs in the lower half, where a
    // floor would be, not spread evenly up the frame.
    const t = Math.pow(y / (CANVAS_PX - 1), 1.6)
    const r = Math.round(BACKGROUND.r + (BACKGROUND_FOOT.r - BACKGROUND.r) * t)
    const g = Math.round(BACKGROUND.g + (BACKGROUND_FOOT.g - BACKGROUND.g) * t)
    const b = Math.round(BACKGROUND.b + (BACKGROUND_FOOT.b - BACKGROUND.b) * t)

    for (let x = 0; x < CANVAS_PX; x++) {
      const o = (y * CANVAS_PX + x) * 3
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b
    }
  }

  return sharp(raw, { raw: { width: CANVAS_PX, height: CANVAS_PX, channels: 3 } }).png().toBuffer()
}

// ─── Edge colour ──────────────────────────────────────────────────────────────

/**
 * Take the old background's colour out of the cut-out's soft edge, without
 * touching the cut-out's shape.
 *
 * A segmented edge is a row of part-transparent pixels whose colour is a mix of
 * product and whatever was behind it. Composited onto warm white, that mix is
 * the pale-or-green rim that reads instantly as "cut out". The usual fix is to
 * eat into the alpha, which on furniture means thinning the cane, the spindles
 * and the metal tips — the one thing that must not happen here.
 *
 * So ALPHA IS NEVER MODIFIED. Only the RGB of edge pixels changes, and it
 * changes to the alpha-weighted average of the product colour just inside the
 * edge: the interior colour smeared outward. A leg keeps its exact width and
 * loses its green rim.
 *
 * Sized for what a segmenter actually leaves: a rim one to three pixels deep.
 * FRINGE_SIGMA has to reach past that rim to find product colour to borrow, so
 * a much deeper band of contamination — which no cut-out produces — would only
 * be partly corrected.
 */
export async function defringe(rgba: Buffer, width: number, height: number): Promise<void> {
  const pixels = width * height

  // ONLY SOLID PIXELS contribute. This is the difference between working and
  // half-working: include the rim in its own replacement estimate and the
  // estimate is itself half old background, so the correction lands halfway and
  // the rim stays visibly green.
  const premultiplied = Buffer.alloc(pixels * 3)
  const solid = Buffer.alloc(pixels)
  for (let i = 0; i < pixels; i++) {
    const o = i * 4
    if (rgba[o + 3] < FRINGE_ALPHA) continue
    solid[i] = 255
    premultiplied[i * 3]     = rgba[o]
    premultiplied[i * 3 + 1] = rgba[o + 1]
    premultiplied[i * 3 + 2] = rgba[o + 2]
  }

  // Blurring the masked colour and the mask together, then dividing, is a
  // weighted local average of solid product only: nothing outside the product,
  // and nothing from the contaminated rim, can leak into the answer.
  const blurredColour = await sharp(premultiplied, { raw: { width, height, channels: 3 } })
    .blur(FRINGE_SIGMA).raw().toBuffer()
  const blurredAlpha = await sharp(solid, { raw: { width, height, channels: 1 } })
    .blur(FRINGE_SIGMA).raw().toBuffer()

  for (let i = 0; i < pixels; i++) {
    const a = rgba[i * 4 + 3]
    if (a === 0 || a >= FRINGE_ALPHA) continue

    // Too little solid product within reach to say what colour the edge should
    // be — a thin wisp of alpha with nothing behind it. Left as it is.
    const weight = blurredAlpha[i]
    if (weight < 4) continue

    // Full replacement for anything meaningfully transparent, ramping only over
    // the last stretch up to FRINGE_ALPHA so there is no seam where the
    // treatment stops. A half-covered edge pixel IS the product seen through
    // half a pixel: its colour should be the product's, and its alpha is what
    // does the mixing with the background. Blending only halfway — which is
    // what a strictly proportional ramp does — leaves half the old background's
    // colour in the rim, which is exactly the fringe being removed.
    const t = Math.min(1, (FRINGE_ALPHA - a) / (FRINGE_ALPHA * 0.35))
    const o = i * 4
    for (let c = 0; c < 3; c++) {
        const interior = Math.min(255, Math.round(blurredColour[i * 3 + c] * 255 / weight))
      rgba[o + c] = Math.round(rgba[o + c] * (1 - t) + interior * t)
    }
  }
}

// ─── Sharpening, kept off the edge ────────────────────────────────────────────

/**
 * Sharpen the product's RGB and leave its alpha edge alone.
 *
 * Sharpening a cut-out naively does two visible things: it outlines the alpha,
 * and it drags whatever RGB the provider left in the transparent region into
 * the product's rim — the pale halo that reads instantly as "cut out". Both are
 * avoided by confining the sharpened result to an INTERIOR mask: the alpha,
 * blurred and thresholded hard, which excludes a few pixels all the way round.
 *
 * Each sharp call stands alone. sharp orders operations internally rather than
 * by call order, so `removeAlpha` chained onto `sharpen` would run after it and
 * the alpha would be sharpened anyway.
 */
async function sharpenInterior(productPng: Buffer, width: number, height: number): Promise<Buffer> {
  const pixels = width * height

  const rgbPng = await sharp(productPng).removeAlpha().png().toBuffer()
  const plain = await sharp(rgbPng).raw().toBuffer()
  const sharpened = await sharp(rgbPng).sharpen(SHARPEN).raw().toBuffer()

  const alpha = await sharp(productPng).ensureAlpha().extractChannel(3).raw().toBuffer()
  // Blur-then-threshold is an erosion: a pixel survives only if everything
  // within a few pixels of it is solid product.
  const interior = await sharp(alpha, { raw: { width, height, channels: 1 } })
    .blur(EDGE_GUARD_SIGMA)
    .raw()
    .toBuffer()

  const out = Buffer.allocUnsafe(pixels * 4)
  for (let i = 0; i < pixels; i++) {
    const inside = interior[i] >= 252
    const s = i * 3
    const o = i * 4
    out[o]     = inside ? sharpened[s]     : plain[s]
    out[o + 1] = inside ? sharpened[s + 1] : plain[s + 1]
    out[o + 2] = inside ? sharpened[s + 2] : plain[s + 2]
    out[o + 3] = alpha[i]
  }

  return sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer()
}

// ─── Shadow ───────────────────────────────────────────────────────────────────

/**
 * One shadow layer, the same size as the product.
 *
 * Each column that reaches the floor stamps a short vertical smear AT ITS OWN
 * lowest pixel — not on a common baseline. That is the whole difference between
 * this and the silhouette-derived smear it replaces: a chair photographed at an
 * angle has its back feet higher up the frame than its front feet, and its
 * shadows belong under each foot where that foot actually is.
 *
 * Padded so the blur falls off instead of being clipped into a rectangle.
 */
async function shadowLayer(
  lowest: Int32Array,
  width: number,
  height: number,
  floor: number,
  rise: number,
  thickness: number,
  sigma: number,
  opacity: number,
): Promise<{ png: Buffer; pad: number }> {
  const pad = Math.ceil(sigma * 3)
  const mask = Buffer.alloc(width * height)
  const half = Math.max(1, Math.round(thickness / 2))
  const peak = Math.round(255 * opacity)

  for (let x = 0; x < width; x++) {
    const y = lowest[x]
    if (y < 0 || floor - y > rise) continue

    for (let dy = -half; dy <= half; dy++) {
      const row = y + dy
      if (row < 0 || row >= height) continue
      // Denser at the point of contact, fading above and below it, so the smear
      // has no edge of its own once blurred.
      const fade = 1 - Math.pow(Math.abs(dy) / (half + 1), 2)
      mask[row * width + x] = Math.round(peak * fade)
    }
  }

  const png = await sharp({ create: { width, height, channels: 3, background: SHADOW_COLOR } })
    .joinChannel(mask, { raw: { width, height, channels: 1 } })
    // Extended in the shadow's OWN colour at zero alpha: the blur then has
    // nothing but transparency to bleed into, and no dark fringe appears.
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { ...SHADOW_COLOR, alpha: 0 } })
    .blur(sigma)
    .png()
    .toBuffer()

  return { png, pad }
}

// ─── Compose ──────────────────────────────────────────────────────────────────

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

  try {
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
    const effectivePx = Math.max(bounds.width, bounds.height)
    const enlargement = Math.min(box / bounds.width, box / bounds.height)

    // ── The quality gate ─────────────────────────────────────────────────────
    //
    // Refusing here is the point of this change. A product that would have to be
    // enlarged past the cap cannot produce a sharp 2048px image, and delivering
    // a soft one labelled catalogue-ready is worse than saying so.
    if (enlargement > MAX_ENLARGEMENT) {
      const needed = Math.ceil(box / MAX_ENLARGEMENT)
      return {
        ok: false,
        error: 'quality',
        quality: {
          message:
            'The product is too small in this photograph to make a sharp catalogue image. ' +
            'Take the photograph closer, or crop it tightly around the product, and try again.',
          detail:
            `product ${bounds.width}x${bounds.height} in a ${width}x${height} cut-out; ` +
            `would need ${enlargement.toFixed(2)}x enlargement (cap ${MAX_ENLARGEMENT}), ` +
            `needs a longest edge of ${needed}px`,
        },
        metrics: { cutout: { width, height }, bounds, effectivePx, enlargement },
      }
    }

    // ── Crop, correct, scale ─────────────────────────────────────────────────
    const cropped = await sharp(cutoutPng).ensureAlpha().extract(bounds).raw()
      .toBuffer({ resolveWithObject: true })

    const croppedPixels = bounds.width * bounds.height

    // Sharpness of the SOURCE product, measured before any scaling flatters it.
    const grey = Buffer.allocUnsafe(croppedPixels)
    const croppedAlpha = Buffer.allocUnsafe(croppedPixels)
    for (let i = 0; i < croppedPixels; i++) {
      const o = i * 4
      grey[i] = Math.round(0.299 * cropped.data[o] + 0.587 * cropped.data[o + 1] + 0.114 * cropped.data[o + 2])
      croppedAlpha[i] = cropped.data[o + 3]
    }
    const detail = detailScore(grey, croppedAlpha, bounds.width, bounds.height)

    if (detail < MIN_DETAIL_SCORE) {
      return {
        ok: false,
        error: 'quality',
        quality: {
          message:
            'The product is too soft in this photograph to make a sharp catalogue image. ' +
            'Take a new photograph with the camera steady and the product in focus, and try again.',
          detail: `detail score ${detail.toFixed(2)} below ${MIN_DETAIL_SCORE}; product ${bounds.width}x${bounds.height}`,
        },
        metrics: { cutout: { width, height }, bounds, effectivePx, enlargement, detail },
      }
    }

    // The old background's colour comes out of the soft edge first, at native
    // resolution, while there is most information to borrow from.
    await defringe(cropped.data, bounds.width, bounds.height)

    // Lighting and colour, decided from this product's own statistics.
    const tone = decideTone(
      toneStats(cropped.data, croppedPixels),
      neutralStats(cropped.data, croppedPixels),
    )
    applyTone(cropped.data, croppedPixels, tone)

    const corrected = await sharp(cropped.data, {
      raw: { width: bounds.width, height: bounds.height, channels: 4 },
    }).png().toBuffer()

    // Lanczos, stated rather than assumed. `fit: 'inside'` locks the aspect
    // ratio: the product is scaled as a whole, never stretched.
    const scaled = await sharp(corrected)
      .resize(box, box, { fit: 'inside', kernel: 'lanczos3', withoutEnlargement: false })
      .png()
      .toBuffer()

    const scaledMeta = await sharp(scaled).metadata()
    const pw = scaledMeta.width ?? 0
    const ph = scaledMeta.height ?? 0

    const product = await sharpenInterior(scaled, pw, ph)

    // ── Placement ────────────────────────────────────────────────────────────
    const placedAlpha = await sharp(product).ensureAlpha().extractChannel(3).raw().toBuffer()
    const placedBounds: Bounds = { left: 0, top: 0, width: pw, height: ph }

    // Horizontally by the product's MASS, so a chair with one arm toward the
    // camera does not sit visibly off-centre; clamped so the margins hold.
    const centroid = alphaCentroidX(placedAlpha, pw, placedBounds)
    const left = Math.max(margin, Math.min(
      CANVAS_PX - margin - pw,
      Math.round(CANVAS_PX / 2 - centroid),
    ))

    // Vertically centred, lifted a little: the shadow adds visual weight below
    // the product, and true centring then reads as low.
    const top = Math.max(
      Math.round(margin * 0.75),
      Math.min(CANVAS_PX - margin - ph, Math.round((CANVAS_PX - ph) / 2 - CANVAS_PX * 0.012)),
    )

    // ── Shadow, from the floor-contact points only ───────────────────────────
    const lowest = lowestOpaqueRows(placedAlpha, pw, placedBounds)
    let floor = -1
    for (const y of lowest) if (y > floor) floor = y

    const rise = Math.max(4, Math.round(ph * CONTACT_RISE_RATIO))
    const columns = contactColumns(lowest, rise)
    let contactCount = 0
    for (const c of columns) if (c) contactCount++

    const composites: OverlayOptions[] = []

    if (contactCount > 0 && floor >= 0) {
      // Wide and very soft first: the grounding pool.
      const ground = await shadowLayer(
        lowest, pw, ph, floor, rise,
        Math.max(10, Math.round(ph * GROUND_THICKNESS_RATIO)),
        Math.max(10, Math.round(pw * 0.026)),
        GROUND_OPACITY,
      )
      if (top - ground.pad >= 0 && left - ground.pad >= 0 &&
          top + ph + ground.pad <= CANVAS_PX && left + pw + ground.pad <= CANVAS_PX) {
        composites.push({ input: ground.png, top: top - ground.pad, left: left - ground.pad })
      }

      // Then the tight contact shadow, right at the feet.
      const contact = await shadowLayer(
        lowest, pw, ph, floor, rise,
        Math.max(3, Math.round(ph * CONTACT_THICKNESS_RATIO)),
        Math.max(2, Math.round(pw * 0.005)),
        CONTACT_OPACITY,
      )
      if (top - contact.pad >= 0 && left - contact.pad >= 0 &&
          top + ph + contact.pad <= CANVAS_PX && left + pw + contact.pad <= CANVAS_PX) {
        composites.push({ input: contact.png, top: top - contact.pad, left: left - contact.pad })
      }
    }

    composites.push({ input: product, top, left })

    // Composited to raw pixels rather than straight to PNG: the flatten below
    // has to happen in its own pipeline. sharp orders its operations
    // internally, not by call order, and a `flatten` chained onto a `composite`
    // is applied before the compositing it is meant to follow — leaving an
    // alpha channel on a catalogue image, which prints as a black square.
    const composited = await sharp(await background()).composite(composites).raw().toBuffer()

    const png = await sharp(composited, {
      raw: { width: CANVAS_PX, height: CANVAS_PX, channels: 4 },
    })
      .flatten({ background: BACKGROUND })
      .png({ compressionLevel: 9 })
      .toBuffer()

    return {
      ok: true,
      png,
      metrics: {
        cutout: { width, height },
        bounds,
        effectivePx,
        enlargement,
        placement: { left, top, width: pw, height: ph },
        tone,
        detail,
        contactColumns: contactCount,
      },
    }
  } catch (e) {
    console.error('[composeStudioImage] failed on', `${width}x${height}`, e)
    return { ok: false, error: 'That photograph could not be composed into a studio image. Please try again.' }
  }
}

export { alphaBounds, ALPHA_OPAQUE }
