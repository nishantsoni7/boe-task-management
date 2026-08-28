/**
 * Where the product is, and whether it may be enlarged to fill the frame.
 *
 * These are the functions that decide the composition, so they are the ones
 * that decide whether a catalogue image is right. Everything here runs on raw
 * alpha arrays written by hand — no sharp, no provider, no fixture — which is
 * what makes the awkward cases (a two-pixel leg, a foot at the frame edge, a
 * chair photographed too far away) cheap enough to test exhaustively.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/cutoutGeometry.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  alphaBounds, lowestOpaqueRows, contactColumns, planPlacement, checkEnlargement,
  ALPHA_THRESHOLD, MIN_EDGE_PIXELS, MAX_ENLARGEMENT,
} from './cutoutGeometry'
import { OUTPUT_PRESETS, SIDE_MARGIN_SHARE } from './outputPresets'

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

describe('the underside of the product', () => {
  test('each column reports its own lowest pixel, relative to the box', () => {
    // Two legs of different lengths — the shape a three-quarter view makes.
    const p = plane(60, 60)
      .fill(10, 10, 4, 30)   // short leg, ends at y=39
      .fill(30, 10, 4, 40)   // long leg,  ends at y=49
    const bounds = alphaBounds(p.a, 60, 60)!
    const lowest = lowestOpaqueRows(p.a, 60, bounds)

    // Column 0 of the box is x=10, i.e. the short leg; the long leg is 20 across.
    assert.equal(lowest[0], 39 - bounds.top)
    assert.equal(lowest[20], 49 - bounds.top)
    assert.equal(lowest[10], -1, 'the gap between the legs touches nothing')
  })

  test('only the columns that reach the floor cast a contact shadow', () => {
    const lowest = Int32Array.from([100, 99, -1, -1, 60, 100])
    const mask = contactColumns(lowest, 4)

    assert.deepEqual([...mask], [255, 255, 0, 0, 0, 255])
  })

  test('back feet, higher in the frame, still count as standing on the floor', () => {
    // A chair at three-quarters has its back feet several pixels up. Excluding
    // them would leave two feet floating.
    const lowest = Int32Array.from([200, 188, 200, 190])
    assert.deepEqual([...contactColumns(lowest, 12)], [255, 255, 255, 255])
  })

  test('a seat rail well above the feet does not', () => {
    // This is what keeps it a contact shadow rather than a silhouette.
    const lowest = Int32Array.from([200, 120, 200])
    assert.deepEqual([...contactColumns(lowest, 12)], [255, 0, 255])
  })

  test('nothing touching means no shadow rather than a shadow at row zero', () => {
    assert.ok(contactColumns(Int32Array.from([-1, -1, -1]), 8).every(c => c === 0))
  })
})

describe('placing the product', () => {
  // The landscape reference, written out, so the expectations below are
  // readable without looking the preset up.
  const LANDSCAPE = {
    productHeight: 520, feetBaseline: 688, centreX: 600, maxProductWidth: 1056,
  }

  test('the height is what is matched, and the width follows it', () => {
    const plan = planPlacement({ width: 400, height: 800 }, LANDSCAPE)
    assert.equal(plan.height, 520)
    assert.equal(plan.width, 260)
    assert.equal(plan.scale, 0.65)
  })

  test('one scale for both axes: a product is never stretched', () => {
    for (const source of [
      { width: 900, height: 300 },   // a bench
      { width: 300, height: 900 },   // a tall cabinet
      { width: 640, height: 641 },
    ]) {
      const plan = planPlacement(source, LANDSCAPE)
      const sourceRatio = source.width / source.height
      const placedRatio = plan.width / plan.height
      assert.ok(Math.abs(sourceRatio - placedRatio) < 0.005,
        `${source.width}x${source.height} became ${plan.width}x${plan.height}`)
    }
  })

  test('it lands horizontally centred, within a rounding pixel', () => {
    for (const width of [401, 402, 403, 404]) {
      const plan = planPlacement({ width, height: 800 }, LANDSCAPE)
      const centre = plan.left + plan.width / 2
      assert.ok(Math.abs(centre - 600) <= 0.5, `centre landed at ${centre}`)
    }
  })

  test('an ordinary product lands on the approved top edge exactly', () => {
    // Anchoring on the feet must reproduce the top the reference specifies:
    // 21% above plus 65% of the height is the 86% baseline, to the pixel.
    const plan = planPlacement({ width: 400, height: 800 }, LANDSCAPE)
    assert.equal(plan.top, 168)
    assert.equal(plan.top + plan.height, 688)
  })

  test('every preset places a real product on its approved coordinates', () => {
    // The reference measured end to end: a product the shape of the approved
    // chair, checked against the shares the brief fixes.
    for (const preset of Object.values(OUTPUT_PRESETS)) {
      const [canvasWidth, canvasHeight] = preset.shotSize
      const plan = planPlacement({ width: 600, height: 900 }, preset.target)
      const feet = plan.top + plan.height

      assert.ok(Math.abs(plan.height / canvasHeight - 0.65) < 0.005, `${preset.key}: product share`)
      assert.ok(Math.abs(plan.top / canvasHeight - 0.21) < 0.005, `${preset.key}: space above`)
      assert.ok(Math.abs((canvasHeight - feet) / canvasHeight - 0.14) < 0.005, `${preset.key}: space below`)
      assert.ok(Math.abs(plan.left + plan.width / 2 - canvasWidth / 2) <= 0.5, `${preset.key}: centring`)

      // And it fits: a product wider than the canvas would be cropped by the
      // composite rather than reported.
      assert.ok(plan.left >= 0 && plan.left + plan.width <= canvasWidth,
        `${preset.key}: ${plan.width}px wide does not fit ${canvasWidth}px`)
    }
  })

  test('a long sideboard is made whole rather than exactly 65% tall', () => {
    // At 65% of the height a 3:1 product is 1560px wide on a 1200px canvas.
    // Before the width limit existed this produced a negative left offset,
    // which sharp refuses — every wide product failed to compose at all.
    for (const preset of Object.values(OUTPUT_PRESETS)) {
      const [canvasWidth] = preset.shotSize
      const plan = planPlacement({ width: 1500, height: 500 }, preset.target)

      assert.ok(plan.left >= 0, `${preset.key}: starts at ${plan.left}`)
      assert.ok(plan.left + plan.width <= canvasWidth,
        `${preset.key}: ends at ${plan.left + plan.width} on a ${canvasWidth}px canvas`)
      assert.ok(plan.height < preset.target.productHeight,
        `${preset.key}: a width-limited product must be shorter than the target`)
    }
  })

  test('a width-limited product still stands on the floor', () => {
    // The reason the anchor is the feet: a shorter product that kept its 21%
    // above would hover, and a hovering sideboard reads as a mistake.
    for (const preset of Object.values(OUTPUT_PRESETS)) {
      const plan = planPlacement({ width: 1500, height: 500 }, preset.target)
      assert.equal(plan.top + plan.height, preset.target.feetBaseline, preset.key)
    }
  })

  test('the width limit keeps a clear margin at both sides', () => {
    const plan = planPlacement({ width: 1500, height: 500 }, OUTPUT_PRESETS.landscape.target)
    const margin = Math.min(plan.left, 1200 - (plan.left + plan.width))
    assert.ok(margin >= 1200 * SIDE_MARGIN_SHARE - 1, `only ${margin}px of margin`)
  })

  test('the two limits agree at the crossover instead of jumping', () => {
    const target = OUTPUT_PRESETS.landscape.target
    // The aspect ratio at which the width becomes the binding limit.
    const crossover = target.maxProductWidth / target.productHeight
    const justUnder = planPlacement({ width: Math.round(1000 * crossover) - 6, height: 1000 }, target)
    const justOver  = planPlacement({ width: Math.round(1000 * crossover) + 6, height: 1000 }, target)

    assert.ok(Math.abs(justUnder.height - justOver.height) <= 4,
      `${justUnder.height} then ${justOver.height}: the height must not jump at the crossover`)
    assert.ok(justOver.width <= target.maxProductWidth)
  })

  test('a placed product is at least one pixel, whatever the arithmetic says', () => {
    const plan = planPlacement({ width: 1, height: 4000 }, {
      productHeight: 100, feetBaseline: 110, centreX: 50, maxProductWidth: 880,
    })
    assert.ok(plan.width >= 1 && plan.height >= 1)
  })
})

describe('the enlargement cap', () => {
  test('a product photographed large enough passes', () => {
    const verdict = checkEnlargement({ width: 900, height: 900 }, { productHeight: 520, maxProductWidth: 1056 })
    assert.equal(verdict.ok, true)
    assert.ok(verdict.scale < 1, 'this one is being reduced, not enlarged')
  })

  test('exactly at the cap is allowed; a hair past it is not', () => {
    const at = checkEnlargement({ width: 1000, height: 1000 }, { productHeight: Math.round(1000 * MAX_ENLARGEMENT), maxProductWidth: 100_000 })
    assert.equal(at.ok, true)

    const past = checkEnlargement({ width: 1000, height: 1000 }, { productHeight: Math.round(1000 * MAX_ENLARGEMENT) + 1, maxProductWidth: 100_000 })
    assert.equal(past.ok, false)
  })

  test('a product too small to fill the frame is refused, not blurred', () => {
    // The failure the measurement in turn four traced the blurry results to:
    // 2.11x enlargement cost 71% of the detail. Refusing is the feature.
    const verdict = checkEnlargement({ width: 250, height: 250 }, { productHeight: 520, maxProductWidth: 1056 })
    assert.equal(verdict.ok, false)
    if (verdict.ok) return
    assert.ok(verdict.scale > 2)
    assert.match(verdict.message, /too small/i)
  })

  test('the refusal says what would have worked, in pixels', () => {
    // Actionable or it is just a wall: "take it closer" needs a number.
    const verdict = checkEnlargement({ width: 250, height: 250 }, { productHeight: 520, maxProductWidth: 1056 })
    assert.equal(verdict.ok, false)
    if (verdict.ok) return

    assert.equal(verdict.needed, Math.ceil(520 / MAX_ENLARGEMENT))
    // And that height would indeed pass.
    assert.equal(checkEnlargement({ width: verdict.needed, height: verdict.needed }, { productHeight: 520, maxProductWidth: 1056 }).ok, true)
  })

  test('the message names no provider, no model and no endpoint', () => {
    const verdict = checkEnlargement({ width: 100, height: 100 }, { productHeight: 520, maxProductWidth: 1056 })
    assert.equal(verdict.ok, false)
    if (verdict.ok) return

    for (const word of ['fal', 'bria', 'api', 'http', 'model', 'endpoint', 'credit']) {
      assert.ok(!verdict.message.toLowerCase().includes(word),
        `the employee-facing message must not mention ${word}: ${verdict.message}`)
    }
  })

  test('the cap is a modest one — enlargement invents nothing', () => {
    assert.ok(MAX_ENLARGEMENT > 1 && MAX_ENLARGEMENT <= 1.25,
      `${MAX_ENLARGEMENT} is not a defensible enlargement`)
  })
})
