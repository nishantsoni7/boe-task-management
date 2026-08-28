// Measuring a finished studio image against the approved composition.
//
// SERVER ONLY (sharp is a native module). Nothing in the request path uses this:
// it is how a result is CHECKED, by the smoke script and by tests, rather than
// how one is made.
//
// It exists because "the product looks about the right size" is not a review.
// The reference BOE approved is a set of numbers — sixty-five percent of the
// canvas height, twenty-one percent above, fourteen percent below the feet,
// centred — and a returned image either meets them or does not.
//
// HOW THE PRODUCT IS FOUND
// ------------------------
// The studio background is, by instruction, one continuous near-uniform light
// surface. So the product is what differs from it: the four corners give the
// background colour, and any pixel far enough from that colour is product.
//
// The shadow is the one complication. It differs from the background too, and
// counting it would put the "feet" below the feet and report a taller product
// than the photograph contains. It is excluded by CONTRAST: a feathered cast
// shadow darkens the background by a tenth or so, while furniture against a
// light sweep differs by several times that. The threshold sits between them.
//
// The limit of that, stated plainly: a very dark contact shadow immediately
// under a foot can cross the threshold and add a few pixels to the measured
// height. It cannot move the result far — contact shadows are at the feet by
// definition — but a measurement that reads one or two percent tall on a
// product with heavy grounding shadows is this, not the model.
//
// THE BIGGER LIMIT, AND IT MATTERS
// --------------------------------
// This assumes the background IS plain. Give it an image with a decorative
// backdrop — a circle, an arch, a panel — and it will measure the BACKDROP,
// because the backdrop is what differs from the corners. The numbers will look
// like a large, perfectly centred product.
//
// So these measurements answer "is the framing right", never "is the scene
// clean". A result still has to be looked at. What keeps a decorative backdrop
// away is now structural rather than hoped for — the background is drawn
// locally by composeStudioImage.ts and has nothing in it that could draw one —
// but this function would not be the thing to notice if that changed.

import sharp from 'sharp'

/** How far from the background colour a pixel must be, per channel on average,
 *  to count as product. Generous enough for a pale cane back against a light
 *  sweep, high enough that a feathered shadow does not qualify. */
const PRODUCT_DELTA = 30

/** A shadow is a soft tone over many pixels; product is dense. A row or column
 *  needs this share of its span to be product before it counts. */
const DENSITY_FLOOR = 0.004

export type Measurement = {
  canvas: { width: number; height: number }
  product: { left: number; top: number; right: number; bottom: number; width: number; height: number }
  /** Product height as a share of the canvas height. */
  heightShare: number
  /** Clear space above the product, as a share of the canvas height. */
  aboveShare: number
  /** Clear space below the lowest foot, as a share of the canvas height. */
  belowShare: number
  /** Where the feet sit, as a share of the canvas height from the top. */
  feetBaselineShare: number
  /** Product centre minus canvas centre, in pixels. Negative is left. */
  centreOffsetPx: number
  /** The narrower side margin divided by the wider one; 1 is perfectly even. */
  sideBalance: number
  /** True when the product touches any edge — i.e. it may be cropped. */
  touchesEdge: boolean
}

export type MeasureResult =
  | { ok: true; measurement: Measurement }
  | { ok: false; error: string }

export async function measureComposition(png: Buffer): Promise<MeasureResult> {
  let data: Buffer
  let width: number
  let height: number

  try {
    const raw = await sharp(png, { failOn: 'error' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    data = raw.data
    width = raw.info.width
    height = raw.info.height
  } catch {
    return { ok: false, error: 'That image could not be read.' }
  }

  if (!width || !height) return { ok: false, error: 'That image could not be read.' }

  const at = (x: number, y: number) => {
    const o = (y * width + x) * 3
    return [data[o], data[o + 1], data[o + 2]] as const
  }

  // The background, taken from the four corners: on a seamless studio sweep they
  // are background by definition, and averaging four resists one odd pixel.
  const corners = [at(2, 2), at(width - 3, 2), at(2, height - 3), at(width - 3, height - 3)]
  const bg = [0, 1, 2].map(c => corners.reduce((sum, p) => sum + p[c], 0) / corners.length)

  const columnCounts = new Uint32Array(width)
  const rowCounts = new Uint32Array(height)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = at(x, y)
      const delta = Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2])
      if (delta >= PRODUCT_DELTA * 3) {
        columnCounts[x]++
        rowCounts[y]++
      }
    }
  }

  const firstDense = (counts: Uint32Array, span: number) =>
    counts.findIndex(c => c >= Math.max(2, span * DENSITY_FLOOR))
  const lastDense = (counts: Uint32Array, span: number) => {
    for (let i = counts.length - 1; i >= 0; i--) {
      if (counts[i] >= Math.max(2, span * DENSITY_FLOOR)) return i
    }
    return -1
  }

  const top = firstDense(rowCounts, width)
  const bottom = lastDense(rowCounts, width)
  const left = firstDense(columnCounts, height)
  const right = lastDense(columnCounts, height)

  if (top < 0 || bottom < 0 || left < 0 || right < 0) {
    return { ok: false, error: 'No product could be found against the background.' }
  }

  const productWidth = right - left + 1
  const productHeight = bottom - top + 1
  const leftMargin = left
  const rightMargin = width - 1 - right

  return {
    ok: true,
    measurement: {
      canvas: { width, height },
      product: { left, top, right, bottom, width: productWidth, height: productHeight },
      heightShare: productHeight / height,
      aboveShare: top / height,
      belowShare: (height - 1 - bottom) / height,
      feetBaselineShare: bottom / height,
      centreOffsetPx: (left + right) / 2 - (width - 1) / 2,
      sideBalance: Math.max(leftMargin, rightMargin) === 0
        ? 1
        : Math.min(leftMargin, rightMargin) / Math.max(leftMargin, rightMargin),
      touchesEdge: top === 0 || left === 0 || bottom === height - 1 || right === width - 1,
    },
  }
}

/** One line per measurement, for the smoke script and the log. */
export function describeMeasurement(m: Measurement): string[] {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`
  return [
    `canvas            ${m.canvas.width} x ${m.canvas.height}`,
    `product box       ${m.product.width} x ${m.product.height} px at (${m.product.left}, ${m.product.top})`,
    `product height    ${m.product.height} px, ${pct(m.heightShare)} of the canvas   [target 65%]`,
    `space above       ${m.product.top} px, ${pct(m.aboveShare)}                     [target 21%]`,
    `space below feet  ${m.canvas.height - 1 - m.product.bottom} px, ${pct(m.belowShare)}   [target 14%]`,
    `feet baseline     ${m.product.bottom} px, ${pct(m.feetBaselineShare)} down       [target 86%]`,
    `centre offset     ${m.centreOffsetPx.toFixed(1)} px from centre                  [target 0]`,
    `side balance      ${m.sideBalance.toFixed(2)} (1.00 is even)`,
    `touches an edge   ${m.touchesEdge ? 'YES — the product may be cropped' : 'no'}`,
  ]
}
