/**
 * Whole-rupee arithmetic.
 *
 *   npx tsx --test src/lib/payroll/money.test.ts
 *
 * The two cases that actually bite are negatives and float noise.
 *
 * Math.round(-10.5) is -10 in JavaScript, because it rounds toward +Infinity.
 * Payroll has money on both sides of zero — an advance recovery, a negative
 * closing balance — so a rule that rounds -10.50 to -10 and 10.50 to 11 loses a
 * rupee somewhere an employee can find it.
 *
 * And IEEE 754 cannot hold most decimal fractions, so a value that is
 * mathematically 1234.5 can arrive as 1234.4999999999998 and round DOWN. That is
 * a rupee lost to representation rather than to policy, and it is exactly the
 * kind of defect that never reproduces on the number you test with.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { roundRupees, sumRupees, isWholeRupees, formatRupees } from './money'

describe('roundRupees — half-up, positive', () => {
  test('below half rounds down', () => {
    assert.equal(roundRupees(10.49), 10)
    assert.equal(roundRupees(10.01), 10)
    assert.equal(roundRupees(0.499), 0)
  })

  test('exactly half rounds up', () => {
    assert.equal(roundRupees(10.50), 11)
    assert.equal(roundRupees(0.5), 1)
    assert.equal(roundRupees(2578.5), 2579)
  })

  test('above half rounds up', () => {
    assert.equal(roundRupees(10.51), 11)
    assert.equal(roundRupees(10.999), 11)
  })

  test('a whole rupee is unchanged', () => {
    assert.equal(roundRupees(0), 0)
    assert.equal(roundRupees(1), 1)
    assert.equal(roundRupees(26_000), 26_000)
  })
})

describe('roundRupees — half-up, negative, away from zero', () => {
  test('exactly half rounds AWAY from zero, unlike Math.round', () => {
    // The whole reason this helper exists rather than a bare Math.round.
    assert.equal(Math.round(-10.5), -10)   // what JavaScript does
    assert.equal(roundRupees(-10.5), -11)  // what payroll needs
  })

  test('below half rounds toward zero', () => {
    assert.equal(roundRupees(-10.49), -10)
    // Normalised to +0, not -0 — see the -0 test below. assert.equal is
    // Object.is-strict here, so this distinction is real and worth pinning.
    assert.equal(roundRupees(-0.499), 0)
  })

  test('above half rounds away from zero', () => {
    assert.equal(roundRupees(-10.51), -11)
  })

  test('a deduction and a recovery of the same size round to the same magnitude', () => {
    for (const v of [10.5, 235.5, 2578.5, 0.5]) {
      assert.equal(
        Math.abs(roundRupees(-v)), roundRupees(v),
        `${v} and -${v} must round to the same magnitude`,
      )
    }
  })

  test('a zeroed negative does not serialise as -0', () => {
    const r = roundRupees(-0.2)
    assert.equal(Object.is(r, -0), false)
    assert.equal(JSON.stringify({ r }), '{"r":0}')
  })
})

describe('roundRupees — floating point', () => {
  test('representation noise below half still rounds down', () => {
    assert.equal(roundRupees(0.1 + 0.2), 0)          // 0.30000000000000004
    assert.equal(roundRupees(10.000000000001), 10)
  })

  test('a value that is mathematically half rounds UP despite arriving low', () => {
    // 1234.4999999999998 is what 1234.5 can become after a few operations.
    assert.equal(roundRupees(1234.4999999999998), 1235)
    assert.equal(roundRupees(2578.499999999999), 2579)
    // A bare Math.round would have lost that rupee.
    assert.equal(Math.round(1234.4999999999998), 1234)
  })

  test('a real per-hour rate rounds the way the payslip says', () => {
    // 26,000 ÷ 26 ÷ 8.5 = 117.6470588…  ×2h = 235.2941176…
    const perHour = 26_000 / 26 / 8.5
    assert.equal(roundRupees(perHour * 2), 235)
    assert.equal(roundRupees(perHour), 118)
  })

  test('a non-finite amount is refused rather than silently becoming 0', () => {
    assert.throws(() => roundRupees(NaN))
    assert.throws(() => roundRupees(Infinity))
    assert.throws(() => roundRupees(-Infinity))
  })
})

describe('sumRupees', () => {
  test('sums whole amounts', () => {
    assert.equal(sumRupees([]), 0)
    assert.equal(sumRupees([235, 1000, 500]), 1735)
    assert.equal(sumRupees([-500, 800]), 300)
  })

  test('refuses un-rounded input, so paise cannot re-enter one layer up', () => {
    assert.throws(() => sumRupees([235.29, 1000]), /whole rupees/)
  })

  test('the sum of rounded lines is what a payslip must show', () => {
    // The defect this rule fixes: three lines whose true values are 235.29,
    // 1000.00 and 500.00. Rounding the TOTAL gives 1735 while the printed lines
    // read 235 + 1000 + 500 = 1735 — here they agree, but the general case does
    // not, which is why the total is built from the lines.
    const raw = [235.294117, 1000, 500.4]
    const lines = raw.map(roundRupees)
    assert.deepEqual(lines, [235, 1000, 500])
    assert.equal(sumRupees(lines), 1735)
    // Rounding the raw total instead would have produced 1736 — a total that no
    // combination of the printed lines can produce.
    assert.equal(roundRupees(raw.reduce((a, b) => a + b, 0)), 1736)
    assert.notEqual(sumRupees(lines), roundRupees(raw.reduce((a, b) => a + b, 0)))
  })
})

describe('isWholeRupees', () => {
  test('recognises whole and fractional amounts', () => {
    assert.equal(isWholeRupees(0), true)
    assert.equal(isWholeRupees(-500), true)
    assert.equal(isWholeRupees(235.29), false)
    assert.equal(isWholeRupees(NaN), false)
    assert.equal(isWholeRupees(Infinity), false)
  })
})

describe('formatRupees', () => {
  test('uses Indian digit grouping and no decimals', () => {
    assert.equal(formatRupees(1000), '₹1,000')
    assert.equal(formatRupees(123456), '₹1,23,456')
    assert.equal(formatRupees(26000), '₹26,000')
    assert.equal(formatRupees(0), '₹0')
  })

  test('a negative keeps its sign in front of the symbol', () => {
    assert.equal(formatRupees(-500), '-₹500')
    assert.equal(formatRupees(-123456), '-₹1,23,456')
  })

  test('paise that somehow reach the UI still render whole', () => {
    assert.equal(formatRupees(235.294117), '₹235')
    assert.equal(formatRupees(10.5), '₹11')
  })

  test('no formatted amount ever contains a decimal point', () => {
    for (const v of [0, 1, 10.5, -10.5, 235.294117, 1234567.89]) {
      assert.doesNotMatch(formatRupees(v), /\./, `${v} formatted with a decimal`)
    }
  })
})
