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
  PRODUCT_HEIGHT_SHARE, SPACE_ABOVE_SHARE, SPACE_BELOW_SHARE,
} from './outputPresets'

describe('the presets', () => {
  test('Landscape 3:2 is the default, because it is the approved reference', () => {
    // A regression here is not cosmetic: the reference BOE signed off is a 3:2
    // landscape, and a different default silently changes every result.
    assert.equal(DEFAULT_OUTPUT_PRESET, 'landscape')
    assert.equal(OUTPUT_PRESETS[DEFAULT_OUTPUT_PRESET].ratio, '3:2')
    assert.deepEqual([...OUTPUT_PRESETS.landscape.shotSize], [1200, 800])
  })

  test('all three shapes stay available, landscape first', () => {
    assert.deepEqual([...OUTPUT_PRESET_KEYS], ['landscape', 'square', 'portrait'])
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

  test('Square and Portrait keep their dimensions', () => {
    assert.deepEqual([...OUTPUT_PRESETS.square.shotSize], [1000, 1000])
    assert.deepEqual([...OUTPUT_PRESETS.portrait.shotSize], [900, 1125])
  })
})

describe('resolving what the caller sent', () => {
  test('a known key resolves to its own preset', () => {
    for (const key of OUTPUT_PRESET_KEYS) {
      assert.equal(resolveOutputPreset(key).key, key)
    }
  })

  test('anything else falls back to the default rather than reaching the provider', () => {
    // A caller sending numbers is the case this exists for: `shot_size` decides
    // what Bria renders, and a route that took dimensions from a form would let
    // somebody ask for a very large image on BOE's account.
    for (const bad of [
      undefined, null, '', 'SQUARE', 'panorama', 42, [4000, 4000], { key: 'square' },
      '[4000,4000]', 'square; drop', true,
    ]) {
      const resolved = resolveOutputPreset(bad)
      assert.equal(resolved.key, 'landscape', `${JSON.stringify(bad)} must not be honoured`)
      assert.deepEqual([...resolved.shotSize], [1200, 800])
    }
  })

  test('the resolved preset is one of the table entries, not a fresh object', () => {
    assert.equal(resolveOutputPreset('portrait'), OUTPUT_PRESETS.portrait)
  })
})

describe('the approved composition', () => {
  // The reference is a 3:2 landscape whose product fills about two thirds of
  // the height and stands on a baseline about six sevenths of the way down.
  // These are the numbers a result is measured against.

  test('landscape targets match the approved reference exactly', () => {
    const t = OUTPUT_PRESETS.landscape.target
    assert.equal(t.productHeight, 520)   // 512-528 asked for
    assert.equal(t.productTop, 168)      // 160-168
    assert.equal(t.feetBaseline, 688)    // 688-696
    assert.equal(t.centreX, 600)
  })

  test('every shape carries the same proportions, so a product looks the same size', () => {
    for (const preset of Object.values(OUTPUT_PRESETS)) {
      const height = preset.shotSize[1]
      const t = preset.target

      assert.ok(Math.abs(t.productHeight / height - PRODUCT_HEIGHT_SHARE) < 0.005,
        `${preset.key}: product is ${(t.productHeight / height * 100).toFixed(1)}% of the height`)
      assert.ok(Math.abs(t.productTop / height - SPACE_ABOVE_SHARE) < 0.005,
        `${preset.key}: ${(t.productTop / height * 100).toFixed(1)}% above`)
      assert.ok(Math.abs((height - t.feetBaseline) / height - SPACE_BELOW_SHARE) < 0.005,
        `${preset.key}: ${((height - t.feetBaseline) / height * 100).toFixed(1)}% below`)
      assert.equal(t.centreX, Math.round(preset.shotSize[0] / 2))
    }
  })

  test('the three shares account for the whole canvas', () => {
    assert.ok(Math.abs(PRODUCT_HEIGHT_SHARE + SPACE_ABOVE_SHARE + SPACE_BELOW_SHARE - 1) < 0.001)
  })
})
