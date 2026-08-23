/**
 * Exact money arithmetic.
 *
 * WHAT THIS FILE PROVES
 * ---------------------
 * That the Order screen's totals are EXACT — that they are the same strings the
 * database's `numeric` would produce, not the nearest double to them. The
 * headline case is the one that motivated the module: a set of amounts whose
 * float sum is provably wrong, summed here and coming out right.
 *
 * It also pins the two decisions that are easy to get quietly wrong: an
 * unreadable figure is NULL and never zero, and a percentage is TRUNCATED and
 * never rounded.
 *
 * Run:
 *   npx tsx --test src/lib/finance/exactMoney.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  ZERO,
  addExact,
  clampAtZero,
  compareExact,
  exactToNumber,
  exactToString,
  isNegative,
  isZero,
  parseExact,
  percentTrunc,
  subtractExact,
  sumExact,
} from './exactMoney'

const str = (value: string | number | null | undefined): string => {
  const parsed = parseExact(value)
  assert.ok(parsed, `expected ${JSON.stringify(value)} to parse`)
  return exactToString(parsed)
}

describe('parseExact', () => {
  test('keeps the scale the value arrived with', () => {
    assert.equal(str('400000.00'), '400000.00')
    assert.equal(str('400000.0'), '400000.0')
    assert.equal(str('400000'), '400000')
  })

  test('reads a plain numeric of any scale, not just two places', () => {
    // finance_payment_requests.amount is unconstrained `numeric` (20260628000200),
    // so a legacy row may carry more than paise and must not be truncated here.
    assert.equal(str('1234.567890'), '1234.567890')
  })

  test('reads a negative and a signed positive', () => {
    assert.equal(str('-250.75'), '-250.75')
    assert.equal(str('+250.75'), '250.75')
  })

  test('reads a bare fraction and a bare integer part', () => {
    assert.equal(str('.5'), '0.5')
    assert.equal(str('5.'), '5')
  })

  test('a figure that cannot be read is NULL, never zero', () => {
    // The distinction the whole module rests on: "we could not read this" and
    // "this is nought" are different answers on a money screen.
    for (const bad of [null, undefined, '', '   ', 'NaN', 'Infinity', '-Infinity',
                       '12abc', 'abc', '1.2.3', '--5', '.', '-', '1e5x']) {
      assert.equal(parseExact(bad as string), null, `expected ${JSON.stringify(bad)} to be null`)
    }
  })

  test('refuses a scale beyond the parser cap rather than allocating for it', () => {
    assert.equal(parseExact(`1.${'1'.repeat(31)}`), null)
    assert.ok(parseExact(`1.${'1'.repeat(30)}`))
  })

  test('accepts a JS number, including one that prints in exponent form', () => {
    assert.equal(str(400000), '400000')
    assert.equal(str(1234.5), '1234.5')
    assert.equal(str(1e21), '1000000000000000000000')
    assert.equal(str(1e-7), '0.0000001')
    assert.equal(str(-1.5e3), '-1500')
    assert.equal(parseExact(Number.NaN), null)
    assert.equal(parseExact(Number.POSITIVE_INFINITY), null)
  })
})

describe('addExact / subtractExact', () => {
  test('THE CASE THIS MODULE EXISTS FOR: a sum floats get wrong', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in binary floating point. The same three
    // rupees-and-paise figures, summed exactly, are exactly what `numeric` says.
    assert.equal(exactToString(sumExact(['0.10', '0.20'])), '0.30')
    assert.notEqual(String(0.1 + 0.2), '0.3')
  })

  test('a long run of paise stays exact where the float total drifts', () => {
    const rows = Array.from({ length: 1000 }, () => '0.07')
    assert.equal(exactToString(sumExact(rows)), '70.00')

    // The float total of the same rows is NOT 70 — which is the point.
    const floatTotal = rows.reduce((sum, r) => sum + Number(r), 0)
    assert.notEqual(floatTotal, 70)
  })

  test('adds and subtracts across different scales', () => {
    const a = parseExact('100.5')!
    const b = parseExact('0.005')!
    assert.equal(exactToString(addExact(a, b)), '100.505')
    assert.equal(exactToString(subtractExact(a, b)), '100.495')
  })

  test('survives a figure larger than Number.MAX_SAFE_INTEGER', () => {
    // Not a realistic order value; it proves nothing passes through a double.
    const big = parseExact('9007199254740993.01')!
    assert.equal(exactToString(addExact(big, parseExact('0.01')!)), '9007199254740993.02')
  })

  test('a row that cannot be read contributes nothing and does not poison the total', () => {
    assert.equal(exactToString(sumExact(['10.00', 'NaN', null, '5.50', undefined])), '15.50')
  })

  test('an empty list sums to zero', () => {
    assert.equal(exactToString(sumExact([])), '0')
    assert.ok(isZero(ZERO))
  })
})

describe('compareExact, isNegative, clampAtZero', () => {
  test('compares across scales', () => {
    assert.equal(compareExact(parseExact('1.50')!, parseExact('1.5')!), 0)
    assert.equal(compareExact(parseExact('1.50')!, parseExact('1.51')!), -1)
    assert.equal(compareExact(parseExact('1.52')!, parseExact('1.51')!), 1)
  })

  test('a pending balance never shows as negative', () => {
    // An Order overpaid by the client: total - verified is below zero, and the
    // screen must say nothing is pending rather than "-₹5,000 pending".
    assert.equal(exactToString(clampAtZero(parseExact('-5000.00')!)), '0.00')
    assert.equal(exactToString(clampAtZero(parseExact('5000.00')!)), '5000.00')
    assert.ok(isNegative(parseExact('-0.01')!))
    assert.ok(!isNegative(parseExact('0.00')!))
  })
})

describe('percentTrunc', () => {
  test('TRUNCATES and never rounds — the gate and the card must agree', () => {
    // 399,990 of 1,000,000 is 39.999%. Rounded it reads 40.00 and would print
    // "40%" beside a gate that refuses; truncated it reads 39.99 and the two
    // say the same thing. This is the rule 20260917000000 §4 states.
    const percent = percentTrunc(parseExact('399990.00')!, parseExact('1000000.00')!)
    assert.equal(exactToString(percent!), '39.99')
  })

  test('an exact 40% reads as 40.00', () => {
    const percent = percentTrunc(parseExact('400000.00')!, parseExact('1000000.00')!)
    assert.equal(exactToString(percent!), '40.00')
  })

  test('a repeating fraction truncates rather than rounding up', () => {
    // 1/3 = 33.333…%; the last kept digit must not be pushed to 33.34.
    const percent = percentTrunc(parseExact('1.00')!, parseExact('3.00')!)
    assert.equal(exactToString(percent!), '33.33')
    // 2/3 = 66.666…%, which rounds to 66.67 and truncates to 66.66.
    assert.equal(exactToString(percentTrunc(parseExact('2.00')!, parseExact('3.00')!)!), '66.66')
  })

  test('NULL when the percentage is not computable, never 0', () => {
    // "Not computable" and "nothing received" are different statements: a PI or
    // an Order with no stored total must show a dash, not 0%.
    assert.equal(percentTrunc(parseExact('100')!, null), null)
    assert.equal(percentTrunc(parseExact('100')!, parseExact('0.00')!), null)
    assert.equal(percentTrunc(parseExact('100')!, parseExact('-5.00')!), null)
  })

  test('over 100% is reported as it is, not capped', () => {
    // An overpaid Order is a real state and the figure must say so; only the
    // progress BAR is clamped, and that is a pixel quantity.
    assert.equal(exactToString(percentTrunc(parseExact('150.00')!, parseExact('100.00')!)!), '150.00')
  })

  test('honours a requested precision', () => {
    assert.equal(exactToString(percentTrunc(parseExact('1.00')!, parseExact('3.00')!, 0)!), '33')
    assert.equal(exactToString(percentTrunc(parseExact('1.00')!, parseExact('3.00')!, 4)!), '33.3333')
  })
})

describe('the formatting boundary', () => {
  test('exactToNumber is the one place a double appears', () => {
    assert.equal(exactToNumber(parseExact('1234.56')!), 1234.56)
    assert.equal(exactToNumber(ZERO), 0)
  })

  test('exactToString pads a value whose units are shorter than its scale', () => {
    assert.equal(exactToString({ units: BigInt(5), scale: 2 }), '0.05')
    assert.equal(exactToString({ units: BigInt(-5), scale: 2 }), '-0.05')
    assert.equal(exactToString({ units: BigInt(0), scale: 2 }), '0.00')
  })
})
