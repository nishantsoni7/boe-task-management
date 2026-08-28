// Where the product is in a cut-out, and whether it can fill the frame without
// being blurred to do it.
//
// Pure functions over raw alpha, so every placement decision can be tested
// without sharp, without a provider and without a browser.

/**
 * A pixel counts as product at or above this alpha.
 *
 * Low on purpose. A segmented edge is soft, cane is a lattice of half-covered
 * pixels, and a metal tip may be two pixels wide — a high threshold would trim
 * exactly the details that must survive. The noise this lets in is handled by
 * the density rule below, not by raising the threshold.
 */
export const ALPHA_THRESHOLD = 8

/**
 * A row or column must hold at least this many product pixels to define an
 * edge of the bounding box.
 *
 * This is what "meaningful alpha, not a single noisy pixel" means: a stray
 * speck left behind by segmentation is one pixel in its row, while the thinnest
 * real leg is several down its column. Deliberately small — three pixels, not
 * a percentage — because a percentage of a large canvas would discard a
 * genuinely thin chair leg.
 */
export const MIN_EDGE_PIXELS = 3

export type Bounds = { left: number; top: number; right: number; bottom: number; width: number; height: number }

/**
 * The tight bounding box of the product.
 *
 * Scans rows and columns separately and takes the first and last that carry
 * enough product to be structure. Nothing is eroded and no alpha is modified:
 * this only reads.
 */
export function alphaBounds(
  alpha: Uint8Array | Buffer,
  width: number,
  height: number,
): Bounds | null {
  const rowCounts = new Uint32Array(height)
  const columnCounts = new Uint32Array(width)

  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      if (alpha[row + x] < ALPHA_THRESHOLD) continue
      rowCounts[y]++
      columnCounts[x]++
    }
  }

  const first = (counts: Uint32Array) => counts.findIndex(c => c >= MIN_EDGE_PIXELS)
  const last = (counts: Uint32Array) => {
    for (let i = counts.length - 1; i >= 0; i--) if (counts[i] >= MIN_EDGE_PIXELS) return i
    return -1
  }

  const top = first(rowCounts)
  const bottom = last(rowCounts)
  const left = first(columnCounts)
  const right = last(columnCounts)

  if (top < 0 || bottom < 0 || left < 0 || right < 0) return null

  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 }
}

/**
 * The lowest product pixel in each column, relative to the bounds.
 *
 * This is what a contact shadow is drawn from: the underside of the product,
 * column by column, so four feet cast four shadows with floor between them
 * rather than one oval under the whole chair.
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
 * Which columns stand on the floor.
 *
 * `rise` is how far above the product's lowest point a column may end and still
 * count as touching. Generous, because in a three-quarter view the back feet
 * sit visibly higher in the frame than the front ones while resting on the same
 * floor; anything well above it — a seat rail, an apron, a stretcher — is
 * excluded, which is what keeps this a contact shadow rather than a silhouette.
 */
export function contactColumns(lowest: Int32Array, rise: number): Uint8Array {
  const mask = new Uint8Array(lowest.length)

  let floor = -1
  for (const y of lowest) if (y > floor) floor = y
  if (floor < 0) return mask

  for (let x = 0; x < lowest.length; x++) {
    if (lowest[x] >= 0 && floor - lowest[x] <= rise) mask[x] = 255
  }
  return mask
}

export type PlacementPlan = {
  /** What the product is scaled by to reach the preset's height. */
  scale: number
  /** The product's size after scaling. */
  width: number
  height: number
  /** Where it is composited on the canvas. */
  left: number
  top: number
}

export type PlacementTarget = {
  productHeight: number
  feetBaseline: number
  centreX: number
  maxProductWidth: number
}

/**
 * The scale that fits this product inside the preset's targets.
 *
 * The height is normally what is matched — the reference fixes the product's
 * height as a share of the canvas. But a long sideboard at 65% of the height is
 * wider than the canvas, so the width is a second limit and the smaller of the
 * two wins. One number either way, applied to both axes, which is why nothing
 * here can stretch anything.
 */
export function fitScale(
  bounds: Pick<Bounds, 'width' | 'height'>,
  target: Pick<PlacementTarget, 'productHeight' | 'maxProductWidth'>,
): number {
  return Math.min(
    target.productHeight / bounds.height,
    target.maxProductWidth / bounds.width,
  )
}

/**
 * Where the product goes, given its bounding box and the preset's targets.
 *
 * Anchored on the FEET, not the top edge. For the ordinary product the two are
 * the same thing — 21% above plus 65% of height lands exactly on the 86%
 * baseline — but for a width-limited product they are not, and a product that
 * keeps its clear space above while floating off the floor looks wrong in a way
 * a shorter one does not.
 */
export function planPlacement(
  bounds: Pick<Bounds, 'width' | 'height'>,
  target: PlacementTarget,
): PlacementPlan {
  const scale = fitScale(bounds, target)
  const width = Math.max(1, Math.round(bounds.width * scale))
  const height = Math.max(1, Math.round(bounds.height * scale))

  return {
    scale,
    width,
    height,
    left: Math.round(target.centreX - width / 2),
    top: target.feetBaseline - height,
  }
}

/**
 * The most a product may be enlarged.
 *
 * A cut-out smaller than the frame has to be scaled up, and scaling up invents
 * nothing — it only spreads the pixels the camera recorded over more of them.
 * Past a small factor that is visible as softness, and a soft catalogue image
 * is worse than an honest refusal.
 */
export const MAX_ENLARGEMENT = 1.15

export type QualityVerdict =
  | { ok: true; scale: number }
  | { ok: false; scale: number; needed: number; message: string }

/**
 * Whether this cut-out can fill the frame at an acceptable quality.
 *
 * Refusing is the feature. `needed` is the bounding-box height the photograph
 * would have to have had, which is what makes the message actionable: take the
 * photograph closer.
 */
export function checkEnlargement(
  bounds: Pick<Bounds, 'width' | 'height'>,
  target: Pick<PlacementTarget, 'productHeight' | 'maxProductWidth'>,
  cap = MAX_ENLARGEMENT,
): QualityVerdict {
  // The scale that will actually be used, so a wide product is judged on the
  // enlargement it really gets rather than on the one the height alone implies.
  const scale = fitScale(bounds, target)
  if (scale <= cap) return { ok: true, scale }

  return {
    ok: false,
    scale,
    needed: Math.ceil((bounds.height * scale) / cap),
    message:
      'The product is too small in this photograph to make a sharp catalogue image. ' +
      'Take the photograph closer to the product, or upload a higher-resolution photograph, and try again.',
  }
}
