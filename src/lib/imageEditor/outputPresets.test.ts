/**
 * The three output shapes, and the one rule that matters about them: pixels are
 * decided here, never by the caller.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/outputPresets.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  OUTPUT_PRESETS, OUTPUT_PRESET_KEYS, DEFAULT_OUTPUT_PRESET, resolveOutputPreset,
} from './outputPresets'

describe('the presets', () => {
  test('there are exactly three, and Square is the default', () => {
    assert.deepEqual([...OUTPUT_PRESET_KEYS], ['square', 'portrait', 'landscape'])
    assert.equal(DEFAULT_OUTPUT_PRESET, 'square')
  })

  test('each is its stated ratio, exactly', () => {
    const ratio = ([w, h]: readonly [number, number]) => w / h
    assert.equal(ratio(OUTPUT_PRESETS.square.shotSize), 1)
    assert.equal(ratio(OUTPUT_PRESETS.portrait.shotSize), 4 / 5)
    assert.equal(ratio(OUTPUT_PRESETS.landscape.shotSize), 3 / 2)
  })

  test('each sits near one megapixel, which is what Bria asks for', () => {
    for (const preset of Object.values(OUTPUT_PRESETS)) {
      const pixels = preset.shotSize[0] * preset.shotSize[1]
      assert.ok(pixels > 900_000 && pixels < 1_100_000,
        `${preset.key} is ${pixels} pixels, outside Bria's ~1 MP guidance`)
    }
  })

  test('every dimension is a whole number of pixels', () => {
    for (const preset of Object.values(OUTPUT_PRESETS)) {
      for (const side of preset.shotSize) {
        assert.equal(Number.isInteger(side), true, `${preset.key}: ${side}`)
        assert.ok(side >= 512 && side <= 2048, `${preset.key}: ${side} is an implausible side`)
      }
    }
  })

  test('Square is unchanged from what the integration already sent', () => {
    // The one shape the fixed settings have always used. Changing it silently
    // would change every existing result's framing.
    assert.deepEqual([...OUTPUT_PRESETS.square.shotSize], [1000, 1000])
  })
})

describe('resolving what the caller sent', () => {
  test('a known key resolves to its own preset', () => {
    for (const key of OUTPUT_PRESET_KEYS) {
      assert.equal(resolveOutputPreset(key).key, key)
    }
  })

  test('anything else falls back to Square rather than reaching the provider', () => {
    // A caller sending numbers is the case this exists for: `shot_size` decides
    // what Bria renders, and a route that took dimensions from a form would let
    // somebody ask for a very large image on BOE's account.
    for (const bad of [
      undefined, null, '', 'SQUARE', 'panorama', 42, [4000, 4000], { key: 'square' },
      '[4000,4000]', 'square; drop', true,
    ]) {
      const resolved = resolveOutputPreset(bad)
      assert.equal(resolved.key, 'square', `${JSON.stringify(bad)} must not be honoured`)
      assert.deepEqual([...resolved.shotSize], [1000, 1000])
    }
  })

  test('the resolved preset is one of the table entries, not a fresh object', () => {
    assert.equal(resolveOutputPreset('portrait'), OUTPUT_PRESETS.portrait)
  })
})
