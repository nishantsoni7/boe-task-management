// The three shapes a studio image may come back in, and the composition BOE
// approved for each.
//
// The browser never sends dimensions — it sends a preset KEY, and this table is
// the only place a key becomes pixels. That is the whole point: `shot_size` is
// a provider field that decides what Bria renders, and a route that accepted
// numbers from a form would let a caller ask for a 40-megapixel shot on BOE's
// account.
//
// ─── PLACEMENT: WHAT THE SCHEMA ACTUALLY ALLOWS ──────────────────────────────
//
// Read from @fal-ai/client 1.10.1's ProductShotInput, verbatim:
//
//   placement_type   'original' | 'automatic' | 'manual_placement' | 'manual_padding'
//                    "Selecting 'manual_padding' will allow you to control the
//                    position and size of the image by defining the desired
//                    padding in pixels around the product."
//
//   padding_values   "The desired padding in pixels around the product, when
//                    using placement_type=manual_padding. The order of the
//                    values is [left, right, top, bottom]. For optimal results,
//                    the total number of pixels, including padding, should be
//                    around 1,000,000. It is recommended to FIRST USE THE
//                    PRODUCT CUTOUT API, get the cutout and understand the size
//                    of the result, and then define the required padding and use
//                    the cutout as an input for this API."
//
//   shot_size        "only relevant when placement_type=automatic or
//                    placement_type=manual_placement"
//
// So, established rather than assumed:
//
//   * padding is in PIXELS, ordered [left, right, top, bottom];
//   * padding is measured around the PRODUCT CUTOUT, not within a canvas;
//   * with manual_padding the canvas is cutout + padding, and `shot_size` is
//     ignored — the two are alternatives, never a pair;
//   * the useful range is whatever keeps cutout + padding near 1 MP.
//
// WHY THIS MODULE STILL USES manual_placement
// -------------------------------------------
// Padding can only be computed from the cutout's pixel height and width, and
// BOE does not have them: the source is an unsegmented factory photograph, and
// Bria's own recommendation is to call its separate product-cutout API first.
// That is a second billable request per image, against a rule that one source
// image is one provider request. manual_padding is therefore deterministic in
// principle and unusable in one call, so `shot_size` fixes the CANVAS here and
// the scene description asks for the occupancy inside it.
//
// UNDETERMINED, and not guessed: whether padding is applied before or after the
// background is generated. The endpoint types do not say, and fal's own
// documentation could not be reached from this environment (its hosts are
// refused by the egress policy). It does not affect the choice above, because
// the blocker is the missing cutout size either way.
//
// COMPOSITION
// -----------
// The targets below are the approved reference, which is a 3:2 landscape. The
// same proportions are carried to the other two shapes so a product looks the
// same size whichever canvas it lands on. They are what the scene description
// asks for and what `measureComposition` checks a returned image against; they
// are NOT enforced by a provider setting, for the reason above.

export const OUTPUT_PRESET_KEYS = ['landscape', 'square', 'portrait'] as const

export type OutputPresetKey = typeof OUTPUT_PRESET_KEYS[number]

/** The approved proportions, as fractions of the canvas height. */
export const PRODUCT_HEIGHT_SHARE = 0.65
export const SPACE_ABOVE_SHARE = 0.21
export const SPACE_BELOW_SHARE = 0.14

export type CompositionTarget = {
  /** Product bounding-box height, in pixels. */
  productHeight: number
  /** Top of the product, in pixels from the top edge. */
  productTop: number
  /** The lowest foot, in pixels from the top edge. */
  feetBaseline: number
  /** Where the product's horizontal centre belongs. */
  centreX: number
}

export type OutputPreset = {
  key: OutputPresetKey
  /** What the employee sees. */
  label: string
  ratio: string
  /** Exactly what is sent as `shot_size`. */
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
