// What the cut-out actually contains, measured before anything is decided.
//
// Every judgement the composition makes — how far the product may be enlarged,
// whether it is sharp enough to be worth enlarging at all, how bright it is,
// where it touches the floor — comes from a number computed here rather than
// from a constant somebody guessed. The functions are pure over raw pixel
// buffers so they can be tested without sharp and without a provider.

/** A pixel counts as product at or above this alpha. Low, so a soft segmented
 *  edge is treated as product rather than trimmed off it. */
export const ALPHA_THRESHOLD = 8

/** Solid product, used where a soft edge would poison a measurement: tone
 *  statistics, and the interior mask that sharpening is confined to. */
export const ALPHA_OPAQUE = 200

export type Bounds = { left: number; top: number; width: number; height: number }

/** The tight bounding box of everything at or above the alpha threshold. */
export function alphaBounds(alpha: Uint8Array | Buffer, width: number, height: number): Bounds | null {
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
 * The horizontal centre of the product's MASS, not of its bounding box.
 *
 * This is what "centred" means to the eye. A chair photographed with one arm
 * toward the camera has a bounding box whose middle sits away from where the
 * chair looks like it is: centring the box leaves the picture visibly
 * lopsided, and centring the mass does not.
 *
 * Returned relative to the bounds, in pixels.
 */
export function alphaCentroidX(alpha: Uint8Array | Buffer, width: number, bounds: Bounds): number {
  let weighted = 0
  let total = 0

  for (let y = bounds.top; y < bounds.top + bounds.height; y++) {
    const row = y * width
    for (let x = bounds.left; x < bounds.left + bounds.width; x++) {
      const a = alpha[row + x]
      if (a < ALPHA_THRESHOLD) continue
      // + 0.5 because a pixel's weight sits at its centre, not its left edge.
      // Without it a solid block's centroid lands half a pixel left of its own
      // middle, and every placement inherits the bias.
      weighted += (x - bounds.left + 0.5) * a
      total += a
    }
  }

  return total === 0 ? bounds.width / 2 : weighted / total
}

/**
 * For each column of the product, the lowest row that still holds product —
 * relative to the bounds, or -1 for a column the product does not occupy.
 *
 * This is the difference between a shadow and a smear. A chair's shadow belongs
 * under the four points that reach the floor, and this is how those points are
 * found: the columns whose lowest pixel is at, or nearly at, the very bottom.
 */
export function lowestOpaqueRows(
  alpha: Uint8Array | Buffer,
  width: number,
  bounds: Bounds,
): Int32Array {
  const lowest = new Int32Array(bounds.width).fill(-1)

  for (let x = 0; x < bounds.width; x++) {
    for (let y = bounds.height - 1; y >= 0; y--) {
      if (alpha[(bounds.top + y) * width + bounds.left + x] >= ALPHA_THRESHOLD) {
        lowest[x] = y
        break
      }
    }
  }

  return lowest
}

/**
 * Which columns actually stand on the floor, as a 0/255 mask one pixel tall.
 *
 * `tolerance` is how far above the product's lowest point a column may end and
 * still count as touching — a few pixels, because feet are rarely level in a
 * photograph. Everything higher (an apron, a seat rail, a sled base curving
 * away) is excluded, which is precisely what stops the shadow from becoming a
 * ghost of the whole chair.
 */
export function contactColumns(lowest: Int32Array, tolerance: number): Uint8Array {
  const mask = new Uint8Array(lowest.length)

  let bottom = -1
  for (const y of lowest) if (y > bottom) bottom = y
  if (bottom < 0) return mask

  for (let x = 0; x < lowest.length; x++) {
    if (lowest[x] >= 0 && bottom - lowest[x] <= tolerance) mask[x] = 255
  }
  return mask
}

export type ToneStats = {
  /** Median luminance of solid product pixels, 0-255. Underexposure shows here. */
  median: number
  /**
   * 98th percentile luminance — how close the brightest MATERIAL is to
   * clipping, and therefore how much exposure headroom exists.
   *
   * Not the 99th, and not the maximum. Almost every photograph of furniture has
   * a few specular pixels at 250+: a varnish highlight, a metal tip, a window
   * caught in a polished arm. Measured at the 99th percentile those pixels veto
   * the exposure correction for the whole product, and a dim workshop
   * photograph comes back exactly as flat as it went in. The 98th sits below
   * the specular tail and on the upholstery, which is what the correction is
   * actually protecting.
   */
  p98: number
  /** Kept for the log: the specular tail itself. */
  p99: number
  mean: number
  /** How many pixels the statistics were computed over. */
  samples: number
}

/** ITU-R BT.601 luma, the same weighting sharp uses for greyscale. */
export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/**
 * Luminance statistics over SOLID product pixels only.
 *
 * The alpha test is what makes this meaningful: a cut-out is mostly
 * transparent, and transparent pixels carry whatever RGB the provider left
 * behind. Including them would put the median somewhere near black and hand
 * every photograph the same large exposure correction — the "one aggressive
 * fixed filter" this is meant to avoid.
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
    const target = fraction * samples
    for (let l = 0; l < 256; l++) {
      seen += histogram[l]
      if (seen >= target) return l
    }
    return 255
  }

  return { median: at(0.5), p98: at(0.98), p99: at(0.99), mean: sum / samples, samples }
}

/**
 * How much fine detail the product carries, as the standard deviation of a
 * Laplacian over solid product pixels — the cane weave, the fabric grain, the
 * wood figure. Scale-free enough to compare one photograph against another.
 *
 * Used only to log, and to refuse a photograph so soft that no amount of
 * careful scaling would make it a catalogue image.
 */
export function detailScore(
  grey: Uint8Array | Buffer,
  alpha: Uint8Array | Buffer,
  width: number,
  height: number,
): number {
  let sum = 0, sumSq = 0, n = 0

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      // Only where the whole 4-neighbourhood is solid product: a Laplacian that
      // straddles the cut-out edge measures the edge, not the material.
      if (
        alpha[i] < ALPHA_OPAQUE || alpha[i - 1] < ALPHA_OPAQUE || alpha[i + 1] < ALPHA_OPAQUE ||
        alpha[i - width] < ALPHA_OPAQUE || alpha[i + width] < ALPHA_OPAQUE
      ) continue

      const lap = 4 * grey[i] - grey[i - 1] - grey[i + 1] - grey[i - width] - grey[i + width]
      sum += lap
      sumSq += lap * lap
      n++
    }
  }

  if (n < 64) return 0
  const mean = sum / n
  return Math.sqrt(Math.max(0, sumSq / n - mean * mean))
}

export type NeutralStats = {
  /** How many product pixels looked like they ought to be grey. */
  count: number
  /** Their average channels, or zeros when there were none. */
  r: number
  g: number
  b: number
  /** count as a fraction of the solid product pixels examined. */
  share: number
}

/**
 * The product's own near-neutral surfaces: white upholstery, chrome, a pale
 * cane, a painted foot.
 *
 * These are the only pixels that can tell you what colour the LIGHT was, which
 * is why the white balance is estimated from them and from nothing else. A
 * product with no such surface — a solid teak stool, a bolt of red fabric —
 * yields no samples, and the correction that reads this then declines to act
 * rather than dragging a genuinely warm object toward grey.
 */
export function neutralStats(rgba: Uint8Array | Buffer, pixels: number): NeutralStats {
  let count = 0, sumR = 0, sumG = 0, sumB = 0, examined = 0

  for (let i = 0; i < pixels; i++) {
    const o = i * 4
    if (rgba[o + 3] < ALPHA_OPAQUE) continue
    examined++

    const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2]
    const mean = (r + g + b) / 3
    // Mid-to-light only: shadows are noisy and unreliable, and anything at the
    // very top may be clipped and therefore already neutral by force.
    if (mean < 110 || mean > 242) continue
    // "Ought to be grey": the channels are close together relative to how bright
    // the pixel is. A cast tilts them all the same way, so this still catches a
    // white cushion under a blue-green workshop lamp.
    if (Math.max(r, g, b) - Math.min(r, g, b) > mean * 0.16) continue

    count++; sumR += r; sumG += g; sumB += b
  }

  if (count === 0) return { count: 0, r: 0, g: 0, b: 0, share: 0 }
  return {
    count,
    r: sumR / count, g: sumG / count, b: sumB / count,
    share: examined === 0 ? 0 : count / examined,
  }
}
