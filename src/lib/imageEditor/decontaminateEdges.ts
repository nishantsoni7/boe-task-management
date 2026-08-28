// Taking the factory background's colour out of the cut-out's soft edge,
// without touching its shape.
//
// SERVER ONLY (sharp is a native module).
//
// THE DEFECT THIS FIXES
// ---------------------
// Background removal assigns alpha; it does not repaint. So at an antialiased
// boundary the stored RGB is still the PHOTOGRAPH's pixel — which is already a
// mix of product and whatever was behind it — while alpha merely says how much
// of that pixel the product covers.
//
// Composited onto a light studio sweep, that mix reads as a thin dark rim: the
// pixel carries a share of dark factory background it should not have. Measured
// on a pale product over a dark background, a boundary pixel at alpha 163 came
// out 20.6 levels darker than the same coverage of clean product would. At 100%
// zoom that is the jagged fringe on rails, spindles, seat perimeters and the
// outside of legs.
//
// It is invisible in the browser preview because the preview is scaled down and
// averages the rim away. It is a one-pixel defect, and one pixel is exactly what
// a 1000 x 1000 catalogue master is inspected at.
//
// WHAT THIS IS ALLOWED TO CHANGE
// ------------------------------
// The RGB of partly transparent pixels. Nothing else:
//
//   * ALPHA IS NEVER WRITTEN. The silhouette that arrives is the silhouette
//     that leaves — no erosion, no choke, no shrink. On furniture the usual
//     "fix" of eating a pixel into the alpha means thinning the cane, the
//     spindles and the metal tips, which is the one thing that must not happen.
//   * fully opaque pixels are never written, so the product's interior, its
//     wood grain and any watermark are byte-identical.
//   * fully transparent pixels are never written, so the gaps between legs stay
//     gaps.
//   * nothing is blurred, sharpened, moved or resampled here. This only
//     recolours pixels in place.
//
// HOW THE REPLACEMENT COLOUR IS FOUND
// -----------------------------------
// From the product itself, just inside the edge. A blurred copy of the SOLID
// pixels' colour, divided by a blurred copy of the solid MASK, is a normalised
// average of nearby opaque product colour — the colour that boundary pixel
// would have had if the camera had seen only product through it.
//
// Only solid pixels donate. Including the rim in its own replacement would
// average the contamination back in and leave the rim visibly wrong, which is
// the trap this shape of algorithm exists to avoid.

import sharp from 'sharp'

/**
 * At or above this alpha a pixel is the product proper: never rewritten, and
 * the only kind that donates colour.
 *
 * High on purpose. 250 rather than, say, 200 means a nearly-opaque pixel is
 * treated as product rather than as edge, so the interior is left alone and the
 * donor pool is uncontaminated.
 */
export const SOLID_ALPHA = 250

/** How far to reach for product colour. Three pixels covers the one-to-three
 *  pixel soft edge segmentation produces without reaching across a leg. */
export const DONOR_SIGMA = 3

/**
 * Below this much solid product within reach, no replacement is made.
 *
 * This is what protects a thin structure. A one-pixel spindle that is
 * semi-transparent along its whole width has almost no opaque neighbour to
 * borrow from, and a colour guessed from nothing would be worse than the
 * contamination. Such a pixel is left exactly as it arrived.
 */
export const MIN_DONOR_WEIGHT = 4

export type EdgeReport = {
  /** Pixels whose RGB was replaced. */
  repaired: number
  /** Partly transparent pixels with too little product nearby to repair. */
  skippedThin: number
  /** Fully opaque pixels — never touched. */
  solid: number
  /** Fully transparent pixels — never touched. */
  empty: number
}

/**
 * Blur a one-channel mask and get one channel back.
 *
 * sharp reads a raw single-channel buffer as sRGB and returns THREE channels
 * unless told otherwise, so `mask[i]` afterwards would be the red channel of
 * pixel i/3 — a mask silently sampled from the wrong pixels. This exact trap
 * once made an earlier version of this function quietly stop working.
 */
async function blurMask(mask: Buffer, width: number, height: number, sigma: number): Promise<Buffer> {
  return sharp(mask, { raw: { width, height, channels: 1 } })
    .blur(sigma)
    .toColourspace('b-w')
    .raw()
    .toBuffer()
}

/**
 * Replace the contaminated colour of boundary pixels, in place.
 *
 * `rgba` is modified directly and its alpha channel is read but never written.
 */
export async function decontaminateEdges(
  rgba: Buffer,
  width: number,
  height: number,
): Promise<EdgeReport> {
  const pixels = width * height

  // The donor pool: colour where the product is solid, nothing anywhere else.
  const donorColour = Buffer.alloc(pixels * 3)
  const donorMask = Buffer.alloc(pixels)

  const report: EdgeReport = { repaired: 0, skippedThin: 0, solid: 0, empty: 0 }

  for (let i = 0; i < pixels; i++) {
    const o = i * 4
    if (rgba[o + 3] < SOLID_ALPHA) continue
    report.solid++
    donorMask[i] = 255
    donorColour[i * 3]     = rgba[o]
    donorColour[i * 3 + 1] = rgba[o + 1]
    donorColour[i * 3 + 2] = rgba[o + 2]
  }

  // Nothing solid anywhere: there is no product colour to borrow, so there is
  // nothing safe to do. Returned untouched rather than guessed at.
  if (report.solid === 0) {
    for (let i = 0; i < pixels; i++) if (rgba[i * 4 + 3] === 0) report.empty++
    report.skippedThin = pixels - report.solid - report.empty
    return report
  }

  const blurredColour = await sharp(donorColour, { raw: { width, height, channels: 3 } })
    .blur(DONOR_SIGMA).raw().toBuffer()
  const blurredMask = await blurMask(donorMask, width, height, DONOR_SIGMA)

  for (let i = 0; i < pixels; i++) {
    const o = i * 4
    const a = rgba[o + 3]

    if (a >= SOLID_ALPHA) continue          // the product proper: untouched
    if (a === 0) { report.empty++; continue } // a gap between the legs: untouched

    const weight = blurredMask[i]
    if (weight < MIN_DONOR_WEIGHT) { report.skippedThin++; continue }

    // The colour this pixel would have had if the camera had seen only product
    // through it. Applied in full: a partly covered pixel IS the product seen
    // through part of a pixel, so its colour should be the product's and its
    // ALPHA is what mixes it with whatever it is composited onto. Leaving any
    // share of the old colour in is leaving a share of the fringe in.
    for (let c = 0; c < 3; c++) {
      rgba[o + c] = Math.min(255, Math.round((blurredColour[i * 3 + c] * 255) / weight))
    }
    report.repaired++
  }

  return report
}
