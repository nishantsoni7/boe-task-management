/**
 * The sizing arithmetic — the one defect the product owner found, and the fix.
 *
 * The accepted result was right about the background, the lighting, the shadows
 * and the square master. The chair was too small. Everything here is about the
 * number that fixes that and about not breaking it for the next product:
 *
 *   * 52-55% of the canvas height, on the product owner's instruction;
 *   * derived from the cut-out's real width and height, so it is right for a
 *     wardrobe and a footstool and not tuned against one chair;
 *   * a very wide piece contained rather than cropped;
 *   * padding in Bria's order, [left, right, top, bottom], closing exactly on
 *     a 1000 x 1000 canvas.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/studioMaster.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  planPadding, fitScale, checkEnlargement,
  MASTER_WIDTH, MASTER_HEIGHT, PRODUCT_HEIGHT_SHARE,
  PRODUCT_HEIGHT_MIN, PRODUCT_HEIGHT_MAX, SIDE_MARGIN_SHARE, MAX_ENLARGEMENT,
} from './studioMaster'

/** Shapes a furniture cut-out actually comes in. */
const PRODUCTS = [
  { name: 'dining chair',   width: 900,  height: 1200 },
  { name: 'lounge chair',   width: 1200, height: 1100 },
  { name: 'tall cabinet',   width: 700,  height: 1900 },
  { name: 'low bench',      width: 1500, height: 700 },
  { name: 'square stool',   width: 800,  height: 800 },
  { name: 'long sideboard', width: 2400, height: 800 },
  { name: 'narrow lamp',    width: 260,  height: 1400 },
]

describe('the master canvas', () => {
  test('it is square, and it is the megapixel Bria calls optimal', () => {
    assert.equal(MASTER_WIDTH, 1000)
    assert.equal(MASTER_HEIGHT, 1000)
    // "For optimal results, the total number of pixels, including padding,
    // should be around 1,000,000" — the schema, on padding_values.
    assert.equal(MASTER_WIDTH * MASTER_HEIGHT, 1_000_000)
  })

  test('every product lands on exactly that canvas', () => {
    // Under manual_padding the canvas IS cut-out plus padding, so if these do
    // not close exactly the master is not 1000 x 1000 and nothing downstream
    // would say so.
    for (const p of PRODUCTS) {
      const plan = planPadding(p)
      assert.equal(plan.padding.left + plan.product.width + plan.padding.right, MASTER_WIDTH, p.name)
      assert.equal(plan.padding.top + plan.product.height + plan.padding.bottom, MASTER_HEIGHT, p.name)
      assert.deepEqual(plan.canvas, { width: 1000, height: 1000 }, p.name)
    }
  })
})

describe('how big the product comes out', () => {
  test('the target is the middle of the range the product owner asked for', () => {
    assert.ok(PRODUCT_HEIGHT_SHARE >= PRODUCT_HEIGHT_MIN && PRODUCT_HEIGHT_SHARE <= PRODUCT_HEIGHT_MAX)
    assert.equal(PRODUCT_HEIGHT_MIN, 0.52)
    assert.equal(PRODUCT_HEIGHT_MAX, 0.55)
    assert.equal(PRODUCT_HEIGHT_SHARE, 0.53)
  })

  test('an ordinary product lands inside 52-55% of the canvas height', () => {
    // The rejected result measured about 20%. This is the assertion that would
    // have caught it.
    for (const p of PRODUCTS) {
      const plan = planPadding(p)
      if (plan.widthLimited) continue    // covered separately below
      assert.ok(
        plan.heightShare >= PRODUCT_HEIGHT_MIN && plan.heightShare <= PRODUCT_HEIGHT_MAX,
        `${p.name}: ${(plan.heightShare * 100).toFixed(1)}%`,
      )
    }
  })

  test('the product is much bigger than the rejected result was', () => {
    // Stated as a floor rather than a range: whatever else changes, a chair
    // must never come back at a fifth of the frame again.
    const plan = planPadding({ width: 900, height: 1200 })
    assert.ok(plan.heightShare > 0.4, `${plan.heightShare} is back in rejected territory`)
  })

  test('nothing is stretched: one scale, both axes', () => {
    for (const p of PRODUCTS) {
      const plan = planPadding(p)
      const before = p.width / p.height
      const after = plan.product.width / plan.product.height
      assert.ok(Math.abs(before - after) / before < 0.01,
        `${p.name}: ${before.toFixed(3)} became ${after.toFixed(3)}`)
    }
  })

  test('the same cut-out size always plans the same padding', () => {
    // No randomness and no state: two identical photographs must produce two
    // identical requests, or the framing is not repeatable.
    assert.deepEqual(planPadding({ width: 900, height: 1200 }), planPadding({ width: 900, height: 1200 }))
  })
})

describe('horizontal centring', () => {
  test('the side padding is equal, or differs by the one pixel that cannot split', () => {
    for (const p of PRODUCTS) {
      const plan = planPadding(p)
      assert.ok(Math.abs(plan.padding.left - plan.padding.right) <= 1,
        `${p.name}: ${plan.padding.left} vs ${plan.padding.right}`)
    }
  })

  test('an odd product width still centres, and still closes on the canvas', () => {
    for (const width of [301, 302, 303, 304, 305]) {
      const plan = planPadding({ width, height: 1200 })
      assert.ok(Math.abs(plan.padding.left - plan.padding.right) <= 1)
      assert.equal(plan.padding.left + plan.product.width + plan.padding.right, MASTER_WIDTH)
    }
  })

  test('the product centre sits on the canvas centre, within half a pixel', () => {
    for (const p of PRODUCTS) {
      const plan = planPadding(p)
      const centre = plan.padding.left + plan.product.width / 2
      assert.ok(Math.abs(centre - MASTER_WIDTH / 2) <= 0.5, `${p.name}: centre at ${centre}`)
    }
  })
})

describe('a product wider than the frame', () => {
  test('a long sideboard is contained, never cropped', () => {
    // At 53% of the height a 3:1 product is 1590px wide on a 1000px canvas.
    // Without the width limit the padding would be negative, and Bria would
    // either refuse the request or cut the ends off.
    const plan = planPadding({ width: 2400, height: 800 })

    assert.ok(plan.padding.left >= 0 && plan.padding.right >= 0)
    assert.ok(plan.product.width <= MASTER_WIDTH)
    assert.equal(plan.widthLimited, true)
  })

  test('no product of any shape ever asks for negative padding', () => {
    for (const width of [100, 500, 1000, 2000, 4000, 8000]) {
      for (const height of [100, 500, 1000, 2000, 4000, 8000]) {
        const plan = planPadding({ width, height })
        for (const [side, value] of Object.entries(plan.padding)) {
          assert.ok(value >= 0, `${width}x${height}: ${side} padding ${value}`)
        }
      }
    }
  })

  test('a contained product keeps a real margin at both sides', () => {
    const plan = planPadding({ width: 2400, height: 800 })
    const margin = Math.min(plan.padding.left, plan.padding.right)
    assert.ok(margin >= MASTER_WIDTH * SIDE_MARGIN_SHARE - 1, `only ${margin}px of margin`)
  })

  test('being width-limited means shorter than the target, and it is admitted', () => {
    // The honest consequence: a very wide piece cannot be 53% tall AND whole on
    // a square canvas. It comes back whole, and the plan says why.
    const plan = planPadding({ width: 2400, height: 800 })
    assert.ok(plan.heightShare < PRODUCT_HEIGHT_MIN)
    assert.equal(plan.widthLimited, true)
  })

  test('a tall narrow product is height-limited, not width-limited', () => {
    const plan = planPadding({ width: 260, height: 1400 })
    assert.equal(plan.widthLimited, false)
    assert.ok(Math.abs(plan.heightShare - PRODUCT_HEIGHT_SHARE) < 0.005)
  })

  test('the two limits meet without a jump at the crossover', () => {
    const crossover = (MASTER_WIDTH * (1 - 2 * SIDE_MARGIN_SHARE)) / (MASTER_HEIGHT * PRODUCT_HEIGHT_SHARE)
    const under = planPadding({ width: Math.round(1000 * crossover) - 8, height: 1000 })
    const over  = planPadding({ width: Math.round(1000 * crossover) + 8, height: 1000 })

    assert.ok(Math.abs(under.product.height - over.product.height) <= 5,
      `${under.product.height} then ${over.product.height}`)
  })
})

describe('the padding values sent to Bria', () => {
  test('the order is [left, right, top, bottom], as the schema says', () => {
    // Getting this wrong would not fail — it would quietly put the chair in the
    // wrong place, which is exactly the class of defect this whole change is about.
    const plan = planPadding({ width: 900, height: 1200 })
    assert.deepEqual(plan.paddingValues, [
      plan.padding.left, plan.padding.right, plan.padding.top, plan.padding.bottom,
    ])
  })

  test('there is more space above the product than below it', () => {
    // Furniture stands on a floor. The approved composition put 21% above and
    // 14% below, and that ratio is kept while the extra space a smaller product
    // frees goes to both, which is what leaves room to crop.
    for (const p of PRODUCTS) {
      const plan = planPadding(p)
      assert.ok(plan.padding.top > plan.padding.bottom, `${p.name}`)
    }
  })

  test('there is room to crop on every side', () => {
    // The product owner asked for surrounding background to crop from later.
    // A margin measured in single pixels would not be croppable.
    for (const p of PRODUCTS) {
      const plan = planPadding(p)
      for (const [side, value] of Object.entries(plan.padding)) {
        assert.ok(value >= 50, `${p.name}: only ${value}px ${side} to crop into`)
      }
    }
  })

  test('all four values are whole pixels', () => {
    for (const p of PRODUCTS) {
      for (const value of planPadding(p).paddingValues) {
        assert.equal(Number.isInteger(value), true, `${p.name}: ${value}`)
      }
    }
  })

  test('the total including padding is the megapixel Bria asks for', () => {
    for (const p of PRODUCTS) {
      const plan = planPadding(p)
      const total = (plan.padding.left + plan.product.width + plan.padding.right)
        * (plan.padding.top + plan.product.height + plan.padding.bottom)
      assert.equal(total, 1_000_000, p.name)
    }
  })
})

describe('the quality gate', () => {
  test('a product photographed large enough passes, and is being reduced', () => {
    const verdict = checkEnlargement({ width: 900, height: 1200 })
    assert.equal(verdict.ok, true)
    assert.ok(verdict.scale < 1)
  })

  test('a product too small to fill the master is refused, not blurred', () => {
    const verdict = checkEnlargement({ width: 120, height: 160 })
    assert.equal(verdict.ok, false)
    if (verdict.ok) return
    assert.match(verdict.message, /too small/i)
  })

  test('exactly at the cap passes; past it does not', () => {
    const height = Math.round((MASTER_HEIGHT * PRODUCT_HEIGHT_SHARE) / MAX_ENLARGEMENT)
    assert.equal(checkEnlargement({ width: 10, height: height + 2 }).ok, true)
    assert.equal(checkEnlargement({ width: 10, height: height - 6 }).ok, false)
  })

  test('the refusal names the height that would have worked', () => {
    const verdict = checkEnlargement({ width: 120, height: 160 })
    assert.equal(verdict.ok, false)
    if (verdict.ok) return
    // And that height does indeed pass.
    assert.equal(checkEnlargement({ width: 90, height: verdict.needed }).ok, true)
  })

  test('a smaller target is a more forgiving gate than the old one', () => {
    // Worth stating: the product is 53% of the canvas now rather than 65%, so a
    // photograph that used to be refused may now be fine. Nothing was loosened
    // — the cap is the same 1.15x — the frame simply asks for less.
    const needed = Math.ceil((MASTER_HEIGHT * PRODUCT_HEIGHT_SHARE) / MAX_ENLARGEMENT)
    assert.ok(needed < 570, `a product must be ${needed}px tall, which is stricter than expected`)
  })

  test('the message names no provider, model or endpoint', () => {
    const verdict = checkEnlargement({ width: 60, height: 80 })
    assert.equal(verdict.ok, false)
    if (verdict.ok) return
    for (const word of ['fal', 'bria', 'api', 'http', 'model', 'endpoint', 'credit', 'padding']) {
      assert.ok(!verdict.message.toLowerCase().includes(word), `${word} in: ${verdict.message}`)
    }
  })

  test('the gate and the plan agree about the scale', () => {
    for (const p of PRODUCTS) {
      assert.equal(checkEnlargement(p).scale, fitScale(p), p.name)
      assert.equal(planPadding(p).scale, fitScale(p), p.name)
    }
  })
})
