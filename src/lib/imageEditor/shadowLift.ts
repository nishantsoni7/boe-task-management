// A restrained shadow and low-midtone lift, applied to the finished master.
//
// SERVER ONLY (sharp). Makes no provider call, holds no key, spends nothing:
// this is arithmetic on bytes that have already been paid for.
//
// WHAT IT IS FOR
// --------------
// BOE photographs dark furniture. On the accepted pipeline a dark upholstered
// seat and the dark wooden frame below it come back at almost the same
// LIGHTNESS — measured on the lossless production master, L* 3.30 against
// L* 5.00, a gap of 1.70 — while differing mostly in HUE (CIEDE2000 6.61). Below about L* 10 the eye reads hue
// poorly, so two materials that a colorimeter can separate look to a customer
// like one black mass. That is a product-visibility defect, not a taste
// question, and it is what this corrects.
//
// WHAT IT IS NOT
// --------------
// Not relighting, not a look, not HDR. It is a POINT OPERATION: every output
// pixel is a function of its own input pixel and nothing else. It therefore
// cannot ring, cannot halo, cannot change a dimension and cannot alter
// composition, geometry or the camera. It is deterministic — a fixed integer
// table, no image statistics, no randomness — so the same master always
// produces the same bytes.
//
// WHAT IT DOES NOT PROMISE
// ------------------------
// It does NOT leave a thresholded edge detector's answer unchanged. Geometry is
// fixed — every edge stays exactly where it was — but a gradient near a
// threshold can cross it. Measured on a production master against the gate's
// own Sobel at EDGE_THRESHOLD 18: 2,369 pixels stopped counting as edges and
// 327 started, 0.13% of the frame, and `structureUnderseat` moved 17.06 -> 16.89.
// Monotonicity does not prevent that and nothing here claims it does. It is the
// reason the preservation gate is left measuring what the provider returned
// rather than these bytes — see the call site in the studio route.
//
// THE SHAPE OF THE CURVE, AND WHY THE BACKGROUND IS SAFE
// ------------------------------------------------------
// Above SHADOW_KNEE the map is the identity, exactly: `lut[y] === y`. Measured
// on the lossless production master, EVERY ONE of the 1,530,246 pixels outside
// the located product box has a luma of at least 124.5, none is eligible, and
// none changes: the background, the contact shadow and the cast shadow come
// back byte-identical. That is a property of the construction, not of tuning,
// and the tests assert it.
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
 *  the darkest pixel anywhere outside the product is 124.5 and the lit cane is
 *  145, so 64 leaves both far clear while covering the dark materials, which sit
 *  at luma 11.9 and 16.3. */
export const SHADOW_KNEE = 64

/** How hard the bottom lifts. 1.0 is no lift; lower lifts more. 0.60 raises a
 *  seat front measured at luma 11.92 to 19.18 and the wood rail below it from
 *  16.34 to 22.90, taking their separation from CIEDE2000 6.61 to 11.57 —
 *  enough to read them apart, not enough to grey the blacks. */
export const SHADOW_STRENGTH = 0.60

/** How the lift fades out as luma approaches the knee. Squared, so the curve
 *  meets the identity smoothly and there is no contrast kink at the join. */
export const SHADOW_TAPER = 2

/** Ceiling on the per-pixel multiplier. Bites only below luma ~6, which is
 *  0.09% of the measured master, and keeps near-black noise from being
 *  multiplied out of the floor. */
export const SHADOW_MAX_GAIN = 2.2

/** The largest absolute change any single channel may show. Derived, not
 *  guessed: every channel of a lifted pixel starts below the knee and is
 *  multiplied by at most SHADOW_MAX_GAIN, so no channel can move further than
 *  `(SHADOW_KNEE - 1) * (SHADOW_MAX_GAIN - 1)`, rounded up. The test beside this
 *  file verifies that EXHAUSTIVELY, over all 16,777,216 colours, rather than
 *  trusting the algebra. The validation below refuses the result if anything
 *  exceeds it. */
export const SHADOW_MAX_ABS_CHANGE = Math.ceil((SHADOW_KNEE - 1) * (SHADOW_MAX_GAIN - 1)) + 1

/**
 * A pixel is a shadow only when EVERY channel is below the knee.
 *
 * WHY LUMA ALONE IS THE WRONG TEST. Luma is weighted — 0.2126 R, 0.7152 G,
 * 0.0722 B — so a SATURATED pixel can be dark in luma while one channel is
 * already bright. Pure red (255, 0, 0) reads luma 54.2; a deep blue (0, 0, 150)
 * reads 10.8 and would otherwise be lifted hard enough to drive B to 254. An
 * exhaustive sweep of all 16,777,216 colours measured a worst-case channel
 * change of 118 levels under a luma-only test — far past the derived bound, so
 * a single deep-blue pixel anywhere in a master would have tripped the
 * violation counter and silently discarded the whole correction.
 *
 * Requiring every channel to be below the knee fixes both problems at once: a
 * saturated colour is not a shadow and is left alone, the derived change bound
 * becomes true again — at most `(knee - 1) * (maxGain - 1)` — and the burned-in
 * watermark's dark red edge pixels stop being touched at all. On the measured
 * master the dark materials are unaffected: the seat's median brightest channel
 * is 13 and the rail's is 26, against a knee of 64.
 */
export function isShadowPixel(r: number, g: number, b: number, knee: number): boolean {
  return r < knee && g < knee && b < knee
}

/** No channel may be driven into clipping. Unreachable while every channel
 *  starts below the knee and the gain is capped — kept as defence in depth for
 *  the day somebody changes a constant. */
export const CHANNEL_CEILING = 254

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
    // Every channel below the knee, not merely the luma — see isShadowPixel.
    if (!isShadowPixel(r, g, b, s.knee)) continue
    const y = lumaOf(r, g, b)
    if (y >= s.knee) continue
    const yi = Math.round(y)
    const target = lut[yi]
    if (target === yi || y <= 0) continue

    let gain = target / y
    if (gain > s.maxGain) gain = s.maxGain
    // No channel may be driven into clipping. A saturated pixel can be dark in
    // luma and bright in one channel; see CHANNEL_CEILING.
    const brightest = Math.max(r, g, b)
    if (brightest > 0) {
      const headroom = CHANNEL_CEILING / brightest
      if (gain > headroom) gain = headroom
    }
    if (gain <= 1) continue

    const nr = Math.min(255, Math.round(r * gain))
    const ng = Math.min(255, Math.round(g * gain))
    const nb = Math.min(255, Math.round(b * gain))

    const delta = Math.max(Math.abs(nr - r), Math.abs(ng - g), Math.abs(nb - b))
    if (delta > maxChange) maxChange = delta
    if (delta > SHADOW_MAX_ABS_CHANGE) violations++
    // A channel that was not clipped must not become clipped.
    if ((r < 255 && nr === 255) || (g < 255 && ng === 255) || (b < 255 && nb === 255)) violations++
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
 * VALIDATION, AND EXACTLY WHAT IT COVERS
 * --------------------------------------
 * Two layers, and the comment names each rather than implying more:
 *
 *   DURING the pass, per pixel — nothing at or above the knee is touched (the
 *   loop skips it), pure black stays pure black, no channel moves further than
 *   SHADOW_MAX_ABS_CHANGE, and no unclipped channel reaches 255. Any breach
 *   increments `violations` and the whole result is discarded.
 *
 *   AFTER the encode — the PNG is decoded again and compared with the corrected
 *   raw buffer BYTE FOR BYTE, together with its width, height and channel
 *   count. That is what makes "the delivered bytes are the checked bytes"
 *   literally true rather than an assumption about PNG being lossless.
 *
 * What it does NOT do is re-run the preservation gate; that measures the
 * provider's work and stays where it is. A failed validation is a discarded
 * result, not a failed request.
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

    // The delivered bytes are decoded again and compared with what was actually
    // computed — not trusted because PNG is meant to be lossless. This is the
    // last check before an employee sees the picture.
    const verify = await sharp(png).raw().toBuffer({ resolveWithObject: true })
    if (verify.info.width !== info.width || verify.info.height !== info.height) {
      return { image: master, applied: false, reason: 'dimensions moved' }
    }
    if (verify.info.channels !== info.channels) {
      return { image: master, applied: false, reason: 'channel count moved' }
    }
    if (!Buffer.from(verify.data).equals(Buffer.from(data))) {
      return { image: master, applied: false, reason: 'the encode did not round-trip' }
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
