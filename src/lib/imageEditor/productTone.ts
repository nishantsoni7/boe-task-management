// Lighting and colour, decided from the product rather than applied to it.
//
// A factory photograph is usually underexposed and flat, and a catalogue image
// has to look lit. But BOE ships the object in the picture, so every adjustment
// here is measured, bounded, and shaped so that a photograph which is ALREADY
// well exposed receives almost nothing. There is no fixed "studio filter".
//
// Alpha is never read as colour and never written. Every operation is per-pixel
// on RGB, so nothing here can move an edge, thin a leg or reshape anything.

export const ALPHA_OPAQUE = 200

/** Where a well-lit product's median luminance sits. Mid-range: high enough to
 *  visibly correct a dim workshop photograph, low enough not to bleach walnut. */
export const TARGET_MEDIAN = 124

/** The most exposure this may add. Past this a photograph is darker than a
 *  correction can honestly rescue. */
export const MAX_GAIN = 1.35

/** The most it may take away, for a product shot against a bright background. */
export const MIN_GAIN = 0.94

/** The brightest MATERIAL may not pass this after the gain, so white upholstery
 *  keeps its texture instead of turning into a flat white shape. Specular
 *  pixels above it are left to clip, as they do in any photograph. */
export const HIGHLIGHT_CEILING = 246

/** Midtone contrast. The curve is endpoint-preserving, so this cannot clip
 *  anything at either end however dark or bright the photograph is. */
export const CONTRAST_K = 0.10

/** Restrained saturation: enough to lift the flatness mixed workshop lighting
 *  leaves behind, far short of making teak look orange. */
export const SATURATION = 1.04

export type ToneStats = {
  median: number
  /**
   * 98th percentile luminance — how close the brightest MATERIAL is to
   * clipping. Not the 99th and not the maximum: almost every photograph of
   * furniture has a few specular pixels at 250+, and measured at the 99th those
   * pixels veto the correction for the whole product, so a dim photograph comes
   * back exactly as flat as it went in.
   */
  p98: number
  p99: number
  mean: number
  samples: number
}

/** ITU-R BT.601 luma, the weighting sharp uses for greyscale. */
export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/**
 * Luminance statistics over SOLID product pixels only.
 *
 * The alpha test is what makes this meaningful: a cut-out is mostly
 * transparent, and transparent pixels carry whatever RGB the provider left
 * behind. Including them would put the median near black and hand every
 * photograph the same large correction.
 */
export function toneStats(rgba: Uint8Array | Buffer, pixels: number): ToneStats {
  const histogram = new Uint32Array(256)
  let samples = 0
  let sum = 0

  for (let i = 0; i < pixels; i++) {
    const o = i * 4
    if (rgba[o + 3] < ALPHA_OPAQUE) continue
    const l = Math.round(luma(rgba[o], rgba[o + 1], rgba[o + 2]))
    histogram[l]++
    samples++
    sum += l
  }

  if (samples === 0) return { median: 128, p98: 255, p99: 255, mean: 128, samples: 0 }

  const at = (fraction: number): number => {
    let seen = 0
    const goal = fraction * samples
    for (let l = 0; l < 256; l++) {
      seen += histogram[l]
      if (seen >= goal) return l
    }
    return 255
  }

  return { median: at(0.5), p98: at(0.98), p99: at(0.99), mean: sum / samples, samples }
}

export type ToneDecision = {
  gain: number
  contrastK: number
  saturation: number
  stats: ToneStats
  reason: 'underexposed' | 'bright' | 'already-exposed' | 'highlight-limited'
}

/**
 * Choose the correction for one product.
 *
 * Order matters: the exposure the median asks for is computed first, then the
 * highlights get a veto. A photograph of white upholstery is usually dark in
 * the median AND close to clipping at the top — the veto is what stops it being
 * "corrected" into a white silhouette.
 */
export function decideTone(stats: ToneStats): ToneDecision {
  let reason: ToneDecision['reason'] = 'already-exposed'
  let gain = 1

  if (stats.samples === 0) {
    return { gain: 1, contrastK: 0, saturation: 1, stats, reason }
  }

  if (stats.median < TARGET_MEDIAN - 6) {
    gain = Math.min(MAX_GAIN, TARGET_MEDIAN / Math.max(1, stats.median))
    reason = 'underexposed'
  } else if (stats.median > TARGET_MEDIAN + 40) {
    gain = Math.max(MIN_GAIN, TARGET_MEDIAN / stats.median)
    reason = 'bright'
  }

  if (gain > 1 && stats.p98 > 0) {
    const headroom = HIGHLIGHT_CEILING / stats.p98
    if (headroom < gain) {
      gain = Math.max(1, headroom)
      reason = 'highlight-limited'
    }
  }

  return { gain, contrastK: CONTRAST_K, saturation: SATURATION, stats, reason }
}

/**
 * The tone curve as a 256-entry lookup table.
 *
 * `gain` first, then a smooth S about the midpoint:
 *
 *     f(x) = x + k · x · (1 − x) · (2x − 1)      for x in [0, 1]
 *
 * zero at both ends and steepest in the midtones. That shape is the whole
 * reason highlights survive: at x = 1 the correction is exactly nothing, so no
 * amount of contrast can push white upholstery into clipping.
 */
export function buildToneLut(decision: Pick<ToneDecision, 'gain' | 'contrastK'>): Uint8Array {
  const lut = new Uint8Array(256)

  for (let i = 0; i < 256; i++) {
    const x = Math.min(1, (i / 255) * decision.gain)
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
  const lut = buildToneLut(decision)
  const s = decision.saturation

  for (let i = 0; i < pixels; i++) {
    const o = i * 4
    if (rgba[o + 3] === 0) continue

    const r = lut[rgba[o]]
    const g = lut[rgba[o + 1]]
    const b = lut[rgba[o + 2]]

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
  const decision = decideTone(toneStats(rgba, pixels))
  applyTone(rgba, pixels, decision)
  return decision
}
