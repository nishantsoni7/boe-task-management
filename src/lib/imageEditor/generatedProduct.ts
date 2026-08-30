// Finding and framing a product inside a GENERATED, fully opaque image.
//
// SERVER ONLY (sharp). Nothing here is generative; it only measures and crops.
//
// WHY NOT COLOUR
// --------------
// The obvious way to find a product on a studio sweep is to sample the corners
// and call everything unlike them product. That was tried and it is wrong: a
// real sweep runs from about 148 in the corners to 214 on the floor, so most of
// the background differs from the corners by more than any workable threshold.
// It reported a known 53.0% placement as 71.8% — it was measuring the gradient.
//
// So the product is found by STRUCTURE instead. A studio sweep is smooth by
// construction and a shadow is smoother still; furniture has edges. A gradient
// magnitude separates them without caring what colour anything is, which also
// means a background change cannot move the answer and a soft shadow is not
// mistaken for a leg.
//
// WHAT THE TRANSITION COUNT IS FOR
// --------------------------------
// Scanning one row and counting how many times it crosses an edge measures how
// much separate vertical structure is there. A fan of seventeen spindles gives
// tens of crossings; the same fan rendered as one opaque block gives two. That
// number, compared between the uploaded photograph and the generated one, is
// the closest thing to a preservation check available without a segmentation
// mask — and it is exactly the failure that has to be caught.

import sharp from 'sharp'

/** Gradient magnitude below this is smooth: sweep, shadow, or flat surface. */
export const EDGE_THRESHOLD = 18

/** A row or column needs this many edge pixels to count as product. Keeps a
 *  stray compression artefact from defining an edge of the box. */
export const MIN_EDGE_PIXELS = 6

export type Bounds = { left: number; top: number; right: number; bottom: number; width: number; height: number }

export type Decoded = { gray: Uint8Array; width: number; height: number }

/** Greyscale, one byte per pixel. */
export async function decodeGrey(png: Buffer): Promise<Decoded> {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true })
  return { gray: new Uint8Array(data.buffer, data.byteOffset, info.width * info.height), width: info.width, height: info.height }
}

/**
 * Sobel gradient magnitude.
 *
 * The whole point of the module: it responds to edges and ignores level, so a
 * background gradient of sixty levels across the frame contributes almost
 * nothing while a chair leg contributes a great deal.
 */
export function edgeMap(d: Decoded): Uint8Array {
  const { gray, width, height } = d
  const out = new Uint8Array(width * height)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const tl = gray[i - width - 1], t = gray[i - width], tr = gray[i - width + 1]
      const l = gray[i - 1], r = gray[i + 1]
      const bl = gray[i + width - 1], b = gray[i + width], br = gray[i + width + 1]
      const gx = (tr + 2 * r + br) - (tl + 2 * l + bl)
      const gy = (bl + 2 * b + br) - (tl + 2 * t + tr)
      out[i] = Math.min(255, Math.round(Math.hypot(gx, gy) / 4))
    }
  }
  return out
}

/**
 * Where the product is, by structure.
 *
 * Scans rows and columns for edge density and takes the first and last that
 * carry enough to be furniture. A soft cast shadow has almost no gradient, so
 * it is not counted — which is what keeps the measured height from running down
 * into the shadow and reporting a taller product than the picture contains.
 */
export function locateProduct(d: Decoded, edges: Uint8Array): Bounds | null {
  const { width, height } = d
  const rows = new Uint32Array(height)
  const cols = new Uint32Array(width)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (edges[y * width + x] < EDGE_THRESHOLD) continue
      rows[y]++
      cols[x]++
    }
  }

  const first = (c: Uint32Array) => c.findIndex(v => v >= MIN_EDGE_PIXELS)
  const last = (c: Uint32Array) => { for (let i = c.length - 1; i >= 0; i--) if (c[i] >= MIN_EDGE_PIXELS) return i; return -1 }

  const top = first(rows), bottom = last(rows), left = first(cols), right = last(cols)
  if (top < 0 || bottom < 0 || left < 0 || right < 0) return null
  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 }
}

/** Locate in one call. */
export async function findProduct(png: Buffer): Promise<{ bounds: Bounds; decoded: Decoded; edges: Uint8Array } | null> {
  const decoded = await decodeGrey(png)
  const edges = edgeMap(decoded)
  const bounds = locateProduct(decoded, edges)
  return bounds ? { bounds, decoded, edges } : null
}

/**
 * How much separate vertical structure a horizontal band contains.
 *
 * Counted as edge crossings per scanline, averaged over the band and
 * normalised by the band's width so two images at different scales compare.
 * A fan of spindles scores high; the same fan rendered as one block scores
 * almost nothing.
 */
export function structureDensity(
  d: Decoded, edges: Uint8Array, bounds: Bounds, fromShare: number, toShare: number,
): number {
  const { width } = d
  const y0 = bounds.top + Math.round(bounds.height * fromShare)
  const y1 = bounds.top + Math.round(bounds.height * toShare)
  if (y1 <= y0) return 0

  let crossings = 0
  let rows = 0
  for (let y = y0; y < y1; y++) {
    let inEdge = false
    for (let x = bounds.left; x <= bounds.right; x++) {
      const on = edges[y * width + x] >= EDGE_THRESHOLD
      if (on && !inEdge) crossings++
      inEdge = on
    }
    rows++
  }
  return rows === 0 ? 0 : crossings / rows / (bounds.width / 1000)
}

// ─── Reframing ────────────────────────────────────────────────────────────────

export type ReframePlan = {
  /** The square crop taken from the generated image. */
  crop: { left: number; top: number; size: number }
  /** Where the product sits inside that crop. */
  productHeightShare: number
  /** True when the crop had to be widened past the ideal to keep the product
   *  whole — a very wide piece. */
  widthLimited: boolean
  /** True when the ideal crop would have left the canvas and was pulled back in. */
  clamped: boolean
}

/**
 * The square to cut out of the generated image so the product fills the target
 * share of it.
 *
 * The arithmetic is the inverse of the placement plan: if the product is to be
 * `share` of the crop's height, the crop is `productHeight / share` on a side.
 * It is then positioned so the product is horizontally centred and the leftover
 * vertical space splits 60:40 above and below.
 *
 * Nothing is ever cropped OFF the product: the crop is grown until it contains
 * the whole bounding box, and pulled back inside the canvas if it would leave
 * it. Both adjustments are reported rather than hidden, because either means
 * the framing is not the ideal one.
 */
export function planReframe(
  bounds: Bounds,
  canvas: { width: number; height: number },
  target: { heightShare: number; aboveSplit: number; maxWidthShare: number },
): ReframePlan {
  const bySide = bounds.height / target.heightShare
  const byWidth = bounds.width / target.maxWidthShare

  const widthLimited = byWidth > bySide
  // Never smaller than the product itself, never larger than the canvas.
  let size = Math.min(canvas.width, canvas.height, Math.ceil(Math.max(bySide, byWidth)))
  size = Math.max(size, bounds.width, bounds.height)

  const centreX = bounds.left + bounds.width / 2
  let left = Math.round(centreX - size / 2)

  const leftover = size - bounds.height
  let top = bounds.top - Math.round(leftover * target.aboveSplit)

  const before = { left, top }
  left = Math.max(0, Math.min(canvas.width - size, left))
  top = Math.max(0, Math.min(canvas.height - size, top))

  return {
    crop: { left, top, size },
    productHeightShare: bounds.height / size,
    widthLimited,
    clamped: left !== before.left || top !== before.top,
  }
}

/** Cut the planned square out. No resize, no resample: the Product Shot pixels
 *  and its own shadows are carried through unchanged. */
export async function reframe(png: Buffer, plan: ReframePlan): Promise<Buffer> {
  return sharp(png)
    .extract({ left: plan.crop.left, top: plan.crop.top, width: plan.crop.size, height: plan.crop.size })
    .png()
    .toBuffer()
}
