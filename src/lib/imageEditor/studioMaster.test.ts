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
  test('it is square, 1440 x 1440', () => {
    // Larger than the 1000 it was: the product is composited locally now, so
    // there is no provider megapixel guidance to sit under, and the photograph's
    // own resolution stops being thrown away. At 1000 a 1152px product was
    // resampled down to 530 before anything else happened to it.
    assert.equal(MASTER_WIDTH, 1440)
    assert.equal(MASTER_HEIGHT, 1440)
  })

  test('the approved targets fall out of the shares exactly', () => {
    assert.equal(Math.round(MASTER_HEIGHT * PRODUCT_HEIGHT_SHARE), 763)
    assert.equal(Math.round(MASTER_WIDTH * (1 - 2 * SIDE_MARGIN_SHARE)), 1267)
    assert.equal(Math.round(MASTER_WIDTH / 2), 720)
  })

  test('every product lands on exactly that canvas', () => {
    // Under manual_padding the canvas IS cut-out plus padding, so if these do
    // not close exactly the master is not 1000 x 1000 and nothing downstream
    // would say so.
    for (const p of PRODUCTS) {
      const plan = planPadding(p)
      assert.equal(plan.padding.left + plan.product.width + plan.padding.right, MASTER_WIDTH, p.name)
      assert.equal(plan.padding.top + plan.product.height + plan.padding.bottom, MASTER_HEIGHT, p.name)
      assert.deepEqual(plan.canvas, { width: 1440, height: 1440 }, p.name)
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

  test('the padded total is exactly the master', () => {
    for (const p of PRODUCTS) {
      const plan = planPadding(p)
      const total = (plan.padding.left + plan.product.width + plan.padding.right)
        * (plan.padding.top + plan.product.height + plan.padding.bottom)
      assert.equal(total, MASTER_WIDTH * MASTER_HEIGHT, p.name)
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

  test('the cap was re-measured for the 1440 master, not carried over', () => {
    // 1440 asks for a 763px product where 1000 asked for 530. Detail retained
    // against a native render, on a subject with 1px spindles:
    // 1.20x 80.8%, 1.25x 78.6%, 1.30x 77.7%, 1.50x 72.1%, 1.75x 63.3%.
    assert.equal(MAX_ENLARGEMENT, 1.30)
    // 1440 x 0.53 is 763.2 before it is rounded to a placed 763, and the gate
    // works from the unrounded target, so the smallest usable source is 588.
    const needed = Math.ceil((MASTER_HEIGHT * PRODUCT_HEIGHT_SHARE) / MAX_ENLARGEMENT)
    assert.equal(needed, 588, `a product must be ${needed}px tall`)
  })

  test('THE IRVINE REGRESSION: the real acceptance-test source is accepted', () => {
    // The cut-out the approved result was built from, measured from a real run:
    //   product 549 x 609
    // Reaching 763 from 609 is 1.253x. A cap of 1.20 — or 1.25 — refuses the
    // exact photograph BOE signed the look off against, which is a gate that
    // rejects its own reference subject.
    const IRVINE = { width: 549, height: 609 }

    const verdict = checkEnlargement(IRVINE)
    assert.equal(verdict.ok, true, 'the Irvine source must be accepted')
    assert.ok(Math.abs(verdict.scale - 1.253) < 0.002, `scale came out ${verdict.scale.toFixed(4)}`)

    // And it is the HEIGHT that binds, not the width — 549 wide has room to spare.
    const plan = planPadding(IRVINE)
    assert.equal(plan.widthLimited, false)
    assert.equal(plan.product.height, 763)
    assert.ok(Math.abs(plan.heightShare - PRODUCT_HEIGHT_SHARE) < 0.005)
  })

  test('severe enlargement is still refused', () => {
    // The gate was raised, not removed. Anything past 1.30 is still an honest
    // refusal rather than a soft catalogue image.
    for (const height of [587, 550, 500, 400, 300]) {
      const scale = (MASTER_HEIGHT * PRODUCT_HEIGHT_SHARE) / height
      assert.ok(scale > MAX_ENLARGEMENT, `${height}px should need more than the cap`)
      assert.equal(checkEnlargement({ width: 500, height }).ok, false,
        `a ${height}px product must be refused (${scale.toFixed(3)}x)`)
    }
  })

  test('the boundary is exactly where the cap says it is', () => {
    assert.equal(checkEnlargement({ width: 500, height: 588 }).ok, true, '588px is the first accepted')
    assert.equal(checkEnlargement({ width: 500, height: 587 }).ok, false, '587px is the last refused')
  })

  test('the cap may not drift upwards', () => {
    // Past 1.30 the gate stops protecting anything: the measured curve falls
    // away fastest between 1.5 and 1.75, reaching 63% retention.
    assert.ok(MAX_ENLARGEMENT <= 1.30, 'the cap must not be raised above 1.30')
    assert.ok(MAX_ENLARGEMENT >= 1.25, 'below 1.25 the real Irvine source is refused')
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
