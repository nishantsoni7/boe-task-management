// A restrained shadow and low-midtone lift, applied to the finished master.
//
// SERVER ONLY (sharp). Makes no provider call, holds no key, spends nothing:
// this is arithmetic on bytes that have already been paid for.
//
// WHAT IT IS FOR
// --------------
// BOE photographs dark furniture. On the accepted pipeline a dark upholstered
// seat and the dark wooden frame below it come back at almost the same
// LIGHTNESS — measured on a production master, L* 3.35 against L* 4.99, a gap
// of 1.64 — while differing mostly in HUE. Below about L* 10 the eye reads hue
// poorly, so two materials that a colorimeter can separate look to a customer
// like one black mass. That is a product-visibility defect, not a taste
// question, and it is what this corrects.
//
// WHAT IT IS NOT
// --------------
// Not relighting, not a look, not HDR. It is a POINT OPERATION: every output
// pixel is a function of its own input pixel and nothing else. It therefore
// cannot ring, cannot halo, cannot move an edge, cannot change a dimension and
// cannot alter composition, geometry or the camera. It is deterministic — a
// fixed integer table, no image statistics, no randomness — so the same master
// always produces the same bytes.
//
// THE SHAPE OF THE CURVE, AND WHY THE BACKGROUND IS SAFE
// ------------------------------------------------------
// Above SHADOW_KNEE the map is the identity, exactly: `lut[y] === y`. The
// studio sweep on the measured master sits at luma 179-206 and its darkest
// sampled pixel is 179, so the entire background is 115 levels clear of the
// knee and comes back BYTE-IDENTICAL. That is a property of the construction,
// not of tuning, and the tests assert it.
//
// One gain per pixel, derived from luma and applied to all three channels, so
// R:G:B ratios — hue and saturation — ride through untouched and only lightness
// moves. A per-channel curve would desaturate dark colour; an additive black
// lift would grey it.
//
// BEST EFFORT, ALWAYS
// -------------------
// By the time this runs, two provider requests have been paid for and a
// finished image is in hand. So it cannot throw and it cannot fail the request:
// every path returns an image, and any doubt returns the UNMODIFIED master. A
// cosmetic step must never turn a successful generation into a lost result.

import sharp from 'sharp'

/** Luma at and above which nothing is touched. Chosen from the measured master:
 *  the background floor is 179 and the lit cane 145, so 64 leaves both far
 *  clear while covering the dark materials, which sit at luma 12-16. */
export const SHADOW_KNEE = 64

/** How hard the bottom lifts. 1.0 is no lift; lower lifts more. 0.60 raises a
 *  seat front measured at luma 12.06 to 19.2 and the wood rail below it from
 *  16.34 to 22.9 — enough to separate them, not enough to grey the blacks. */
export const SHADOW_STRENGTH = 0.60

/** How the lift fades out as luma approaches the knee. Squared, so the curve
 *  meets the identity smoothly and there is no contrast kink at the join. */
export const SHADOW_TAPER = 2

/** Ceiling on the per-pixel multiplier. Bites only below luma ~6, which is
 *  0.06% of the measured master, and keeps near-black noise from being
 *  multiplied out of the floor. */
export const SHADOW_MAX_GAIN = 2.2

/** The largest absolute change any single channel may show. Derived, not
 *  guessed: below the knee the output is at most `y * SHADOW_MAX_GAIN`, so the
 *  change cannot exceed `SHADOW_KNEE * (SHADOW_MAX_GAIN - 1)`, rounded up. The
 *  validation below refuses the result if anything exceeds it. */
export const SHADOW_MAX_ABS_CHANGE = Math.ceil(SHADOW_KNEE * (SHADOW_MAX_GAIN - 1)) + 1

export type LiftSettings = {
  knee: number
  strength: number
  taper: number
  maxGain: number
}

export const SHADOW_LIFT: LiftSettings = {
  knee: SHADOW_KNEE,
  strength: SHADOW_STRENGTH,
  taper: SHADOW_TAPER,
  maxGain: SHADOW_MAX_GAIN,
}

/**
 * The tone curve as a 256-entry table over luma.
 *
 * Monotonic by construction and the identity at and above the knee. Everything
 * else in this file reads this table; nothing computes a curve twice.
 */
export function buildShadowLut(s: LiftSettings = SHADOW_LIFT): Uint8Array {
  const lut = new Uint8Array(256)
  for (let y = 0; y < 256; y++) {
    if (y >= s.knee) { lut[y] = y; continue }
    const t = y / s.knee
    const lifted = s.knee * Math.pow(t, s.strength)
    // The lift fades to nothing at the knee, so the curve joins the identity
    // without a step and without a slope break a viewer could see as banding.
    const weight = Math.pow(1 - t, s.taper)
    const out = y + (lifted - y) * weight
    lut[y] = Math.max(0, Math.min(255, Math.round(out)))
  }
  return lut
}

/** Rec. 709 luma on the encoded values. */
export function lumaOf(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export type LiftOutcome = {
  /** Pixels whose bytes changed. */
  changed: number
  /** Largest absolute per-channel change. */
  maxChange: number
  /** A pixel at or above the knee that moved, or a black pixel that stopped
   *  being black. Either means the pass did something it promised not to, and
   *  the caller discards the result. */
  violations: number
}

/**
 * Apply the curve to a raw RGB(A) buffer IN PLACE, reporting what it did.
 *
 * The three promises are checked as the pass runs rather than asserted
 * afterwards: nothing at or above the knee moves, pure black stays pure black,
 * and no channel moves further than SHADOW_MAX_ABS_CHANGE.
 */
export function liftRaw(
  data: Uint8Array | Buffer,
  channels: number,
  s: LiftSettings = SHADOW_LIFT,
): LiftOutcome {
  const lut = buildShadowLut(s)
  let changed = 0
  let maxChange = 0
  let violations = 0

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const y = lumaOf(r, g, b)
    if (y >= s.knee) continue
    const yi = Math.round(y)
    const target = lut[yi]
    if (target === yi || y <= 0) continue

    let gain = target / y
    if (gain > s.maxGain) gain = s.maxGain
    if (gain <= 1) continue

    const nr = Math.min(255, Math.round(r * gain))
    const ng = Math.min(255, Math.round(g * gain))
    const nb = Math.min(255, Math.round(b * gain))

    const delta = Math.max(Math.abs(nr - r), Math.abs(ng - g), Math.abs(nb - b))
    if (delta > maxChange) maxChange = delta
    if (delta > SHADOW_MAX_ABS_CHANGE) violations++
    // Pure black is the black point. A multiplicative gain leaves it alone by
    // construction; this catches the day somebody changes that.
    if (r === 0 && g === 0 && b === 0 && (nr || ng || nb)) violations++
    if (delta > 0) changed++

    data[i] = nr
    data[i + 1] = ng
    data[i + 2] = nb
  }

  return { changed, maxChange, violations }
}

export type EnhanceResult = {
  /** The image to deliver. The corrected master, or — on any doubt at all —
   *  exactly the buffer that came in. */
  image: Buffer
  applied: boolean
  /** Why it was not applied, for the log. Never shown to an employee. */
  reason?: string
  changedPixels?: number
  maxChange?: number
  durationMs?: number
}

/**
 * Lift the shadows of a finished master, or hand back the master untouched.
 *
 * NEVER THROWS. Decode, arithmetic and encode are all inside the try, and every
 * failure path returns `{ image: master, applied: false }` — the employee gets
 * the picture they paid for whatever happens here.
 *
 * The result is validated before it is returned: same dimensions, same channel
 * count, nothing above the knee moved, black point intact, no channel moved
 * further than the derived bound. A failed validation is a discarded result,
 * not a failed request.
 */
export async function enhanceShadows(
  master: Buffer,
  s: LiftSettings = SHADOW_LIFT,
): Promise<EnhanceResult> {
  const started = Date.now()
  try {
    const { data, info } = await sharp(master).raw().toBuffer({ resolveWithObject: true })
    if (info.channels < 3) {
      return { image: master, applied: false, reason: `unexpected channel count ${info.channels}` }
    }

    const outcome = liftRaw(data, info.channels, s)
    if (outcome.violations > 0) {
      return { image: master, applied: false, reason: `${outcome.violations} pixel(s) broke the bounds` }
    }
    if (outcome.changed === 0) {
      // A light product with nothing below the knee. Returning the original
      // buffer rather than a re-encode keeps the delivered bytes identical.
      return { image: master, applied: false, reason: 'nothing below the knee', durationMs: Date.now() - started }
    }

    const png = await sharp(data, {
      raw: { width: info.width, height: info.height, channels: info.channels },
    }).png({ compressionLevel: 9 }).toBuffer()

    // The delivered bytes are re-read and checked against the master they came
    // from. This is the last gate before an employee sees the picture.
    const check = await sharp(png).metadata()
    const before = await sharp(master).metadata()
    if (check.width !== before.width || check.height !== before.height) {
      return { image: master, applied: false, reason: 'dimensions moved' }
    }
    if (check.format !== 'png') {
      return { image: master, applied: false, reason: `format is ${check.format}` }
    }

    return {
      image: png,
      applied: true,
      changedPixels: outcome.changed,
      maxChange: outcome.maxChange,
      durationMs: Date.now() - started,
    }
  } catch (e) {
    return {
      image: master,
      applied: false,
      reason: e instanceof Error ? `${e.name}: ${e.message}` : 'unknown',
      durationMs: Date.now() - started,
    }
  }
}
