/**
 * The lighting correction, and the promise it has to keep.
 *
 * BOE ships the object in the photograph, so the whole risk here is a
 * correction that changes what the product looks like — bleached upholstery, a
 * colour cast on a neutral finish, an edge moved by a pixel. Every test below
 * is one of those failures, written as an assertion.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/productTone.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  luma, toneStats, decideTone, buildToneLut, applyTone, enhanceRgba,
  TARGET_MEDIAN, MAX_GAIN, MIN_GAIN, HIGHLIGHT_CEILING, CONTRAST_K, SATURATION,
  ALPHA_OPAQUE,
} from './productTone'

/** An RGBA buffer of `pixels` identical grey pixels at a given alpha. */
function flat(pixels: number, value: number, alpha = 255): Buffer {
  const b = Buffer.alloc(pixels * 4)
  for (let i = 0; i < pixels; i++) {
    b[i * 4] = value; b[i * 4 + 1] = value; b[i * 4 + 2] = value; b[i * 4 + 3] = alpha
  }
  return b
}

/** A product of `body` grey, with `speculars` pixels of near-white highlight,
 *  sitting on a field of transparent pixels that carry leftover colour. */
function product(opts: {
  pixels: number; body: number; speculars?: number; specular?: number
  transparent?: number; transparentValue?: number
}): Buffer {
  const { pixels, body, speculars = 0, specular = 252, transparent = 0, transparentValue = 0 } = opts
  const b = Buffer.alloc((pixels + transparent) * 4)
  for (let i = 0; i < pixels; i++) {
    const v = i < speculars ? specular : body
    b[i * 4] = v; b[i * 4 + 1] = v; b[i * 4 + 2] = v; b[i * 4 + 3] = 255
  }
  for (let i = pixels; i < pixels + transparent; i++) {
    b[i * 4] = transparentValue; b[i * 4 + 1] = transparentValue; b[i * 4 + 2] = transparentValue
    b[i * 4 + 3] = 0
  }
  return b
}

describe('measuring the product', () => {
  test('only solid pixels are measured', () => {
    // The one that matters: a cut-out is mostly transparent, and those pixels
    // carry whatever RGB the provider left behind. Counting them would put the
    // median near black and hand every photograph the same large correction.
    const stats = toneStats(product({ pixels: 100, body: 180, transparent: 900 }), 1000)
    assert.equal(stats.samples, 100)
    assert.equal(stats.median, 180)
  })

  test('a cut-out with nothing solid in it is corrected by nothing at all', () => {
    const stats = toneStats(flat(100, 60, 0), 100)
    assert.equal(stats.samples, 0)

    const decision = decideTone(stats)
    assert.equal(decision.gain, 1)
    assert.equal(decision.contrastK, 0)
    assert.equal(decision.saturation, 1)
  })

  test('a half-transparent edge pixel is not evidence about exposure', () => {
    const buffer = flat(50, 200, ALPHA_OPAQUE - 1)
    assert.equal(toneStats(buffer, 50).samples, 0)
    assert.equal(toneStats(flat(50, 200, ALPHA_OPAQUE), 50).samples, 50)
  })

  test('the percentiles are the brightest material, not the brightest pixel', () => {
    // 1% specular at 252 over a body at 120. Read at the 99th, those specular
    // pixels answer for the whole product; read at the 98th they do not.
    const stats = toneStats(product({ pixels: 1000, body: 120, speculars: 10, specular: 252 }), 1000)
    assert.equal(stats.median, 120)
    assert.equal(stats.p98, 120, 'the 98th percentile must still be material')
    assert.ok(stats.p99 >= 120)
  })

  test('luma is the BT.601 weighting sharp uses, so grey stays grey', () => {
    assert.equal(Math.round(luma(255, 255, 255)), 255)
    assert.equal(luma(0, 0, 0), 0)
    assert.ok(luma(0, 255, 0) > luma(255, 0, 0), 'green weighs most')
    assert.ok(luma(255, 0, 0) > luma(0, 0, 255), 'blue weighs least')
  })
})

describe('deciding the correction', () => {
  test('a dim workshop photograph is lifted', () => {
    const decision = decideTone(toneStats(flat(1000, 80), 1000))
    assert.equal(decision.reason, 'underexposed')
    assert.ok(decision.gain > 1.2)
    assert.ok(decision.gain <= MAX_GAIN)
  })

  test('a photograph that is already well exposed receives almost nothing', () => {
    // "No fixed studio filter" is the requirement, and this is what it means:
    // a good photograph must come back looking like itself.
    const decision = decideTone(toneStats(flat(1000, TARGET_MEDIAN), 1000))
    assert.equal(decision.reason, 'already-exposed')
    assert.equal(decision.gain, 1)
  })

  test('a very dark photograph is not rescued past what is honest', () => {
    const decision = decideTone(toneStats(flat(1000, 12), 1000))
    assert.equal(decision.gain, MAX_GAIN, 'the ceiling holds')
  })

  test('an over-bright photograph is brought down, but barely', () => {
    const decision = decideTone(toneStats(flat(1000, 230), 1000))
    assert.equal(decision.reason, 'bright')
    assert.equal(decision.gain, MIN_GAIN)
    assert.ok(decision.gain < 1)
  })

  test('white upholstery keeps its texture: the highlights veto the lift', () => {
    // Dark in the median AND close to clipping at the top — the case that
    // turns into a flat white shape if the median is obeyed on its own.
    const stats = toneStats(product({ pixels: 1000, body: 100, speculars: 300, specular: 240 }), 1000)
    const decision = decideTone(stats)

    assert.equal(decision.reason, 'highlight-limited')
    assert.ok(decision.gain * stats.p98 <= HIGHLIGHT_CEILING + 1,
      `the brightest material would reach ${(decision.gain * stats.p98).toFixed(0)}`)
  })

  test('the veto can hold the lift back but never invert it', () => {
    // A dark product carrying a lot of near-clipping highlight: the veto's job
    // is to cancel the lift, and its floor of 1 is what stops it going on to
    // DARKEN a product that measured as underexposed.
    const decision = decideTone(toneStats(product({ pixels: 1000, body: 100, speculars: 200, specular: 254 }), 1000))
    assert.equal(decision.reason, 'highlight-limited')
    assert.equal(decision.gain, 1)
  })

  test('a few specular pixels do not veto the correction for the whole product', () => {
    // The 98th-percentile choice, stated as behaviour. 1% of pixels at 252 is
    // ordinary in any photograph of polished wood or metal.
    const decision = decideTone(toneStats(product({ pixels: 1000, body: 90, speculars: 10, specular: 252 }), 1000))
    assert.equal(decision.reason, 'underexposed')
    assert.ok(decision.gain > 1.2)
  })

  test('the corrections are bounded on both sides, by construction', () => {
    for (const value of [1, 8, 40, 90, 124, 160, 200, 240, 254]) {
      const decision = decideTone(toneStats(flat(500, value), 500))
      assert.ok(decision.gain >= MIN_GAIN && decision.gain <= MAX_GAIN,
        `median ${value} asked for a gain of ${decision.gain}`)
    }
  })
})

describe('the curve', () => {
  test('both endpoints are fixed, so nothing can be clipped by contrast', () => {
    const lut = buildToneLut({ gain: 1, contrastK: CONTRAST_K })
    assert.equal(lut[0], 0)
    assert.equal(lut[255], 255)
  })

  test('it never goes backwards: a lighter pixel stays lighter', () => {
    for (const gain of [MIN_GAIN, 1, 1.2, MAX_GAIN]) {
      const lut = buildToneLut({ gain, contrastK: CONTRAST_K })
      for (let i = 1; i < 256; i++) {
        assert.ok(lut[i] >= lut[i - 1], `gain ${gain} inverted at ${i}`)
      }
    }
  })

  test('contrast is added in the midtones, which is where flatness lives', () => {
    const flatLut = buildToneLut({ gain: 1, contrastK: 0 })
    const curved = buildToneLut({ gain: 1, contrastK: CONTRAST_K })

    assert.ok(curved[64] < flatLut[64], 'the lower midtones go down')
    assert.ok(curved[192] > flatLut[192], 'the upper midtones go up')
    assert.equal(curved[128] - flatLut[128] <= 1, true, 'the midpoint barely moves')
  })

  test('the curve stays inside the byte range for every input and every gain', () => {
    for (const gain of [MIN_GAIN, 1, MAX_GAIN, 2]) {
      const lut = buildToneLut({ gain, contrastK: CONTRAST_K })
      for (let i = 0; i < 256; i++) {
        assert.ok(lut[i] >= 0 && lut[i] <= 255, `gain ${gain}, input ${i} → ${lut[i]}`)
      }
    }
  })

  test('the contrast is restrained, and so is the saturation', () => {
    // Numbers, not adjectives: a large k or s here is a look applied to BOE's
    // product rather than a correction of the photograph.
    assert.ok(CONTRAST_K > 0 && CONTRAST_K <= 0.15, `${CONTRAST_K} is not restrained`)
    assert.ok(SATURATION >= 1 && SATURATION <= 1.1, `${SATURATION} is not restrained`)
  })
})

describe('applying it to the cut-out', () => {
  test('alpha is never touched — not one pixel, not by any amount', () => {
    // The reason this is a rule rather than a preference: alpha IS the product's
    // shape. A curve that moved it would thin a chair leg.
    const buffer = product({ pixels: 400, body: 70, transparent: 600 })
    for (let i = 0; i < 200; i++) buffer[i * 4 + 3] = 3 + (i % 250)   // a soft edge
    const before = Uint8Array.from(buffer.filter((_, i) => i % 4 === 3))

    applyTone(buffer, 1000, decideTone(toneStats(buffer, 1000)))

    const after = Uint8Array.from(buffer.filter((_, i) => i % 4 === 3))
    assert.deepEqual(after, before)
  })

  test('a fully transparent pixel is left exactly as it was', () => {
    const buffer = product({ pixels: 10, body: 60, transparent: 10, transparentValue: 17 })
    applyTone(buffer, 20, decideTone(toneStats(buffer, 20)))

    for (let i = 10; i < 20; i++) {
      assert.deepEqual([buffer[i * 4], buffer[i * 4 + 1], buffer[i * 4 + 2]], [17, 17, 17])
    }
  })

  test('a dim product actually gets brighter', () => {
    const buffer = flat(500, 80)
    const before = toneStats(buffer, 500).median
    enhanceRgba(buffer, 500)
    const after = toneStats(buffer, 500).median

    assert.ok(after > before + 15, `${before} → ${after}`)
    assert.ok(after <= TARGET_MEDIAN + 8, `${after} overshot the target`)
  })

  test('nothing that was not already clipped comes back clipped', () => {
    // "No highlight clipping": material at 240 must still be material at 240ish
    // afterwards, not a flat 255.
    const buffer = product({ pixels: 1000, body: 100, speculars: 300, specular: 240 })
    enhanceRgba(buffer, 1000)

    let clipped = 0
    for (let i = 0; i < 1000; i++) if (buffer[i * 4] >= 255) clipped++
    assert.equal(clipped, 0, `${clipped} pixels were pushed to pure white`)
  })

  test('white stays white in any photograph that is not itself over-bright', () => {
    // The endpoint-preserving curve, seen from the outside: wherever the gain
    // is 1 or above, 255 comes back 255 however much contrast is added.
    const buffer = product({ pixels: 1000, body: 110, speculars: 5, specular: 255 })
    enhanceRgba(buffer, 1000)
    assert.equal(buffer[0], 255)
  })

  test('an over-bright photograph is pulled down by 6% and no more', () => {
    // Stated as behaviour rather than left implicit: a photograph shot against
    // a bright background does come back slightly darker, and MIN_GAIN is the
    // whole of how far that can go.
    const buffer = flat(100, 255)
    enhanceRgba(buffer, 100)
    assert.ok(buffer[0] >= Math.round(255 * MIN_GAIN) - 2, `255 became ${buffer[0]}`)
    assert.ok(buffer[0] < 255, 'the bright branch did nothing at all')
  })

  test('a neutral finish stays neutral: no colour cast from the saturation', () => {
    // Saturation is a move away from the pixel's OWN grey, so grey has nowhere
    // to move to. White oak and a black metal frame both depend on this.
    for (const value of [12, 90, 128, 200, 250]) {
      const buffer = flat(20, value)
      enhanceRgba(buffer, 20)
      assert.equal(buffer[0], buffer[1], `${value}: red and green diverged`)
      assert.equal(buffer[1], buffer[2], `${value}: green and blue diverged`)
    }
  })

  test('hue is kept: a warm timber does not become an orange one', () => {
    const buffer = Buffer.alloc(4)
    buffer[0] = 150; buffer[1] = 100; buffer[2] = 60; buffer[3] = 255
    const hueBefore = Math.atan2(buffer[1] - buffer[2], buffer[0] - buffer[1])

    enhanceRgba(buffer, 1)
    const hueAfter = Math.atan2(buffer[1] - buffer[2], buffer[0] - buffer[1])
    assert.ok(Math.abs(hueBefore - hueAfter) < 0.25, 'the colour turned')

    // And it did not run away: 4% more saturation is 4% more, not a filter.
    const spread = (b: Buffer) => Math.max(b[0], b[1], b[2]) - Math.min(b[0], b[1], b[2])
    assert.ok(spread(buffer) < 150, `the colour spread reached ${spread(buffer)}`)
  })

  test('an already-good photograph passes through nearly untouched', () => {
    const buffer = flat(200, TARGET_MEDIAN)
    enhanceRgba(buffer, 200)
    assert.ok(Math.abs(buffer[0] - TARGET_MEDIAN) <= 2, `${TARGET_MEDIAN} became ${buffer[0]}`)
  })

  test('the same buffer twice through gives the same answer as measuring twice', () => {
    // Determinism: no randomness, no time, no accumulated state. Two identical
    // cut-outs must compose to identical bytes.
    const a = product({ pixels: 300, body: 95, speculars: 20, transparent: 100 })
    const b = product({ pixels: 300, body: 95, speculars: 20, transparent: 100 })
    enhanceRgba(a, 400)
    enhanceRgba(b, 400)
    assert.deepEqual(a, b)
  })
})
