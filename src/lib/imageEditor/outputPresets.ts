// The three shapes a studio image may come back in, and the composition BOE
// approved for each.
//
// These are the whole specification of the finished image. The provider does not
// see any of them: it is asked only to remove a background, and every number
// below is applied locally by composeStudioImage.ts. That is what makes the
// composition repeatable — the same photograph produces the same framing every
// time, because the framing is arithmetic rather than a request.
//
// The browser may name a preset. It may never supply a dimension: pixels come
// from this table and nowhere else.
//
// THE APPROVED REFERENCE
// ----------------------
// A 3:2 landscape whose product fills 65% of the canvas height, with 21% clear
// above and 14% below the lowest foot, horizontally centred. The other two
// shapes carry the same proportions, so a product looks the same size whichever
// canvas it lands on.
//
//   Landscape 3:2   1200 x 800    product 520px, top 168, feet 688, centre 600
//   Square    1:1   1000 x 1000   product 650px, top 210, feet 860, centre 500
//   Portrait  4:5    900 x 1125   product 731px, top 236, feet 968, centre 450
//
// A product much wider than it is tall is limited by the width instead, so that
// a sideboard is whole rather than exactly 65% tall and cut off at both ends.
// It still stands on the same baseline.

export const OUTPUT_PRESET_KEYS = ['landscape', 'square', 'portrait'] as const

export type OutputPresetKey = typeof OUTPUT_PRESET_KEYS[number]

/** The approved proportions, as fractions of the canvas height. */
export const PRODUCT_HEIGHT_SHARE = 0.65
export const SPACE_ABOVE_SHARE = 0.21
export const SPACE_BELOW_SHARE = 0.14

/**
 * The clear space kept at each side, as a fraction of the canvas width.
 *
 * The height shares above describe the reference chair, which is roughly as
 * tall as it is wide. A long sideboard is not: at 65% of the height a 3:1
 * product is wider than a landscape canvas, and it would be silently cropped by
 * the composite. This is the second constraint that stops that — the product is
 * scaled by whichever of the two limits binds first, so a wide product comes
 * back shorter than 65% and whole, rather than exactly 65% and clipped.
 */
export const SIDE_MARGIN_SHARE = 0.06

export type CompositionTarget = {
  /** Product bounding-box height, in pixels. */
  productHeight: number
  /** Top of the product, in pixels from the top edge. */
  productTop: number
  /** The lowest foot, in pixels from the top edge. */
  feetBaseline: number
  /** Where the product's horizontal centre belongs. */
  centreX: number
  /** The widest the product may be drawn, side margins respected. */
  maxProductWidth: number
}

export type OutputPreset = {
  key: OutputPresetKey
  /** What the employee sees. */
  label: string
  ratio: string
  /** The finished canvas, in pixels. */
  shotSize: readonly [number, number]
  target: CompositionTarget
}

/** The reference proportions applied to one canvas. */
function composition([width, height]: readonly [number, number]): CompositionTarget {
  return {
    productHeight: Math.round(height * PRODUCT_HEIGHT_SHARE),
    productTop:    Math.round(height * SPACE_ABOVE_SHARE),
    feetBaseline:  Math.round(height * (1 - SPACE_BELOW_SHARE)),
    centreX:       Math.round(width / 2),
    maxProductWidth: Math.round(width * (1 - 2 * SIDE_MARGIN_SHARE)),
  }
}

const SIZES = {
  // The approved reference shape, and therefore the default.
  landscape: [1200, 800] as const,
  square:    [1000, 1000] as const,
  portrait:  [900, 1125] as const,
}

export const OUTPUT_PRESETS: Record<OutputPresetKey, OutputPreset> = {
  landscape: { key: 'landscape', label: 'Landscape', ratio: '3:2', shotSize: SIZES.landscape, target: composition(SIZES.landscape) },
  square:    { key: 'square',    label: 'Square',    ratio: '1:1', shotSize: SIZES.square,    target: composition(SIZES.square) },
  portrait:  { key: 'portrait',  label: 'Portrait',  ratio: '4:5', shotSize: SIZES.portrait,  target: composition(SIZES.portrait) },
}

/** The shape BOE asks for unless somebody chooses otherwise: the one the
 *  approved reference photograph uses. */
export const DEFAULT_OUTPUT_PRESET: OutputPresetKey = 'landscape'

/**
 * Turn whatever arrived in the request into a preset.
 *
 * Fails closed to the default rather than throwing: an unrecognised value is a
 * caller sending something it should not, and the safe answer is the approved
 * shape, not a 500 — and never the value itself.
 */
export function resolveOutputPreset(value: unknown): OutputPreset {
  return OUTPUT_PRESETS[
    (OUTPUT_PRESET_KEYS as readonly string[]).includes(value as string)
      ? value as OutputPresetKey
      : DEFAULT_OUTPUT_PRESET
  ]
}
