// The studio image, built locally around the exact cut-out.
//
// SERVER ONLY (sharp is a native module). No model, no provider, no randomness:
// the same cut-out composes to the same bytes every time.
//
// THE RULE THIS FILE EXISTS TO KEEP
// ---------------------------------
// The final visible furniture is the cut-out and nothing else. It is the top
// layer, composited over a background and shadows that are drawn beneath it, so
// every opaque product pixel in the master is the cut-out's own pixel and every
// transparent opening in the cut-out shows background through it.
//
// That is not a preference. A generative pass was tried and it repainted the
// product: a fan of thin spindles under a chair seat came back as a dark
// continuous mass, the openings between them filled in, and no amount of
// prompting or padding could constrain it — placing a product into a generated
// scene means harmonising it with that scene's light, and harmonising is
// repainting. Nothing here may repaint anything.
//
// WHAT IS DRAWN, AND IN WHAT ORDER
// --------------------------------
//   1. the sweep — a warm-neutral studio background, drawn pixel by pixel;
//   2. the cast shadow — one soft pool from the product's footprint;
//   3. the contact shadows — a short smear under each foot, at its own height;
//   4. the product, unchanged.
//
// A NOTE ON sharp
// ---------------
// sharp orders its operations internally, not by call order. `flatten`,
// `removeAlpha` and `linear` chained onto other work run at their own point in
// the pipeline rather than where they were written, and each has caused a real
// defect in this module. Where order matters, each step is its own pipeline.
// A raw single-channel buffer also comes back as THREE channels unless told
// otherwise, which is why `blurMask` exists.

import sharp from 'sharp'
import type { OverlayOptions } from 'sharp'
import { lowestOpaqueRows, contactColumns, type Bounds } from './cutoutGeometry'
import { MASTER_WIDTH, MASTER_HEIGHT, type PaddingPlan } from './studioMaster'

// ─── The sweep ────────────────────────────────────────────────────────────────
//
// Calibrated against the accepted real outputs, whose backgrounds were measured
// at roughly:
//
//   upper corners and side edges   140-160
//   brighter centre behind product 180-190
//   lower floor                    195-220
//
// The earlier local background was a near-flat 235/232/227 everywhere, which
// read as too cream, too bright and too flat. This one has somewhere to go: a
// wall that falls off into its corners, a floor a little lighter than the wall,
// and a soft lift behind the product.

/** The wall tone before the lift and the falloff are applied. */
const WALL_TONE = 178
/** The floor tone. Slightly lighter than the wall, as a lit cyclorama is. */
const FLOOR_TONE = 212

/**
 * Where the wall becomes the floor.
 *
 * Deliberately a wide band, and eased at both ends: a narrow transition is a
 * horizon, and a visible wall/floor line is the single most obvious tell that a
 * catalogue background was constructed.
 */
const FLOOR_START = 0.52
const FLOOR_END = 0.98

/** The soft brightening behind the product. */
const LIFT = 17
const LIFT_CENTRE_Y = 0.38
const LIFT_RADIUS = 0.46

/** How much the upper corners and the side edges fall away. */
const FALLOFF = 32

/**
 * Warm-neutral, as offsets from the computed tone.
 *
 * A few levels of separation, red high and blue low. Enough to be warm rather
 * than clinical, far too little to read as a yellow cast — and applied as a
 * constant offset so it does not grow with brightness and turn the floor cream.
 */
const WARM = { r: 4, g: 0, b: -6 } as const

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)))

/** Hermite ease, so neither end of the wall/floor transition has a seam. */
const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * The tone of the sweep at one point, before the warm offsets.
 *
 * Exported so a test can assert the calibration anchors without decoding an
 * image, and so the anchors are checked at the source rather than inferred.
 */
export function sweepTone(nx: number, ny: number): number {
  // Wall into floor.
  const base = WALL_TONE + (FLOOR_TONE - WALL_TONE) * smoothstep(FLOOR_START, FLOOR_END, ny)

  // A soft lift behind the product, falling off as a gaussian so it has no rim.
  const dx = nx - 0.5
  const dy = ny - LIFT_CENTRE_Y
  const lift = LIFT * Math.exp(-(dx * dx + dy * dy) / (2 * LIFT_RADIUS * LIFT_RADIUS * 0.5))

  // Darker at the sides at every height, and darker again towards the top, so
  // the upper corners are the deepest point and the floor stays open.
  const sideness = Math.min(1, Math.abs(dx) * 2)
  const topness = Math.max(0, (0.5 - ny) * 2)
  const edgeness = Math.min(1, Math.sqrt(sideness * sideness * 0.85 + topness * topness * 0.95))

  return base + lift - FALLOFF * Math.pow(edgeness, 1.7)
}

/** The finished sweep, as an opaque RGB image. Continuous by construction:
 *  there is nothing in this function that could draw a line. */
export async function studioSweep(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.allocUnsafe(width * height * 3)

  for (let y = 0; y < height; y++) {
    const ny = (y + 0.5) / height
    for (let x = 0; x < width; x++) {
      const tone = sweepTone((x + 0.5) / width, ny)
      const o = (y * width + x) * 3
      raw[o]     = clamp255(tone + WARM.r)
      raw[o + 1] = clamp255(tone + WARM.g)
      raw[o + 2] = clamp255(tone + WARM.b)
    }
  }

  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

// ─── Shadows ──────────────────────────────────────────────────────────────────

/** Near-neutral and a touch warm, so it sits in this background rather than on
 *  top of it. */
const SHADOW_COLOR = { r: 88, g: 84, b: 79 } as const

/** How far above the lowest point a column may end and still be a foot. In a
 *  three-quarter view the back feet sit visibly higher than the front ones
 *  while standing on the same floor. */
const CONTACT_RISE_RATIO = 0.12
const CONTACT_THICKNESS_RATIO = 0.020
const CONTACT_OPACITY = 0.55
/** Nudged down by a fraction of its own half-thickness, so the band is not
 *  mostly hidden behind the product — but under 1, so it still overlaps the
 *  foot and touches it rather than floating below. */
const CONTACT_BIAS = 0.8

/** The cast shadow: a quiet pool from the footprint, leaning right and back. */
const CAST_OPACITY = 0.30
const CAST_DEPTH_RATIO = 0.16
const CAST_LEAN = 0.13
const CAST_BLUR_RATIO = 0.045

/**
 * How far a foot's influence spreads sideways in the CAST shadow.
 *
 * Without this each leg casts its own separate pool and the floor shows four
 * detached smudges — measured as seven separate dark runs across one row, which
 * is the "isolated blobs" the brief rules out. Spreading each foot's weight
 * with a gaussian and keeping it inside the footprint's own span merges them
 * into one coherent shadow that is still denser under the feet than between
 * them: a pool, not a rectangle and not a silhouette.
 */
const CAST_SPREAD_RATIO = 0.14

/**
 * Blur a one-channel mask and get one channel back.
 *
 * sharp reads a raw single-channel buffer as sRGB and returns THREE channels
 * unless told otherwise, so `mask[i]` afterwards would be the red channel of
 * pixel i/3 — a mask silently sampled from the wrong pixels.
 */
async function blurMask(mask: Buffer, width: number, height: number, sigma: number): Promise<Buffer> {
  return sharp(mask, { raw: { width, height, channels: 1 } })
    .blur(sigma).toColourspace('b-w').raw().toBuffer()
}

/**
 * A layer to be drawn, and where it goes relative to the product's top-left.
 *
 * Shadows are larger than the product they belong to — a blur needs room to
 * fall off in, or it ends on a hard line — so their offsets are negative and
 * their edges routinely fall outside the canvas.
 */
type Overlay = { png: Buffer; width: number; height: number; offsetX: number; offsetY: number }

/**
 * Turn a coverage mask into a soft shadow layer.
 *
 * The mask is written into a buffer that already carries the blur's padding, it
 * is blurred as a mask, and the colour is attached afterwards. The shorter
 * version — create the colour, `joinChannel` the mask, `extend`, `blur` — is
 * what was here once, and sharp reorders those against each other: raising the
 * opacity of a shadow built that way made it FAINTER.
 */
async function shadowLayer(mask: Buffer, width: number, height: number, sigma: number): Promise<Buffer> {
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
 * Put one layer on the canvas, cropped to what actually lands on it.
 *
 * sharp refuses a negative offset and refuses an overlay larger than the base,
 * and both happen here in ordinary use — a wide product's shadow layer is wider
 * than the canvas. Cropping first is what lets a shadow run off the edge, as a
 * shadow should, instead of taking the whole composite down with it.
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

/** Where the product meets the floor: the lowest opaque pixel of each column,
 *  and which of those columns count as standing on it. */
function footprint(alpha: Buffer, width: number, height: number) {
  const bounds: Bounds = { left: 0, top: 0, right: width - 1, bottom: height - 1, width, height }
  const lowest = lowestOpaqueRows(alpha, width, bounds)

  let floor = -1
  for (const y of lowest) if (y > floor) floor = y
  if (floor < 0) return null

  const rise = Math.max(4, Math.round(height * CONTACT_RISE_RATIO))
  const columns = contactColumns(lowest, rise)
  if (!columns.some((c: number) => c)) return null

  return { lowest, columns, count: columns.reduce((n: number, c: number) => n + (c ? 1 : 0), 0) }
}

/**
 * A short smear under each foot, at ITS OWN height.
 *
 * Not on one shared baseline: in a three-quarter view the back feet sit higher
 * in the frame than the front ones, and a shadow drawn on one line under all of
 * them reads as a plinth. Because it follows the underside column by column, a
 * chair with four feet gets four smears with open floor between them, and the
 * gaps between the legs stay open.
 */
async function contactShadow(alpha: Buffer, width: number, height: number): Promise<Overlay | null> {
  const foot = footprint(alpha, width, height)
  if (!foot) return null

  const thickness = Math.max(4, Math.round(height * CONTACT_THICKNESS_RATIO))
  const sigma = Math.max(2, Math.round(width * 0.008))
  const half = Math.max(2, Math.round(thickness / 2))
  const peak = Math.round(255 * CONTACT_OPACITY)
  const bias = Math.round(half * CONTACT_BIAS)

  // Room for the blur AND for how far the biased band reaches past the
  // product's own box. Too little and the layer ends mid-shadow, which is a
  // hard line across the floor.
  const pad = Math.ceil(sigma * 3) + half + bias

  const layerWidth = width + pad * 2
  const layerHeight = height + pad * 2
  const mask = Buffer.alloc(layerWidth * layerHeight)

  for (let x = 0; x < width; x++) {
    if (!foot.columns[x]) continue
    const y = foot.lowest[x] + bias
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
 * One soft pool leaning away from the light.
 *
 * Derived from the FOOTPRINT — the columns that actually reach the floor —
 * rather than from the whole silhouette. Squashing an entire chair, back and
 * all, into a band produces a dense rectangular smudge that reads as a plinth;
 * a chair's shadow on a studio floor is the shape it stands on, stretched away
 * from the light and blurred until it is barely there.
 *
 * Composited BEFORE the product, so it can never darken it.
 */
async function castShadow(alpha: Buffer, width: number, height: number): Promise<Overlay | null> {
  const foot = footprint(alpha, width, height)
  if (!foot) return null

  const depth = Math.max(12, Math.round(height * CAST_DEPTH_RATIO))
  const sigma = Math.max(5, Math.round(width * CAST_BLUR_RATIO))
  const pad = Math.ceil(sigma * 3)

  const layerWidth = width + pad * 2
  const layerHeight = depth + pad * 2
  const peak = Math.round(255 * CAST_OPACITY)

  // How strongly each column casts: full under a foot, easing away from one, and
  // nothing at all outside the span the product actually stands on.
  let spanFrom = width
  let spanTo = -1
  for (let x = 0; x < width; x++) {
    if (!foot.columns[x]) continue
    if (x < spanFrom) spanFrom = x
    if (x > spanTo) spanTo = x
  }

  const spread = Math.max(4, width * CAST_SPREAD_RATIO)
  const weight = new Float32Array(width)
  for (let x = spanFrom; x <= spanTo; x++) {
    let nearest = Infinity
    for (let c = spanFrom; c <= spanTo; c++) {
      if (!foot.columns[c]) continue
      const d = Math.abs(x - c)
      if (d < nearest) nearest = d
      if (d === 0) break
    }
    weight[x] = Math.exp(-(nearest * nearest) / (2 * spread * spread))
  }

  const mask = Buffer.alloc(layerWidth * layerHeight)
  for (let x = spanFrom; x <= spanTo; x++) {
    if (weight[x] <= 0.01) continue
    for (let y = 0; y < depth; y++) {
      const fade = 1 - y / depth
      mask[(y + pad) * layerWidth + x + pad] = Math.round(peak * weight[x] * fade * fade)
    }
  }

  const png = await shadowLayer(mask, layerWidth, layerHeight, sigma)
  return {
    png,
    width: layerWidth,
    height: layerHeight,
    // To the right, away from a light at the upper left, and lifted a little so
    // it reads as going back rather than lying towards the viewer.
    offsetX: Math.round(width * CAST_LEAN) - pad,
    offsetY: height - Math.round(depth * 0.35) - pad,
  }
}

// ─── Compose ──────────────────────────────────────────────────────────────────

export type SceneMetrics = {
  canvas: { width: number; height: number }
  placement: { left: number; top: number; width: number; height: number }
  contactColumns: number
  castDrawn: boolean
}

export type SceneResult =
  | { ok: true; png: Buffer; metrics: SceneMetrics }
  | { ok: false; error: string }

/**
 * Put the prepared cut-out on a studio background.
 *
 * `productPng` is the cut-out already cropped, decontaminated and resized. It is
 * placed unchanged: nothing in here reads its colour, and the only thing read
 * from it is its alpha, to know where the feet are.
 */
export async function composeStudioScene(
  productPng: Buffer,
  plan: PaddingPlan,
): Promise<SceneResult> {
  try {
    const { width, height } = plan.product
    const alpha = await sharp(productPng).ensureAlpha().extractChannel(3).raw().toBuffer()

    const composites: OverlayOptions[] = []

    const cast = await castShadow(alpha, width, height)
    if (cast) {
      const placed = await place(cast, plan.padding.left, plan.padding.top, MASTER_WIDTH, MASTER_HEIGHT)
      if (placed) composites.push(placed)
    }

    const contact = await contactShadow(alpha, width, height)
    if (contact) {
      const placed = await place(contact, plan.padding.left, plan.padding.top, MASTER_WIDTH, MASTER_HEIGHT)
      if (placed) composites.push(placed)
    }

    // The product last, so nothing can be drawn over it.
    composites.push({ input: productPng, left: plan.padding.left, top: plan.padding.top })

    const sweep = await studioSweep(MASTER_WIDTH, MASTER_HEIGHT)

    // Composited to raw, then flattened in its own pipeline: a `flatten` chained
    // onto a `composite` is applied BEFORE the compositing it is meant to
    // follow, which leaves an alpha channel on an image that would print black.
    const composited = await sharp(sweep)
      .composite(composites.map(c => ({ ...c, blend: 'over' as const })))
      .raw()
      .toBuffer()

    const png = await sharp(composited, {
      raw: { width: MASTER_WIDTH, height: MASTER_HEIGHT, channels: 4 },
    })
      .removeAlpha()
      .png({ compressionLevel: 9 })
      .toBuffer()

    const foot = footprint(alpha, width, height)
    return {
      ok: true,
      png,
      metrics: {
        canvas: { width: MASTER_WIDTH, height: MASTER_HEIGHT },
        placement: { left: plan.padding.left, top: plan.padding.top, width, height },
        contactColumns: foot?.count ?? 0,
        castDrawn: cast !== null,
      },
    }
  } catch (e) {
    console.error('[composeStudioScene] failed:', e)
    return { ok: false, error: 'That photograph could not be composed into a studio image. Please try again.' }
  }
}
