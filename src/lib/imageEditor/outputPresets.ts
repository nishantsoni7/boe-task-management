// The three shapes a studio image may come back in.
//
// The browser never sends dimensions — it sends a preset KEY, and this table is
// the only place a key becomes pixels. That is the whole point: `shot_size` is
// a provider field that decides what Bria renders, and a route that accepted
// numbers from a form would let a caller ask for a 40-megapixel shot on BOE's
// account.
//
// SCHEMA
// ------
// `shot_size?: Array<number>` on Bria's ProductShotInput, read from
// @fal-ai/client 1.10.1's endpoint types: "The desired size of the final
// product shot. For optimal results, the total number of pixels should be
// around 1,000,000. This parameter is only relevant when
// placement_type=automatic or placement_type=manual_placement." BOE uses
// manual_placement, so the field applies.
//
// Every preset below is an exact ratio in round numbers at roughly one
// megapixel, which is what that guidance asks for. Occupancy does not need to
// change with the shape: the scene description states the product's height as a
// fraction of the IMAGE height, so a taller canvas gives a taller product
// rather than a smaller one.

export const OUTPUT_PRESET_KEYS = ['square', 'portrait', 'landscape'] as const

export type OutputPresetKey = typeof OUTPUT_PRESET_KEYS[number]

export type OutputPreset = {
  key: OutputPresetKey
  /** What the employee sees. */
  label: string
  ratio: string
  /** Exactly what is sent as `shot_size`. */
  shotSize: readonly [number, number]
}

export const OUTPUT_PRESETS: Record<OutputPresetKey, OutputPreset> = {
  square:    { key: 'square',    label: 'Square',    ratio: '1:1', shotSize: [1000, 1000] },
  portrait:  { key: 'portrait',  label: 'Portrait',  ratio: '4:5', shotSize: [900, 1125] },
  landscape: { key: 'landscape', label: 'Landscape', ratio: '3:2', shotSize: [1200, 800] },
}

/** The shape BOE asks for unless somebody chooses otherwise. */
export const DEFAULT_OUTPUT_PRESET: OutputPresetKey = 'square'

/**
 * Turn whatever arrived in the request into a preset.
 *
 * Fails closed to Square rather than throwing: an unrecognised value is a
 * caller sending something it should not, and the safe answer is the default
 * shape, not a 500 — and never the value itself.
 */
export function resolveOutputPreset(value: unknown): OutputPreset {
  return OUTPUT_PRESETS[
    (OUTPUT_PRESET_KEYS as readonly string[]).includes(value as string)
      ? value as OutputPresetKey
      : DEFAULT_OUTPUT_PRESET
  ]
}
