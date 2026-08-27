// Lighting and colour, decided from the photograph rather than applied to it.
//
// A factory photograph is usually underexposed and flat, and the finished image
// has to look lit. But BOE ships the object in the picture, so every adjustment
// here is bounded, measured, and chosen so that a photograph which is ALREADY
// well exposed receives almost nothing. There is no fixed "studio filter": the
// numbers below come from the product's own luminance statistics.
//
// WHITE BALANCE, AND WHY IT IS SHAPED THE WAY IT IS
// -------------------------------------------------
// A workshop's lighting leaves a cast, and a cast left in place makes teak look
// grey and white upholstery look blue — "colours remain faithful" fails either
// way, so doing nothing is not the safe option it appears to be.
//
// What IS unsafe is grey-world: it assumes the average of a photograph should
// be neutral, which for a photograph of one wooden chair says the chair should
// be grey. So the estimate here comes only from surfaces that ought to be
// neutral and are (neutralStats), it is damped, it is capped at a few percent
// per channel, and it disables itself entirely when the product has no neutral
// surface to measure. A solid teak stool gets no correction at all.
//
// Nothing here changes geometry: every operation is per-pixel.

import { toneStats, neutralStats, luma, type ToneStats, type NeutralStats } from './productMetrics'

/** Where a well-lit product's median luminance sits. Chosen mid-range: high
 *  enough that a dim workshop photograph is visibly corrected, low enough that
 *  it does not bleach dark walnut. */
export const TARGET_MEDIAN = 124

/** The most exposure this may add. A photograph needing more than this is
 *  darker than a correction can honestly rescue. */
export const MAX_GAIN = 1.45

/** The most it may take away, for a photograph shot into a light background. */
export const MIN_GAIN = 0.92

/** The brightest MATERIAL is not allowed past this after the gain, so white
 *  upholstery keeps its texture instead of turning into a flat white shape.
 *  Specular pixels above it are left to clip, as they do in any photograph. */
export const HIGHLIGHT_CEILING = 246

/** Midtone contrast. The curve is endpoint-preserving, so this cannot clip
 *  anything at either end however dark or bright the photograph is. */
export const CONTRAST_K = 0.13

/** Restrained saturation. Enough to lift the flatness a workshop's mixed
 *  lighting leaves behind; far short of making teak look orange. */
export const SATURATION = 1.05

/** The smallest share of near-neutral pixels worth trusting an estimate from. */
export const MIN_NEUTRAL_SHARE = 0.02

/** How far toward neutral the estimate is followed. Half-measures on purpose:
 *  a partial correction of a real cast beats a full correction of a wrong one. */
export const WHITE_BALANCE_DAMPING = 0.6

/** The hard limit per channel, whatever the estimate says. */
export const MAX_CHANNEL_GAIN = 1.06
export const MIN_CHANNEL_GAIN = 0.94

export type WhiteBalance = {
  r: number
  g: number
  b: number
  /** Whether an estimate was made at all. */
  applied: boolean
  neutral: NeutralStats
}

export type ToneDecision = {
  gain: number
  contrastK: number
  saturation: number
  whiteBalance: WhiteBalance
  stats: ToneStats
  /** Why this gain, for the server log. */
  reason: 'underexposed' | 'bright' | 'already-exposed' | 'highlight-limited'
}

/**
 * Per-channel gains that move the product's neutral surfaces toward neutral.
 *
 * Declines — returns 1,1,1 — when there are too few neutral pixels to be sure
 * what the light was doing.
 */
export function decideWhiteBalance(neutral: NeutralStats): WhiteBalance {
  const off = { r: 1, g: 1, b: 1, applied: false, neutral }
  if (neutral.count === 0 || neutral.share < MIN_NEUTRAL_SHARE) return off

  const target = (neutral.r + neutral.g + neutral.b) / 3
  if (target <= 0) return off

  const bounded = (channel: number): number => {
    const raw = target / Math.max(1, channel)
    const damped = 1 + (raw - 1) * WHITE_BALANCE_DAMPING
    return Math.max(MIN_CHANNEL_GAIN, Math.min(MAX_CHANNEL_GAIN, damped))
  }

  return {
    r: bounded(neutral.r), g: bounded(neutral.g), b: bounded(neutral.b),
    applied: true, neutral,
  }
}

/**
 * Choose the correction for one product.
 *
 * The order matters: the exposure the median asks for is computed first, then
 * the highlights get a veto. A photograph of white upholstery is usually dark
 * in the median AND close to clipping at the top — the veto is what stops it
 * being "corrected" into a white silhouette.
 */
export function decideTone(stats: ToneStats, neutral: NeutralStats = { count: 0, r: 0, g: 0, b: 0, share: 0 }): ToneDecision {
  let reason: ToneDecision['reason'] = 'already-exposed'
  let gain = 1

  const whiteBalance = decideWhiteBalance(neutral)

  if (stats.samples === 0) {
    return { gain: 1, contrastK: 0, saturation: 1, whiteBalance, stats, reason }
  }

  if (stats.median < TARGET_MEDIAN - 6) {
    gain = Math.min(MAX_GAIN, TARGET_MEDIAN / Math.max(1, stats.median))
    reason = 'underexposed'
  } else if (stats.median > TARGET_MEDIAN + 40) {
    gain = Math.max(MIN_GAIN, TARGET_MEDIAN / stats.median)
    reason = 'bright'
  }

  // The highlight veto. Only ever reduces the gain, and it reads p98 rather
  // than p99 so a handful of specular pixels cannot cancel the correction for
  // the whole product — see the note on ToneStats.p98.
  if (gain > 1 && stats.p98 > 0) {
    const headroom = HIGHLIGHT_CEILING / stats.p98
    if (headroom < gain) {
      gain = Math.max(1, headroom)
      reason = 'highlight-limited'
    }
  }

  return { gain, contrastK: CONTRAST_K, saturation: SATURATION, whiteBalance, stats, reason }
}

/**
 * The tone curve as a 256-entry lookup table.
 *
 * `gain` first, then a smooth S applied about the midpoint:
 *
 *     f(x) = x + k · x · (1 − x) · (2x − 1)      for x in [0, 1]
 *
 * which is zero at both ends and steepest in the midtones. That shape is the
 * whole reason highlights survive: at x = 1 the correction is exactly nothing,
 * so no amount of contrast can push white upholstery into clipping.
 */
export function buildToneLut(
  decision: Pick<ToneDecision, 'gain' | 'contrastK'>,
  channelGain = 1,
): Uint8Array {
  const lut = new Uint8Array(256)

  for (let i = 0; i < 256; i++) {
    // The white-balance gain rides on the exposure gain, before the curve, so
    // the curve's endpoint-preserving shape still guarantees nothing clips.
    const x = Math.min(1, (i / 255) * decision.gain * channelGain)
    const shaped = x + decision.contrastK * x * (1 - x) * (2 * x - 1)
    lut[i] = Math.max(0, Math.min(255, Math.round(shaped * 255)))
  }

  return lut
}

/**
 * Apply the decision to one RGBA buffer, in place.
 *
 * Alpha is never touched — not by the curve, not by the saturation — so the
 * cut-out's edges survive exactly as the provider returned them. Saturation is
 * a move away from the pixel's own grey, which keeps hue and leaves a neutral
 * pixel neutral: white upholstery does not acquire a colour cast.
 */
export function applyTone(rgba: Uint8Array | Buffer, pixels: number, decision: ToneDecision): void {
  const wb = decision.whiteBalance
  const lutR = buildToneLut(decision, wb.r)
  const lutG = buildToneLut(decision, wb.g)
  const lutB = buildToneLut(decision, wb.b)
  const s = decision.saturation

  for (let i = 0; i < pixels; i++) {
    const o = i * 4
    if (rgba[o + 3] === 0) continue

    const r = lutR[rgba[o]]
    const g = lutG[rgba[o + 1]]
    const b = lutB[rgba[o + 2]]

    if (s === 1) {
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b
      continue
    }

    const l = luma(r, g, b)
    rgba[o]     = Math.max(0, Math.min(255, Math.round(l + (r - l) * s)))
    rgba[o + 1] = Math.max(0, Math.min(255, Math.round(l + (g - l) * s)))
    rgba[o + 2] = Math.max(0, Math.min(255, Math.round(l + (b - l) * s)))
  }
}

/** Measure one RGBA buffer and correct it, returning what was decided so the
 *  route can log why this photograph got the treatment it did. */
export function enhanceRgba(rgba: Uint8Array | Buffer, pixels: number): ToneDecision {
  const decision = decideTone(toneStats(rgba, pixels), neutralStats(rgba, pixels))
  applyTone(rgba, pixels, decision)
  return decision
}
