/**
 * THE ADVANCE FORMULA — the 40% is taken of the Total before GST.
 *
 * Pure functions. No database, no network.
 *
 * Run:
 *   node node_modules/tsx/dist/cli.mjs --test src/lib/orders/advanceFormula.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  ADVANCE_UNAVAILABLE,
  STANDARD_ADVANCE_PERCENT,
  advanceBase,
  advancePercent,
  advancePercentLabel,
  advanceShortfall,
  meetsStandardAdvance,
  requiredAdvance,
  totalBeforeGstFromParts,
} from './advanceFormula'

// Product 1,00,000 − discount 10,000 = subtotal 90,000; + fabric 20,000 +
// packaging 5,000 + quoted transport 5,000 = 1,20,000 before GST; GST 18% =
// 21,600; Grand Total 1,41,600.
const EXAMPLE = {
  subtotal: 90000, fabric: 20000, packaging: 5000, transportation: 5000,
  totalBeforeGst: 120000, gst: 21600, grandTotal: 141600,
}

describe('the worked example', () => {
  test('the parts add up to the Total before GST, and GST on top gives the Grand Total', () => {
    const built = totalBeforeGstFromParts(EXAMPLE)
    assert.equal(built?.total, '120000')
    assert.equal(Number(built?.total) + EXAMPLE.gst, EXAMPLE.grandTotal)
  })

  test('₹48,000 verified is exactly 40% of ₹1,20,000, and the requirement is ₹48,000', () => {
    assert.equal(advancePercent(48000, EXAMPLE.totalBeforeGst), '40.00')
    assert.equal(requiredAdvance(EXAMPLE.totalBeforeGst), '48000.00')
    assert.equal(advanceShortfall(48000, EXAMPLE.totalBeforeGst), '0.00')
    assert.equal(meetsStandardAdvance(48000, EXAMPLE.totalBeforeGst), true)
    assert.equal(advancePercentLabel(48000, EXAMPLE.totalBeforeGst), '40%')
  })

  test('the Grand Total is NOT the denominator: against it ₹48,000 would be short', () => {
    assert.equal(advancePercent(48000, EXAMPLE.grandTotal), '33.89')
    assert.equal(meetsStandardAdvance(48000, EXAMPLE.grandTotal), false)
    assert.equal(requiredAdvance(EXAMPLE.grandTotal), '56640.00')
  })

  test('the product value alone is NOT the denominator either', () => {
    assert.equal(requiredAdvance(100000), '40000.00')
    assert.notEqual(requiredAdvance(EXAMPLE.totalBeforeGst), requiredAdvance(100000))
  })
})

describe('below, at and above 40%', () => {
  const base = EXAMPLE.totalBeforeGst
  test('one paisa below is below, and the shortfall is that paisa', () => {
    assert.equal(meetsStandardAdvance('47999.99', base), false)
    assert.equal(advanceShortfall('47999.99', base), '0.01')
    // Truncated, never rounded up: 39.99991…% must not read 40%.
    assert.equal(advancePercent('47999.99', base), '39.99')
  })
  test('at is met', () => {
    assert.equal(meetsStandardAdvance('48000.00', base), true)
  })
  test('above is met and is not capped', () => {
    assert.equal(meetsStandardAdvance(60000, base), true)
    assert.equal(advancePercent(60000, base), '50.00')
    assert.equal(advancePercent(144000, base), '120.00')
  })
  test('the shortfall is rounded UP to a payable figure', () => {
    // 40% of 100.01 = 40.004; 40.00 verified is still short by a paisa.
    assert.equal(requiredAdvance('100.01'), '40.01')
    assert.equal(advanceShortfall('40.00', '100.01'), '0.01')
    assert.equal(meetsStandardAdvance('40.00', '100.01'), false)
  })
})

describe('a missing, zero or unreadable base is unavailable, never a number', () => {
  const bad = [null, undefined, '', 0, '0', '0.00', -5, 'abc', NaN, Infinity]
  for (const base of bad) {
    test(`base ${String(base)}`, () => {
      assert.equal(advanceBase(base as never), null)
      assert.equal(advancePercent(48000, base as never), null)
      assert.equal(requiredAdvance(base as never), null)
      assert.equal(advanceShortfall(48000, base as never), null)
      assert.equal(meetsStandardAdvance(48000, base as never), false)
      assert.equal(advancePercentLabel(48000, base as never), ADVANCE_UNAVAILABLE)
    })
  }
  test('nothing ever renders NaN or Infinity', () => {
    for (const base of bad) {
      assert.ok(!/NaN|Infinity/.test(advancePercentLabel(48000, base as never)))
    }
  })
})

describe('the numerator', () => {
  test('an unreadable or negative verified figure is nothing received, not an error', () => {
    assert.equal(advancePercent(null, 120000), '0.00')
    assert.equal(advancePercent('x', 120000), '0.00')
    assert.equal(advancePercent(-10, 120000), '0.00')
    assert.equal(meetsStandardAdvance(null, 120000), false)
  })
  test('only what the caller passes counts: pending money is never in the sum here', () => {
    const verified = 30000 // a further 18,000 pending is simply not passed in
    assert.equal(advancePercent(verified, 120000), '25.00')
    assert.equal(meetsStandardAdvance(verified, 120000), false)
  })
})

describe('the parts', () => {
  test('zero discount', () => {
    const built = totalBeforeGstFromParts({ subtotal: 100000, fabric: 20000, packaging: 5000, transportation: 5000 })
    assert.equal(built?.total, '130000')
  })
  test('a missing fabric amount is absent, not a recorded zero', () => {
    const built = totalBeforeGstFromParts({ subtotal: 90000, packaging: 5000, transportation: 5000 })
    assert.equal(built?.total, '100000')
    assert.deepEqual(built?.recorded, { fabric: false, packaging: true, transportation: true })
  })
  test('transportation "as applicable" has no amount and adds nothing', () => {
    const built = totalBeforeGstFromParts({ subtotal: 90000, fabric: 20000, packaging: 5000, transportation: 'as applicable' })
    assert.equal(built?.total, '115000')
    assert.equal(built?.recorded.transportation, false)
  })
  test('a client-supplied fabric with a recorded amount is still included', () => {
    const built = totalBeforeGstFromParts({ subtotal: 90000, fabric: 20000 })
    assert.equal(built?.total, '110000')
    assert.equal(built?.recorded.fabric, true)
  })
  test('no subtotal, no total', () => {
    assert.equal(totalBeforeGstFromParts({ subtotal: null, fabric: 20000 }), null)
  })
})

test('the standard percentage is the single 40 the database also uses', () => {
  assert.equal(STANDARD_ADVANCE_PERCENT, 40)
})
