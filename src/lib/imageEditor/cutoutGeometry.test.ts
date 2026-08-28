/**
 * Where the product is in a cut-out.
 *
 * This box is the input to every number in studioMaster.ts — padding is
 * measured in pixels around the product, so a box that is one leg too narrow
 * moves the chair on the finished master. Everything here runs on raw alpha
 * arrays written by hand, no sharp and no fixture, which is what makes the
 * awkward cases (a two-pixel leg, a stray speck, a soft edge) cheap enough to
 * test exhaustively.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/cutoutGeometry.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { alphaBounds, ALPHA_THRESHOLD, MIN_EDGE_PIXELS } from './cutoutGeometry'

/** A blank alpha plane, plus a painter for rectangles of product. */
function plane(width: number, height: number) {
  const a = new Uint8Array(width * height)
  return {
    a,
    fill(left: number, top: number, w: number, h: number, value = 255) {
      for (let y = top; y < top + h; y++) {
        for (let x = left; x < left + w; x++) a[y * width + x] = value
      }
      return this
    },
  }
}

describe('finding the product', () => {
  test('the box is tight around the product, and inclusive of its last pixel', () => {
    const { a } = plane(100, 100).fill(20, 30, 40, 50)
    const b = alphaBounds(a, 100, 100)!

    assert.deepEqual(
      { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
      { left: 20, top: 30, right: 59, bottom: 79 },
    )
    // width/height count both edges: a 40px-wide product is 40, not 39.
    assert.equal(b.width, 40)
    assert.equal(b.height, 50)
  })

  test('a product touching every edge is measured as the whole frame', () => {
    const { a } = plane(40, 40).fill(0, 0, 40, 40)
    const b = alphaBounds(a, 40, 40)!
    assert.deepEqual([b.left, b.top, b.width, b.height], [0, 0, 40, 40])
  })

  test('a fully transparent cut-out has no product at all', () => {
    assert.equal(alphaBounds(new Uint8Array(60 * 60), 60, 60), null)
  })

  test('a soft edge still counts: the threshold is low, deliberately', () => {
    // Cane, a lace curtain, the taper of a metal tip — all live here. A high
    // threshold would trim exactly the detail the brief says must survive.
    const { a } = plane(50, 50).fill(10, 10, 20, 20, ALPHA_THRESHOLD)
    assert.ok(alphaBounds(a, 50, 50))

    const { a: below } = plane(50, 50).fill(10, 10, 20, 20, ALPHA_THRESHOLD - 1)
    assert.equal(alphaBounds(below, 50, 50), null)
  })

  test('a stray speck does not stretch the box, but a thin leg does', () => {
    // The distinction the density rule exists for. A single left-over pixel out
    // in the corner is segmentation noise; a two-pixel-wide chair leg is the
    // product, and clipping it is not an option.
    const { a } = plane(200, 200)
      .fill(80, 40, 40, 120)   // the seat
      .fill(3, 3, 1, 1)        // one speck, top-left
    const b = alphaBounds(a, 200, 200)!
    assert.equal(b.left, 80, 'a lone pixel must not become the left edge')
    assert.equal(b.top, 40)

    const withLeg = plane(200, 200)
      .fill(80, 40, 40, 120)
      .fill(3, 40, MIN_EDGE_PIXELS, 120)   // a genuinely thin leg
    const legBounds = alphaBounds(withLeg.a, 200, 200)!
    assert.equal(legBounds.left, 3, 'a thin leg must be inside the box')
  })

  test('the box never depends on how transparent the pixels are, only whether', () => {
    const solid = plane(80, 80).fill(10, 10, 30, 30, 255)
    const faint = plane(80, 80).fill(10, 10, 30, 30, 40)
    assert.deepEqual(alphaBounds(solid.a, 80, 80), alphaBounds(faint.a, 80, 80))
  })

  test('nothing is written back: alphaBounds only reads', () => {
    const { a } = plane(30, 30).fill(5, 5, 10, 10)
    const before = Uint8Array.from(a)
    alphaBounds(a, 30, 30)
    assert.deepEqual(a, before)
  })
})
