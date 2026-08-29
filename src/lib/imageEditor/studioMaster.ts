// How big the product is in the master, and the padding that makes it so.
//
// Pure arithmetic — no sharp, no provider — so every sizing decision can be
// tested exhaustively, including the awkward products.
//
// WHY PADDING AND NOT A PROMPT
// ----------------------------
// Two paid Product Shot results proved wording cannot hold a size: the first
// invented a circular backdrop, the second shrank the chair to about a fifth of
// the frame while the description asked for sixty-five percent. The accepted
// third result fixed the background, the lighting and the shadows, and left
// exactly one defect — the chair was still too small.
//
// So the size is no longer asked for. `placement_type: 'manual_padding'` takes
// the product's size as a fact and the surrounding space as pixels, which makes
// the framing arithmetic rather than a request. From Bria's own schema, quoted:
//
//   padding_values — "The desired padding in pixels around the product, when
//   using placement_type=manual_padding. The order of the values is
//   [left, right, top, bottom]. For optimal results, the total number of
//   pixels, including padding, should be around 1,000,000."
//
//   shot_size — "This parameter is only relevant when placement_type=automatic
//   or placement_type=manual_padding." … in fact `automatic` or
//   `manual_placement`; under manual_padding the canvas IS cutout + padding,
//   so shot_size is not sent and the numbers below decide the master.
//
// THE MASTER IS SQUARE, AND ONE SHAPE ONLY
// ----------------------------------------
// The product owner accepted the square master and asked for enough surrounding
// background to crop from later. So there is one canvas here, not a menu of
// three: landscape and portrait are a crop of this, made by a person who can
// see the picture, rather than three separate paid generations.

/** The master canvas.
 *
 *  1440 rather than 1000: the product is composited locally now, so there is no
 *  provider megapixel guidance to sit under, and a larger canvas is how the
 *  photograph's own resolution stops being thrown away. At 1000 a 1152px
 *  product was resampled down to 530 — 46% of its linear detail — before
 *  anything else happened to it. */
export const MASTER_WIDTH = 1440
export const MASTER_HEIGHT = 1440

/**
 * How much of the canvas height the product should fill.
 *
 * The product owner's number. The accepted result was correct in every respect
 * except that the chair was too small; 52-55% is the range they asked for and
 * 53% is the middle of it.
 */
export const PRODUCT_HEIGHT_SHARE = 0.53   // 763px of 1440

/** The range a finished master is judged against, not a range anything picks
 *  from — the target above is a single number on purpose. */
export const PRODUCT_HEIGHT_MIN = 0.52
export const PRODUCT_HEIGHT_MAX = 0.55

/**
 * Clear space kept at each side, as a share of the canvas width.
 *
 * This is the second limit, and it is what stops a long sideboard being cropped.
 * At 53% of the height a 3:1 product is 1590px wide on a 1000px canvas, so the
 * width has to be able to bind first.
 */
export const SIDE_MARGIN_SHARE = 0.06      // product may reach 88% of the width, 1267px

/**
 * How the leftover vertical space is split, above versus below.
 *
 * 0.6 is 21:14 — the proportion of the composition BOE approved before the
 * product height changed. Keeping the ratio keeps that balance while the extra
 * space freed by a smaller product goes to both sides, which is what leaves
 * room to crop.
 */
export const ABOVE_SHARE_OF_LEFTOVER = 0.6

/**
 * The most a cut-out may be enlarged to reach the target height.
 *
 * Enlarging invents nothing — it spreads the pixels the camera recorded over
 * more of them — and past a point that reads as softness. The 1440 master asks
 * for a 763px product where 1000 asked for 530, so the old 1.15 was re-measured
 * rather than carried over.
 *
 * Detail retained against a native-resolution render of the same product,
 * measured as mean absolute Laplacian over a subject with 1px spindles and a
 * cane lattice (test-results/enlargement/sweep.mts):
 *
 *     1.10x  85.2%      1.30x  77.7%   <- the cap
 *     1.15x  82.5%      1.50x  72.1%
 *     1.20x  80.8%      1.75x  63.3%   <- the cliff
 *     1.25x  78.6%      2.00x  57.3%
 *
 * THE CAP IS 1.30, AND IT IS CHOSEN FROM REAL SOURCE MATERIAL, NOT FROM THE
 * CURVE ALONE. BOE's product photographs are around 1000px, and the Irvine
 * chair used for acceptance testing cut out to 549 x 609. Reaching 763 from 609
 * is 1.253x, so a cap of 1.20 — or even 1.25 — would refuse the exact
 * photograph the approved result was built from. A gate that rejects the
 * reference subject is not a quality gate, it is a bug.
 *
 * 77.7% retention at 1.30x is a real cost and it is accepted knowingly. What
 * the cap still buys is the collapse beyond it: 1.75x keeps only 63%, and the
 * curve falls away fastest between 1.5 and 1.75. Severe enlargement is still
 * refused. Do not raise this above 1.30 — past it the gate stops protecting
 * anything and a soft catalogue image ships instead of an honest refusal.
 *
 * A product must be 588px tall in the cut-out to pass — the gate works from
 * the unrounded 763.2, not the placed 763.
 */
export const MAX_ENLARGEMENT = 1.30

export type CutoutSize = { width: number; height: number }

export type PaddingPlan = {
  /** What the cut-out is resized to before it is sent. */
  product: { width: number; height: number }
  /** The single factor applied to both axes. Never one per axis: a stretched
   *  chair is a different chair. */
  scale: number
  padding: { left: number; right: number; top: number; bottom: number }
  /** Exactly what goes in the request, in Bria's order. */
  paddingValues: [number, number, number, number]
  canvas: { width: number; height: number }
  /** What the product will measure as a share of the canvas height. */
  heightShare: number
  /** True when the width bound first, so the product is shorter than the target
   *  on purpose — a very wide piece, contained rather than cropped. */
  widthLimited: boolean
}

/**
 * The scale that fits this cut-out inside the master.
 *
 * The height is normally what binds — the product owner fixed the product's
 * height as a share of the canvas. A product much wider than it is tall is
 * limited by the width instead, and the smaller of the two wins. One number
 * either way, applied to both axes.
 */
export function fitScale(cutout: CutoutSize): number {
  return Math.min(
    (MASTER_HEIGHT * PRODUCT_HEIGHT_SHARE) / cutout.height,
    (MASTER_WIDTH * (1 - 2 * SIDE_MARGIN_SHARE)) / cutout.width,
  )
}

/**
 * The padding that puts this cut-out where it belongs on the master.
 *
 * Derived entirely from the cut-out's own width and height, so it is right for
 * a wardrobe and a footstool alike — there is no value in here that was tuned
 * against one chair.
 *
 * The two axes are worked out separately and both close exactly on the canvas:
 * left + product + right is the full width and top + product + bottom is the
 * full height, so the master is 1000 x 1000 whatever arrives.
 */
export function planPadding(cutout: CutoutSize): PaddingPlan {
  const scale = fitScale(cutout)

  const width = Math.max(1, Math.round(cutout.width * scale))
  const height = Math.max(1, Math.round(cutout.height * scale))

  // The remainder goes to the right rather than being rounded twice, so the two
  // sides differ by at most one pixel and the sum is exact.
  const left = Math.floor((MASTER_WIDTH - width) / 2)
  const right = MASTER_WIDTH - width - left

  const leftover = MASTER_HEIGHT - height
  const top = Math.round(leftover * ABOVE_SHARE_OF_LEFTOVER)
  const bottom = leftover - top

  return {
    product: { width, height },
    scale,
    padding: { left, right, top, bottom },
    // [left, right, top, bottom]. The order is Bria's, and getting it wrong
    // would silently move the product rather than fail.
    paddingValues: [left, right, top, bottom],
    canvas: { width: MASTER_WIDTH, height: MASTER_HEIGHT },
    heightShare: height / MASTER_HEIGHT,
    widthLimited: scale < (MASTER_HEIGHT * PRODUCT_HEIGHT_SHARE) / cutout.height,
  }
}

export type QualityVerdict =
  | { ok: true; scale: number }
  | { ok: false; scale: number; needed: number; message: string }

/**
 * Whether this cut-out can fill the master at an acceptable quality.
 *
 * Refusing is the feature: a soft catalogue image is worse than an honest
 * refusal, and `needed` is what makes the refusal actionable — the bounding-box
 * height the photograph would have had to have.
 */
export function checkEnlargement(cutout: CutoutSize, cap = MAX_ENLARGEMENT): QualityVerdict {
  const scale = fitScale(cutout)
  if (scale <= cap) return { ok: true, scale }

  return {
    ok: false,
    scale,
    needed: Math.ceil((cutout.height * scale) / cap),
    message:
      'The product is too small in this photograph to make a sharp catalogue image. ' +
      'Take the photograph closer to the product, or upload a higher-resolution photograph, and try again.',
  }
}
