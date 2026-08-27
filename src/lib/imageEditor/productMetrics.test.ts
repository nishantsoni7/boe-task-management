/**
 * The measurements every decision in the composition rests on.
 *
 * These are pure functions over pixel buffers, so the cases can state exactly
 * what a chair looks like to the code: where its box is, where its weight is,
 * which of its columns reach the floor, how bright it is, how much fine detail
 * it carries.
 *
 * The contact-column case is the one that matters. It is what tells a shadow
 * under four feet apart from a silhouette of the whole chair printed on the
 * floor — the defect this replaced.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/productMetrics.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  alphaBounds, alphaCentroidX, lowestOpaqueRows, contactColumns,
  toneStats, detailScore, luma,
} from './productMetrics'

/** An alpha plane with rectangles painted into it. */
function mask(width: number, height: number, rects: Array<[number, number, number, number]>): Uint8Array {
  const a = new Uint8Array(width * height)
  for (const [left, top, w, h] of rects) {
    for (let y = top; y < top + h; y++) {
      for (let x = left; x < left + w; x++) a[y * width + x] = 255
    }
  }
  return a
}

describe('alphaBounds', () => {
  test('finds the tight box around anything opaque', () => {
    const a = new Uint8Array(100)
    a[2 * 10 + 3] = 255
    a[6 * 10 + 8] = 255
    assert.deepEqual(alphaBounds(a, 10, 10), { left: 3, top: 2, width: 6, height: 5 })
  })

  test('ignores all-but-invisible pixels, and answers null for an empty mask', () => {
    assert.equal(alphaBounds(new Uint8Array(16).fill(3), 4, 4), null)
    assert.equal(alphaBounds(new Uint8Array(16), 4, 4), null)
  })
})

describe('alphaCentroidX', () => {
  test('a symmetric product centres on its middle', () => {
    const a = mask(100, 20, [[40, 0, 20, 20]])
    const bounds = alphaBounds(a, 100, 20)!
    assert.ok(Math.abs(alphaCentroidX(a, 100, bounds) - bounds.width / 2) < 0.5)
  })

  test('weight on one side pulls the centre toward it', () => {
    // A wide block on the left, a thin one on the right: the bounding box's
    // middle and the product's middle are two different places, and a chair
    // with one arm toward the camera is exactly this shape.
    const a = mask(200, 20, [[0, 0, 60, 20], [180, 0, 10, 20]])
    const bounds = alphaBounds(a, 200, 20)!
    const centroid = alphaCentroidX(a, 200, bounds)

    assert.ok(centroid < bounds.width / 2, `${centroid} should sit left of ${bounds.width / 2}`)
    assert.ok(centroid > 0)
  })
})

describe('floor contact', () => {
  test('finds the lowest product pixel in every column', () => {
    const a = mask(10, 10, [[1, 2, 2, 6], [7, 2, 2, 8]])
    const bounds = alphaBounds(a, 10, 10)!
    const lowest = lowestOpaqueRows(a, 10, bounds)

    // Relative to the bounds: the short column ends higher than the tall one.
    assert.equal(lowest[0], 5)
    assert.equal(lowest[bounds.width - 1], 7)
    // The gap between them holds no product at all.
    assert.equal(lowest[3], -1)
  })

  test('only the columns that reach the floor cast a shadow', () => {
    // A seat spanning the whole width, on two legs. The seat is the majority of
    // the silhouette and touches nothing.
    const a = mask(40, 40, [[0, 0, 40, 10], [2, 10, 4, 30], [34, 10, 4, 30]])
    const bounds = alphaBounds(a, 40, 40)!
    const columns = contactColumns(lowestOpaqueRows(a, 40, bounds), 2)

    let touching = 0
    for (const c of columns) if (c) touching++

    // Eight columns of leg, not forty of chair.
    assert.equal(touching, 8)
    assert.equal(columns[3], 255, 'a leg column touches')
    assert.equal(columns[20], 0, 'the middle of the seat does not')
  })

  test('feet a few pixels out of level still both count', () => {
    const a = mask(20, 20, [[2, 5, 3, 14], [15, 5, 3, 15]])
    const bounds = alphaBounds(a, 20, 20)!
    const lowest = lowestOpaqueRows(a, 20, bounds)

    // Tolerance 0: only the lower foot. Tolerance 2: both, which is what a
    // photograph of a real floor needs.
    const strict = contactColumns(lowest, 0)
    const forgiving = contactColumns(lowest, 2)

    const count = (m: Uint8Array) => m.reduce((n, v) => n + (v ? 1 : 0), 0)
    assert.equal(count(strict), 3)
    assert.equal(count(forgiving), 6)
  })

  test('an empty mask produces no contact columns', () => {
    assert.equal(contactColumns(new Int32Array(10).fill(-1), 2).every(v => v === 0), true)
  })
})

describe('toneStats', () => {
  /** An RGBA buffer: `opaque` pixels of one grey, then transparent filler. */
  function rgba(opaque: number, value: number, filler: number): Uint8Array {
    const buf = new Uint8Array((opaque + filler) * 4)
    for (let i = 0; i < opaque; i++) {
      buf[i * 4] = value; buf[i * 4 + 1] = value; buf[i * 4 + 2] = value; buf[i * 4 + 3] = 255
    }
    // Transparent pixels carrying leftover RGB, exactly as a cut-out does.
    for (let i = opaque; i < opaque + filler; i++) {
      buf[i * 4] = 0; buf[i * 4 + 1] = 0; buf[i * 4 + 2] = 0; buf[i * 4 + 3] = 0
    }
    return buf
  }

  test('transparent pixels are not counted', () => {
    // Nine tenths of a cut-out is transparent. Counting it would put the median
    // near black and hand every photograph the same large "correction".
    const stats = toneStats(rgba(100, 180, 900), 1000)
    assert.equal(stats.median, 180)
    assert.equal(stats.samples, 100)
  })

  test('an all-transparent buffer answers neutrally instead of dividing by zero', () => {
    const stats = toneStats(rgba(0, 0, 50), 50)
    assert.equal(stats.samples, 0)
    assert.equal(stats.median, 128)
  })

  test('the 99th percentile finds the brightest upholstery', () => {
    const buf = new Uint8Array(1000 * 4)
    for (let i = 0; i < 1000; i++) {
      const v = i < 990 ? 100 : 250
      buf[i * 4] = v; buf[i * 4 + 1] = v; buf[i * 4 + 2] = v; buf[i * 4 + 3] = 255
    }
    const stats = toneStats(buf, 1000)
    assert.equal(stats.median, 100)
    assert.ok(stats.p99 >= 100, 'the highlight tail must be visible to the exposure veto')
  })

  test('luma weights green the way the eye does', () => {
    assert.ok(luma(0, 255, 0) > luma(255, 0, 0))
    assert.ok(luma(255, 0, 0) > luma(0, 0, 255))
  })
})

describe('detailScore', () => {
  test('a textured product scores far above a flat one', () => {
    const w = 60, h = 60
    const alpha = new Uint8Array(w * h).fill(255)
    const flat = new Uint8Array(w * h).fill(140)
    const woven = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) woven[y * w + x] = (x % 4 < 2) === (y % 4 < 2) ? 90 : 190
    }

    assert.ok(detailScore(flat, alpha, w, h) < 1)
    assert.ok(detailScore(woven, alpha, w, h) > 40)
  })

  test('the cut-out edge is excluded, so it cannot be mistaken for texture', () => {
    // A hard alpha edge is the strongest "detail" in any cut-out. Counting it
    // would let a blurred product pass the sharpness gate on the strength of
    // its own outline.
    const w = 60, h = 60
    const grey = new Uint8Array(w * h).fill(140)
    const alpha = new Uint8Array(w * h)
    for (let y = 20; y < 40; y++) for (let x = 20; x < 40; x++) alpha[y * w + x] = 255

    assert.equal(detailScore(grey, alpha, w, h), 0)
  })

  test('too few product pixels to judge scores zero rather than a wild number', () => {
    const alpha = new Uint8Array(100)
    alpha[55] = 255
    assert.equal(detailScore(new Uint8Array(100).fill(200), alpha, 10, 10), 0)
  })
})
