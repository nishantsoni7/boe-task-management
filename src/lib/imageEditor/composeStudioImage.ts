// The studio image, built locally from the cut-out.
//
// SERVER ONLY (sharp is a native module). No model, no provider, no randomness:
// the same cut-out composes to the same bytes every time, and the composition is
// arithmetic against the preset's constants rather than a request somebody hopes
// will be honoured.
//
// WHAT THIS IS ALLOWED TO DO
// --------------------------
// Scale, place, light and ground. In order:
//
//   1. find the product by its alpha and crop to it;
//   2. refuse it if filling the frame would mean enlarging past the cap;
//   3. take the old background's colour out of the soft edge, WITHOUT touching
//      alpha — no erosion, no choke, no thinned legs;
//   4. correct exposure and contrast from the product's own statistics;
//   5. scale once, with Lanczos, both axes by one factor;
//   6. sharpen inside the product only, never across its edge;
//   7. draw a contact shadow under each foot and one soft cast shadow;
//   8. composite onto a locally generated warm-neutral sweep at the preset's
//      exact coordinates.
//
// Nothing is rotated, warped, skewed, redrawn or invented. An existing
// watermark in the source is product pixels like any other and passes through
// untouched.
//
// A NOTE ON sharp
// ---------------
// sharp orders its operations internally, not by call order. `removeAlpha`,
// `flatten` and `linear` chained onto other work run at their own point in the
// pipeline, not where they were written — each has caused a real defect here.
// Where order matters below, each step is its own pipeline.

import sharp from 'sharp'
import type { OverlayOptions } from 'sharp'
import {
  alphaBounds, lowestOpaqueRows, contactColumns, planPlacement, checkEnlargement,
  MAX_ENLARGEMENT, type Bounds,
} from './cutoutGeometry'
import { toneStats, decideTone, applyTone, type ToneDecision } from './productTone'
import { resolveOutputPreset, type OutputPresetKey, type OutputPreset } from './outputPresets'

// ─── Background ───────────────────────────────────────────────────────────────

/** Warm-neutral light grey: the tone of the approved reference sweep. */
export const BACKGROUND_BASE = { r: 235, g: 232, b: 227 } as const

/** How much brighter the sweep is behind the product than at the far corners.
 *  Small on purpose — the brief asks for "subtle", and a strong falloff reads
 *  as a vignette, which is exactly what a catalogue background must not do. */
const BACKGROUND_LIFT = 9
const BACKGROUND_FALLOFF = 13

/** The bright centre sits a little above the middle, behind the product rather
 *  than on the floor in front of it. */
const HIGHLIGHT_Y = 0.42

// ─── Shadows ──────────────────────────────────────────────────────────────────

/** Near-neutral, a touch warm so it sits on this background rather than on top
 *  of it. */
const SHADOW_COLOR = { r: 96, g: 92, b: 87 } as const

/** How far above the lowest point a column may end and still be a foot. */
const CONTACT_RISE_RATIO = 0.12

const CONTACT_THICKNESS_RATIO = 0.020
const CONTACT_OPACITY = 0.62

/** How far down its own half-thickness the band is nudged, so that the part
 *  hidden behind the product is not most of it. */
const CONTACT_BIAS = 0.9

/** The cast shadow: a faint pool from the footprint, leaning right and slightly
 *  back. Quiet by design — the brief calls it "secondary to the product". */
const CAST_OPACITY = 0.30
const CAST_DEPTH_RATIO = 0.14
const CAST_LEAN = 0.14
const CAST_BLUR_RATIO = 0.03

// ─── Sharpening ───────────────────────────────────────────────────────────────

const SHARPEN = { sigma: 0.8, m1: 0.4, m2: 1.4 } as const

/** How far in from the cut-out edge sharpening may reach. Keeps the pale
 *  outline that sharpening a cut-out produces off the product's rim. */
const EDGE_GUARD_SIGMA = 2

/** Below this alpha a pixel is part of the soft edge: its colour is partly the
 *  old background's, and it is the defringe's business. */
const FRINGE_ALPHA = 250
const FRINGE_SIGMA = 3

export type QualityRejection = { message: string; detail: string }

export type ComposeMetrics = {
  cutout: { width: number; height: number }
  bounds: Bounds
  scale: number
  placement: { left: number; top: number; width: number; height: number }
  preset: OutputPresetKey
  canvas: { width: number; height: number }
  tone: ToneDecision
  contactColumns: number
}

export type ComposeResult =
  | { ok: true; png: Buffer; metrics: ComposeMetrics }
  | { ok: false; error: string; quality?: QualityRejection }

/**
 * The studio sweep, built by hand.
 *
 * One radial lift behind the product falling to a slightly deeper tone at the
 * far corners. Continuous by construction: there is no horizon and no wall/floor
 * boundary anywhere in this function, because there is nothing in it that could
 * draw one.
 */
async function background(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.allocUnsafe(width * height * 3)
  const cx = width / 2
  const cy = height * HIGHLIGHT_Y
  // Normalised so the far corner is 1.
  const maxDistance = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy))

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = Math.min(1, Math.hypot(x - cx, y - cy) / maxDistance)
      // Eased so most of the canvas sits near the base tone and the change
      // gathers toward the corners.
      const shade = BACKGROUND_LIFT - (BACKGROUND_LIFT + BACKGROUND_FALLOFF) * Math.pow(t, 1.7)
      const o = (y * width + x) * 3
      raw[o]     = Math.max(0, Math.min(255, Math.round(BACKGROUND_BASE.r + shade)))
      raw[o + 1] = Math.max(0, Math.min(255, Math.round(BACKGROUND_BASE.g + shade)))
      raw[o + 2] = Math.max(0, Math.min(255, Math.round(BACKGROUND_BASE.b + shade)))
    }
  }

  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

/**
 * Blur a one-channel mask and get one channel back.
 *
 * sharp reads a raw single-channel buffer as sRGB and returns THREE channels
 * unless it is told otherwise, so `mask[i]` afterwards is the red channel of
 * pixel i/3 — a mask silently sampled from the wrong pixels. Both masks below
 * hit this, and neither failure is visible in the finished image: the defringe
 * quietly stopped defringing and the sharpening guard quietly stopped guarding.
 */
async function blurMask(mask: Buffer, width: number, height: number, sigma: number): Promise<Buffer> {
  return sharp(mask, { raw: { width, height, channels: 1 } })
    .blur(sigma)
    .toColourspace('b-w')
    .raw()
    .toBuffer()
}

/**
 * Take the old background's colour out of the cut-out's soft edge, without
 * touching its shape.
 *
 * A segmented edge is part-transparent pixels whose colour is a mix of product
 * and whatever was behind it. Composited onto a light sweep, that mix is the
 * pale-or-green rim that reads instantly as "cut out". The usual fix is to eat
 * into the alpha, which on furniture means thinning the cane, the spindles and
 * the metal tips — the one thing that must not happen.
 *
 * So ALPHA IS NEVER MODIFIED. Only the RGB of edge pixels changes, and it
 * changes to the colour of the solid product just inside the edge. Only solid
 * pixels contribute to that estimate: include the rim in its own replacement
 * and the answer is half old background, so the rim stays visibly wrong.
 */
export async function defringe(rgba: Buffer, width: number, height: number): Promise<void> {
  const pixels = width * height

  const masked = Buffer.alloc(pixels * 3)
  const solid = Buffer.alloc(pixels)
  for (let i = 0; i < pixels; i++) {
    const o = i * 4
    if (rgba[o + 3] < FRINGE_ALPHA) continue
    solid[i] = 255
    masked[i * 3]     = rgba[o]
    masked[i * 3 + 1] = rgba[o + 1]
    masked[i * 3 + 2] = rgba[o + 2]
  }

  const blurredColour = await sharp(masked, { raw: { width, height, channels: 3 } })
    .blur(FRINGE_SIGMA).raw().toBuffer()
  const blurredSolid = await blurMask(solid, width, height, FRINGE_SIGMA)

  for (let i = 0; i < pixels; i++) {
    const a = rgba[i * 4 + 3]
    if (a === 0 || a >= FRINGE_ALPHA) continue

    const weight = blurredSolid[i]
    // Too little solid product within reach to say what colour the edge should
    // be — a thin wisp with nothing behind it. Left as it is.
    if (weight < 4) continue

    // Full replacement for anything meaningfully transparent, ramping only over
    // the last stretch: a half-covered edge pixel IS the product seen through
    // half a pixel, so its colour should be the product's and its alpha does
    // the mixing with the background.
    const t = Math.min(1, (FRINGE_ALPHA - a) / (FRINGE_ALPHA * 0.35))
    const o = i * 4
    for (let c = 0; c < 3; c++) {
      const interior = Math.min(255, Math.round(blurredColour[i * 3 + c] * 255 / weight))
      rgba[o + c] = Math.round(rgba[o + c] * (1 - t) + interior * t)
    }
  }
}

/**
 * Sharpen the product's RGB and leave its alpha edge alone.
 *
 * Sharpening a cut-out naively does two visible things: it outlines the alpha,
 * and it drags whatever RGB sits in the transparent region into the rim. Both
 * are avoided by confining the sharpened result to an INTERIOR mask — the
 * alpha, blurred and thresholded hard, which excludes a few pixels all the way
 * round.
 */
async function sharpenInterior(productPng: Buffer, width: number, height: number): Promise<Buffer> {
  const pixels = width * height

  const rgbPng = await sharp(productPng).removeAlpha().png().toBuffer()
  const plain = await sharp(rgbPng).raw().toBuffer()
  const sharpened = await sharp(rgbPng).sharpen(SHARPEN).raw().toBuffer()

  const alpha = await sharp(productPng).ensureAlpha().extractChannel(3).raw().toBuffer()
  const interior = await blurMask(alpha, width, height, EDGE_GUARD_SIGMA)

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

/**
 * A layer to be drawn, and where it goes relative to the product's top-left.
 *
 * Shadows are wider and taller than the product they belong to — a blur has to
 * be given room to fall off in, or it ends at a hard line — so their offsets are
 * negative and their edges routinely fall outside the canvas.
 */
type Overlay = { png: Buffer; width: number; height: number; offsetX: number; offsetY: number }

/**
 * Put one layer on the canvas, cropped to what actually lands on it.
 *
 * sharp refuses a negative offset and refuses an overlay larger than the base
 * image, and BOTH happen here in ordinary use: a 1056px-wide sideboard with a
 * 53px blur on its shadow makes a 1374px layer for a 1200px canvas, and every
 * wide product failed to compose at all until this existed. Cropping first is
 * what makes the shadow simply run off the edge, as a shadow should, instead of
 * taking the whole image down with it.
 */
async function place(
  layer: Overlay, left: number, top: number, canvasWidth: number, canvasHeight: number,
): Promise<OverlayOptions | null> {
  const x = left + layer.offsetX
  const y = top + layer.offsetY

  const cropLeft = Math.max(0, -x)
  const cropTop = Math.max(0, -y)
  const cropWidth = Math.min(layer.width - cropLeft, canvasWidth - Math.max(0, x))
  const cropHeight = Math.min(layer.height - cropTop, canvasHeight - Math.max(0, y))
  if (cropWidth <= 0 || cropHeight <= 0) return null

  const whole = cropLeft === 0 && cropTop === 0
    && cropWidth === layer.width && cropHeight === layer.height

  return {
    input: whole ? layer.png : await sharp(layer.png)
      .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
      .png().toBuffer(),
    left: Math.max(0, x),
    top: Math.max(0, y),
  }
}

/**
 * Turn a coverage mask into a soft shadow layer.
 *
 * The mask is written into a buffer that ALREADY carries the blur's padding, it
 * is blurred as a mask, and the colour is attached afterwards. The obvious
 * shorter version — create the colour, `joinChannel` the mask, `extend` for
 * room, `blur` — is what was here before, and sharp reorders those against each
 * other: raising the opacity of a shadow built that way made it FAINTER, which
 * is how the reordering was found. Nothing below depends on sharp's call order.
 */
async function shadowLayer(
  mask: Buffer, width: number, height: number, sigma: number,
): Promise<Buffer> {
  const softened = await blurMask(mask, width, height, sigma)

  const rgba = Buffer.allocUnsafe(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4]     = SHADOW_COLOR.r
    rgba[i * 4 + 1] = SHADOW_COLOR.g
    rgba[i * 4 + 2] = SHADOW_COLOR.b
    rgba[i * 4 + 3] = softened[i]
  }

  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer()
}

/**
 * The contact shadow: a short smear at each foot, at ITS OWN height.
 *
 * Not on a shared baseline — in a three-quarter view the back feet sit higher in
 * the frame than the front ones while standing on the same floor, and a shadow
 * drawn on one line under all of them reads as a plinth.
 */
async function contactShadow(
  alpha: Buffer, width: number, height: number,
): Promise<Overlay | null> {
  const bounds: Bounds = { left: 0, top: 0, right: width - 1, bottom: height - 1, width, height }
  const lowest = lowestOpaqueRows(alpha, width, bounds)

  let floor = -1
  for (const y of lowest) if (y > floor) floor = y
  if (floor < 0) return null

  const rise = Math.max(4, Math.round(height * CONTACT_RISE_RATIO))
  const columns = contactColumns(lowest, rise)
  if (!columns.some(c => c)) return null

  const thickness = Math.max(4, Math.round(height * CONTACT_THICKNESS_RATIO))
  const sigma = Math.max(2, Math.round(width * 0.008))
  const half = Math.max(2, Math.round(thickness / 2))
  const peak = Math.round(255 * CONTACT_OPACITY)

  // Nudged down by a fraction of its own thickness: the band is centred on the
  // contact point, so without this most of it is hidden behind the product and
  // only a sliver shows below the foot.
  const bias = Math.round(half * CONTACT_BIAS)

  // Room for the blur AND for how far the biased band already reaches past the
  // product's own box. Too little and the layer ends mid-shadow, which is a
  // hard line across the floor rather than a shadow.
  const pad = Math.ceil(sigma * 3) + half + bias

  const layerWidth = width + pad * 2
  const layerHeight = height + pad * 2
  const mask = Buffer.alloc(layerWidth * layerHeight)

  for (let x = 0; x < width; x++) {
    if (!columns[x]) continue
    const y = lowest[x] + bias
    for (let dy = -half; dy <= half; dy++) {
      const row = y + dy
      if (row < -pad || row >= height + pad) continue
      const fade = 1 - Math.pow(Math.abs(dy) / (half + 1), 2)
      mask[(row + pad) * layerWidth + x + pad] = Math.round(peak * Math.max(0, fade))
    }
  }

  const png = await shadowLayer(mask, layerWidth, layerHeight, sigma)
  return { png, width: layerWidth, height: layerHeight, offsetX: -pad, offsetY: -pad }
}

/**
 * The cast shadow: a soft pool leaning away from the light.
 *
 * Derived from the FOOTPRINT — the columns that actually reach the floor —
 * rather than from the whole silhouette. Squashing an entire chair, back and
 * all, into a band produces a dense rectangular smudge that reads as a plinth;
 * a chair's shadow on a studio floor is the shape it stands on, stretched away
 * from the light and blurred until it is barely there.
 *
 * Composited BEFORE the product, so it can never darken it.
 */
async function castShadow(
  alpha: Buffer, width: number, height: number,
): Promise<Overlay | null> {
  const bounds: Bounds = { left: 0, top: 0, right: width - 1, bottom: height - 1, width, height }
  const lowest = lowestOpaqueRows(alpha, width, bounds)

  let floor = -1
  for (const y of lowest) if (y > floor) floor = y
  if (floor < 0) return null

  const rise = Math.max(4, Math.round(height * CONTACT_RISE_RATIO))
  const columns = contactColumns(lowest, rise)
  if (!columns.some(c => c)) return null

  const depth = Math.max(12, Math.round(height * CAST_DEPTH_RATIO))
  const sigma = Math.max(5, Math.round(width * CAST_BLUR_RATIO))
  const pad = Math.ceil(sigma * 3)
  const peak = Math.round(255 * CAST_OPACITY)

  const layerWidth = width + pad * 2
  const layerHeight = depth + pad * 2

  // The footprint, opened downward into a shallow pool that fades with distance
  // from the feet.
  const mask = Buffer.alloc(layerWidth * layerHeight)
  for (let x = 0; x < width; x++) {
    if (!columns[x]) continue
    for (let y = 0; y < depth; y++) {
      const fade = 1 - y / depth
      mask[(y + pad) * layerWidth + x + pad] = Math.round(peak * fade * fade)
    }
  }

  const png = await shadowLayer(mask, layerWidth, layerHeight, sigma)

  return {
    png,
    width: layerWidth,
    height: layerHeight,
    // To the right, away from a light at the upper left, and lifted a little so
    // it reads as going back rather than lying toward the viewer. Measured from
    // the product's own top-left, and both are shifted by the blur padding.
    offsetX: Math.round(width * CAST_LEAN) - pad,
    offsetY: height - Math.round(depth * 0.35) - pad,
  }
}

// ─── Compose ──────────────────────────────────────────────────────────────────

export async function composeStudioImage(
  cutoutPng: Buffer,
  presetKey?: OutputPresetKey,
): Promise<ComposeResult> {
  const preset: OutputPreset = resolveOutputPreset(presetKey)
  const [canvasWidth, canvasHeight] = preset.shotSize

  let width: number
  let height: number
  try {
    const meta = await sharp(cutoutPng, { failOn: 'error' }).metadata()
    width = meta.width ?? 0
    height = meta.height ?? 0
  } catch {
    return { ok: false, error: 'The cut-out could not be read. Please try again.' }
  }
  if (!width || !height) return { ok: false, error: 'The cut-out could not be read. Please try again.' }

  try {
    const alpha = await sharp(cutoutPng).ensureAlpha().extractChannel(3).raw().toBuffer()

    // An opaque image is not a cut-out: composing it would paste a rectangle of
    // factory floor onto the studio background.
    let transparent = 0
    for (let i = 0; i < alpha.length; i++) if (alpha[i] < 8) transparent++
    if (transparent < alpha.length * 0.01) {
      return {
        ok: false,
        error: 'The product could not be separated from that photograph. Try a photograph with the product clearly visible.',
      }
    }

    const bounds = alphaBounds(alpha, width, height)
    if (!bounds) {
      return {
        ok: false,
        error: 'The product could not be separated from that photograph. Try a photograph with the product clearly visible.',
      }
    }

    // ── The quality gate ─────────────────────────────────────────────────────
    const verdict = checkEnlargement(bounds, preset.target)
    if (!verdict.ok) {
      return {
        ok: false,
        error: 'quality',
        quality: {
          message: verdict.message,
          detail:
            `product ${bounds.width}x${bounds.height} in a ${width}x${height} cut-out; ` +
            `would need ${verdict.scale.toFixed(2)}x enlargement (cap ${MAX_ENLARGEMENT}); ` +
            `needs a product about ${verdict.needed}px tall`,
        },
      }
    }

    // ── Crop, defringe, correct, scale, sharpen ──────────────────────────────
    const cropped = await sharp(cutoutPng)
      .ensureAlpha()
      .extract({ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height })
      .raw()
      .toBuffer()

    const croppedPixels = bounds.width * bounds.height
    await defringe(cropped, bounds.width, bounds.height)

    const tone = decideTone(toneStats(cropped, croppedPixels))
    applyTone(cropped, croppedPixels, tone)

    const corrected = await sharp(cropped, {
      raw: { width: bounds.width, height: bounds.height, channels: 4 },
    }).png().toBuffer()

    const plan = planPlacement(bounds, preset.target)

    // One resize, Lanczos, both axes by the same factor: scaled as a whole,
    // never stretched.
    const scaled = await sharp(corrected)
      .resize(plan.width, plan.height, { kernel: 'lanczos3', fit: 'fill' })
      .png()
      .toBuffer()

    const product = await sharpenInterior(scaled, plan.width, plan.height)
    const productAlpha = await sharp(product).ensureAlpha().extractChannel(3).raw().toBuffer()

    // ── Shadows, then the product on top of them ─────────────────────────────
    const composites: OverlayOptions[] = []

    const cast = await castShadow(productAlpha, plan.width, plan.height)
    if (cast) {
      const placed = await place(cast, plan.left, plan.top, canvasWidth, canvasHeight)
      if (placed) composites.push(placed)
    }

    const contact = await contactShadow(productAlpha, plan.width, plan.height)
    let contactColumnCount = 0
    if (contact) {
      const lowest = lowestOpaqueRows(productAlpha, plan.width, {
        left: 0, top: 0, right: plan.width - 1, bottom: plan.height - 1,
        width: plan.width, height: plan.height,
      })
      contactColumnCount = contactColumns(lowest, Math.max(4, Math.round(plan.height * CONTACT_RISE_RATIO)))
        .reduce((n, c) => n + (c ? 1 : 0), 0)
      const placed = await place(contact, plan.left, plan.top, canvasWidth, canvasHeight)
      if (placed) composites.push(placed)
    }

    composites.push({ input: product, left: plan.left, top: plan.top })

    const canvas = await background(canvasWidth, canvasHeight)
    // Composited to raw, then flattened in its own pipeline: a `flatten` chained
    // onto a `composite` is applied BEFORE the compositing it is meant to
    // follow, leaving an alpha channel on an image that would print black.
    const composited = await sharp(canvas)
      .composite(composites.map(c => ({ ...c, blend: 'over' as const })))
      .raw()
      .toBuffer()

    const png = await sharp(composited, {
      raw: { width: canvasWidth, height: canvasHeight, channels: 4 },
    })
      .flatten({ background: BACKGROUND_BASE })
      .png({ compressionLevel: 9 })
      .toBuffer()

    return {
      ok: true,
      png,
      metrics: {
        cutout: { width, height },
        bounds,
        scale: plan.scale,
        placement: { left: plan.left, top: plan.top, width: plan.width, height: plan.height },
        preset: preset.key,
        canvas: { width: canvasWidth, height: canvasHeight },
        tone,
        contactColumns: contactColumnCount,
      },
    }
  } catch (e) {
    console.error('[composeStudioImage] failed on', `${width}x${height}`, e)
    return { ok: false, error: 'That photograph could not be composed into a studio image. Please try again.' }
  }
}
