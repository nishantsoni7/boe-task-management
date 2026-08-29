// Where the product is in a cut-out, and where it meets the floor.
//
// Two jobs, both reading raw alpha and neither writing it: the product's
// bounding box, and the underside the shadows are drawn from. That box is
// what the whole framing is computed from — `padding_values` is measured in
// pixels around the product, so the product's real size is the input to
// studioMaster.ts, and getting this box wrong moves the chair.
//
// Pure, so the awkward cases — a two-pixel leg, a stray speck of segmentation
// noise, a soft edge — are testable without sharp, a provider or a browser.

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
