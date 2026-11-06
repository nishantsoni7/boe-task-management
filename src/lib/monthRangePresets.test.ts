/**
 * monthRangePresets — behavioural tests
 *
 * Run:
 *   npx tsx --test src/lib/monthRangePresets.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { MONTH_RANGE_PRESETS, resolveMonthRange, matchMonthRange } from './monthRangePresets'

describe('resolveMonthRange', () => {
  const TODAY = '2026-11-06'

  test('every preset on 6 Nov 2026', () => {
    assert.deepEqual(resolveMonthRange('this_month', TODAY),         { from: '2026-11-01', to: '2026-11-06' })
    assert.deepEqual(resolveMonthRange('last_month', TODAY),         { from: '2026-10-01', to: '2026-10-31' })
    assert.deepEqual(resolveMonthRange('last_to_last_month', TODAY), { from: '2026-09-01', to: '2026-09-30' })
    assert.deepEqual(resolveMonthRange('last_3_months', TODAY),      { from: '2026-08-01', to: '2026-10-31' })
    assert.deepEqual(resolveMonthRange('last_6_months', TODAY),      { from: '2026-05-01', to: '2026-10-31' })
  })

  test('January wraps into the previous year', () => {
    assert.deepEqual(resolveMonthRange('last_month', '2027-01-15'),         { from: '2026-12-01', to: '2026-12-31' })
    assert.deepEqual(resolveMonthRange('last_to_last_month', '2027-01-15'), { from: '2026-11-01', to: '2026-11-30' })
    assert.deepEqual(resolveMonthRange('last_6_months', '2027-01-15'),      { from: '2026-07-01', to: '2026-12-31' })
  })

  test('month lengths: February in a leap year and a common year', () => {
    assert.deepEqual(resolveMonthRange('last_month', '2028-03-10'), { from: '2028-02-01', to: '2028-02-29' })
    assert.deepEqual(resolveMonthRange('last_month', '2027-03-10'), { from: '2027-02-01', to: '2027-02-28' })
  })

  test('the first and last day of a month give the same ranges', () => {
    for (const key of MONTH_RANGE_PRESETS.map(p => p.key).filter(k => k !== 'this_month')) {
      assert.deepEqual(resolveMonthRange(key, '2026-11-01'), resolveMonthRange(key, '2026-11-30'))
    }
  })

  test('only "This month" runs to today; the rest never include the month in progress', () => {
    for (const { key } of MONTH_RANGE_PRESETS) {
      const { from, to } = resolveMonthRange(key, TODAY)
      assert.ok(from <= to)
      if (key === 'this_month') assert.equal(to, TODAY)
      else assert.ok(to < '2026-11-01')
    }
  })
})

describe('matchMonthRange', () => {
  const TODAY = '2026-11-06'

  test('a range equal to a preset reads as that preset', () => {
    for (const { key } of MONTH_RANGE_PRESETS) {
      const { from, to } = resolveMonthRange(key, TODAY)
      assert.equal(matchMonthRange(from, to, TODAY), key)
    }
  })

  test('blank, one-sided and hand-picked ranges are not a preset', () => {
    assert.equal(matchMonthRange('', '', TODAY), null)
    assert.equal(matchMonthRange('2026-10-01', '', TODAY), null)
    assert.equal(matchMonthRange('', '2026-10-31', TODAY), null)
    assert.equal(matchMonthRange('2026-10-02', '2026-10-31', TODAY), null)
  })

  test('no two presets share a range, so a match is never ambiguous', () => {
    const seen = new Set(MONTH_RANGE_PRESETS.map(({ key }) => {
      const { from, to } = resolveMonthRange(key, TODAY)
      return `${from}/${to}`
    }))
    assert.equal(seen.size, MONTH_RANGE_PRESETS.length)
  })
})
