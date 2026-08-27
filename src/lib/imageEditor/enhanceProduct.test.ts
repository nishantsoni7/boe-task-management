/**
 * Lighting and colour: how much a photograph gets, and what it is never allowed
 * to do.
 *
 * The two cases that decide whether this is usable on real furniture:
 *
 *   * a photograph that is ALREADY well exposed must come out essentially
 *     unchanged — the complaint this replaced was flatness, and the wrong cure
 *     is a fixed filter that treats every photograph as broken;
 *   * white upholstery must not clip. A dark median and a highlight tail near
 *     255 is exactly what a white chair in a dim workshop looks like, and a
 *     naive exposure lift turns it into a white silhouette.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/enhanceProduct.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideTone, decideWhiteBalance, buildToneLut, applyTone, enhanceRgba,
  TARGET_MEDIAN, MAX_GAIN, HIGHLIGHT_CEILING, CONTRAST_K,
  MAX_CHANNEL_GAIN, MIN_CHANNEL_GAIN, MIN_NEUTRAL_SHARE,
} from './enhanceProduct'
import { toneStats, neutralStats, luma } from './productMetrics'

const stats = (median: number, p98 = Math.min(255, median + 60), samples = 10_000) =>
  ({ median, p98, p99: Math.min(255, p98 + 5), mean: median, samples })

describe('how much correction a photograph gets', () => {
  test('a dim workshop photograph is lifted toward the target', () => {
    const decision = decideTone(stats(70, 150))
    assert.equal(decision.reason, 'underexposed')
    assert.ok(decision.gain > 1.2, `expected a real lift, got ${decision.gain}`)
    assert.ok(decision.gain <= MAX_GAIN)
  })

  test('a photograph already at the target is left alone', () => {
    const decision = decideTone(stats(TARGET_MEDIAN, 200))
    assert.equal(decision.reason, 'already-exposed')
    assert.equal(decision.gain, 1)
  })

  test('a very dark photograph is lifted, but only as far as the cap', () => {
    const decision = decideTone(stats(20, 60))
    assert.equal(decision.gain, MAX_GAIN)
  })

  test('an over-bright photograph is brought down, gently', () => {
    const decision = decideTone(stats(200, 255))
    assert.equal(decision.reason, 'bright')
    assert.ok(decision.gain < 1 && decision.gain >= 0.92)
  })

  test('nothing to measure means nothing is done', () => {
    const decision = decideTone(stats(128, 255, 0))
    assert.equal(decision.gain, 1)
    assert.equal(decision.contrastK, 0)
    assert.equal(decision.saturation, 1)
  })
})

describe('white upholstery', () => {
  test('a few specular pixels do not cancel the correction', () => {
    // p99 at 254 (a varnish highlight) but the material itself at 190: the
    // exposure lift must survive, or every glossy product comes back flat.
    const decision = decideTone({ median: 92, p98: 190, p99: 254, mean: 92, samples: 10_000 })
    assert.ok(decision.gain > 1.2, `expected a lift, got ${decision.gain}`)
  })

  test('the highlight veto overrides the exposure the median asked for', () => {
    // Dark overall, but already nearly clipping at the top: a white chair shot
    // in a dim workshop. The median alone would ask for ~1.4x.
    const decision = decideTone(stats(88, 244))
    assert.equal(decision.reason, 'highlight-limited')
    assert.ok(decision.gain < 1.1, `expected the veto to bite, got ${decision.gain}`)
    assert.ok(decision.stats.p98 * decision.gain <= HIGHLIGHT_CEILING + 1)
  })

  test('the veto never darkens a photograph to protect highlights', () => {
    const decision = decideTone(stats(100, 255))
    assert.ok(decision.gain >= 1)
  })

  test('the contrast curve cannot clip either end, at any gain', () => {
    for (const gain of [1, 1.2, MAX_GAIN]) {
      const lut = buildToneLut({ gain, contrastK: CONTRAST_K })
      assert.equal(lut[0], 0, 'black stays black')
      assert.ok(lut[255] <= 255)
      // Monotonic: a curve that folded back would invert texture.
      for (let i = 1; i < 256; i++) assert.ok(lut[i] >= lut[i - 1], `not monotonic at ${i}`)
    }
  })

  test('at gain 1 the curve only shapes midtones, leaving the extremes alone', () => {
    const lut = buildToneLut({ gain: 1, contrastK: CONTRAST_K })
    assert.equal(lut[0], 0)
    assert.equal(lut[255], 255)
    assert.ok(Math.abs(lut[128] - 128) <= 2, 'the midpoint is a fixed point of the S')
    assert.ok(lut[64] < 64, 'lower midtones deepen')
    assert.ok(lut[192] > 192, 'upper midtones lift')
  })
})

describe('what the correction must not change', () => {
  /** One pixel, corrected. */
  function correct(r: number, g: number, b: number, median: number) {
    const buf = new Uint8Array(4)
    buf[0] = r; buf[1] = g; buf[2] = b; buf[3] = 255
    applyTone(buf, 1, decideTone(stats(median)))
    return { r: buf[0], g: buf[1], b: buf[2] }
  }

  test('a neutral pixel stays neutral — no colour cast is introduced', () => {
    // Saturation moves a pixel away from its own grey, so grey has nowhere to
    // go. White upholstery must not come back faintly warm.
    const out = correct(200, 200, 200, 90)
    assert.equal(out.r, out.g)
    assert.equal(out.g, out.b)
  })

  test('hue order survives: wood stays wood', () => {
    const wood = correct(150, 95, 45, 95)
    assert.ok(wood.r > wood.g && wood.g > wood.b, JSON.stringify(wood))
  })

  test('a well-exposed product is barely touched', () => {
    const before = { r: 150, g: 120, b: 90 }
    const after = correct(before.r, before.g, before.b, TARGET_MEDIAN)
    for (const k of ['r', 'g', 'b'] as const) {
      assert.ok(Math.abs(after[k] - before[k]) <= 8,
        `${k}: ${before[k]} → ${after[k]} is more than a well-exposed photograph should move`)
    }
  })

  test('alpha is never touched', () => {
    const buf = new Uint8Array([120, 90, 60, 137])
    applyTone(buf, 1, decideTone(stats(80)))
    assert.equal(buf[3], 137)
  })

  test('fully transparent pixels are skipped entirely', () => {
    const buf = new Uint8Array([12, 34, 56, 0])
    applyTone(buf, 1, decideTone(stats(60)))
    assert.deepEqual([...buf], [12, 34, 56, 0])
  })
})

describe('enhanceRgba end to end', () => {
  test('lifts a dim product and reports what it did', () => {
    // A dim product, plus transparent filler that must not drag the median down.
    const pixels = 2000
    const buf = new Uint8Array(pixels * 4)
    for (let i = 0; i < 500; i++) {
      buf[i * 4] = 70; buf[i * 4 + 1] = 66; buf[i * 4 + 2] = 60; buf[i * 4 + 3] = 255
    }

    const before = toneStats(buf, pixels).median
    const decision = enhanceRgba(buf, pixels)
    const after = toneStats(buf, pixels).median

    assert.equal(decision.reason, 'underexposed')
    assert.ok(after > before + 15, `${before} → ${after} is not a visible correction`)
    assert.ok(luma(buf[0], buf[1], buf[2]) < 200, 'and not an overcorrection either')
  })
})

describe('white balance', () => {
  const neutral = (r: number, g: number, b: number, share = 0.2) =>
    ({ count: 5000, r, g, b, share })

  test('a cool workshop cast is corrected toward neutral', () => {
    // White upholstery reading blue: the light was blue, not the fabric.
    const wb = decideWhiteBalance(neutral(180, 190, 210))
    assert.equal(wb.applied, true)
    assert.ok(wb.r > 1, 'red is lifted')
    assert.ok(wb.b < 1, 'blue is pulled back')
  })

  test('a warm cast is corrected the other way', () => {
    const wb = decideWhiteBalance(neutral(215, 190, 172))
    assert.ok(wb.r < 1 && wb.b > 1)
  })

  test('the correction is capped whatever the estimate asks for', () => {
    // A violent cast. The cap is what stops one bad estimate ruining a product.
    const wb = decideWhiteBalance(neutral(120, 190, 250))
    for (const c of [wb.r, wb.g, wb.b]) {
      assert.ok(c <= MAX_CHANNEL_GAIN + 1e-9 && c >= MIN_CHANNEL_GAIN - 1e-9, `${c} is outside the cap`)
    }
  })

  test('a product with no neutral surface is left entirely alone', () => {
    // A solid teak stool. Grey-world would drag it toward grey; this declines.
    assert.equal(decideWhiteBalance({ count: 0, r: 0, g: 0, b: 0, share: 0 }).applied, false)
    assert.equal(decideWhiteBalance(neutral(200, 200, 200, MIN_NEUTRAL_SHARE / 2)).applied, false)
  })

  test('an already-neutral product is not moved', () => {
    const wb = decideWhiteBalance(neutral(200, 200, 200))
    assert.ok(Math.abs(wb.r - 1) < 1e-9 && Math.abs(wb.g - 1) < 1e-9 && Math.abs(wb.b - 1) < 1e-9)
  })

  test('measured end to end: a blue-cast product comes back closer to neutral', () => {
    const pixels = 4000
    const buf = new Uint8Array(pixels * 4)
    for (let i = 0; i < pixels; i++) {
      const o = i * 4
      // A pale, slightly blue material, with a little texture so it is real.
      buf[o] = 176 + (i % 3); buf[o + 1] = 186 + (i % 3); buf[o + 2] = 206 + (i % 3)
      buf[o + 3] = 255
    }

    const spreadBefore = buf[2] - buf[0]
    enhanceRgba(buf, pixels)
    const spreadAfter = buf[2] - buf[0]

    assert.ok(spreadAfter < spreadBefore, `blue-red spread ${spreadBefore} → ${spreadAfter}`)
    assert.ok(spreadAfter > 0, 'and not overcorrected past neutral')
  })

  test('a saturated wooden product keeps its colour', () => {
    const pixels = 4000
    const buf = new Uint8Array(pixels * 4)
    for (let i = 0; i < pixels; i++) {
      const o = i * 4
      buf[o] = 150 + (i % 4); buf[o + 1] = 96 + (i % 4); buf[o + 2] = 44 + (i % 4)
      buf[o + 3] = 255
    }

    assert.equal(neutralStats(buf, pixels).count, 0, 'teak offers nothing neutral to measure')
    const decision = decideTone(toneStats(buf, pixels), neutralStats(buf, pixels))
    assert.equal(decision.whiteBalance.applied, false)
  })
})
