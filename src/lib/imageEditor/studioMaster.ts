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
 *  1440 rather than 1000: at 1000 a 1152px product was resampled down to 530 —
 *  46% of its linear detail — before anything else happened to it. */
export const MASTER_WIDTH = 1440
export const MASTER_HEIGHT = 1440

/**
 * The master is SQUARE, and the delivery path depends on it.
 *
 * `normaliseSquare` takes one side, refuses a non-square result outright, and
 * resizes anything else to that side. If these two constants ever diverged,
 * that path would quietly deliver a square where a rectangle was intended, and
 * nothing at runtime would notice. So the equality is asserted at compile time:
 * change one without the other and the build fails here rather than in a
 * catalogue.
 */
type AssertEqual<A extends number, B extends A> = B
export type MasterIsSquare = AssertEqual<typeof MASTER_WIDTH, typeof MASTER_HEIGHT>

/** The master's side. The one number the delivery path needs. */
export const MASTER_SIDE: typeof MASTER_WIDTH = MASTER_WIDTH

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
