/**
 * Which attendance months exist, and what "no rows" is allowed to mean.
 *
 * The rule under test is a distinction, not a lookup: a month nobody has
 * uploaded and a month where somebody was absent both produce zero rows for
 * that employee, and only one of them may be shown as an absence. Getting this
 * backwards either invents absences that never happened or hides real ones.
 *
 * Dates are injected rather than read from the clock, so these assertions mean
 * the same thing in December as in August.
 *
 * Run:
 *   npx tsx --test src/lib/attendance/monthAvailability.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  istCurrentYearMonth,
  isFutureMonth,
  selectableMonths,
  selectableMonthsInYear,
  selectableYears,
  monthNotImportedMessage,
  MONTH_NOT_IMPORTED_TITLE,
} from './monthAvailability'

/** 8 August 2026, 12:30 IST — the situation the acceptance test described. */
const AUG_2026 = new Date('2026-08-08T07:00:00Z')

describe('istCurrentYearMonth', () => {
  test('reads the month in IST, not in the runner timezone', () => {
    assert.deepEqual(istCurrentYearMonth(AUG_2026), { year: 2026, month: 8 })
  })

  test('late-evening UTC is already the next IST day, and can be the next month', () => {
    // 31 Jul 2026 20:00 UTC is 1 Aug 01:30 IST.
    assert.deepEqual(istCurrentYearMonth(new Date('2026-07-31T20:00:00Z')), { year: 2026, month: 8 })
  })

  test('just before the IST rollover it is still the earlier month', () => {
    // 31 Jul 2026 18:00 UTC is 31 Jul 23:30 IST.
    assert.deepEqual(istCurrentYearMonth(new Date('2026-07-31T18:00:00Z')), { year: 2026, month: 7 })
  })
})

describe('isFutureMonth — a future month can hold no attendance', () => {
  test('the current month is not future', () => {
    assert.equal(isFutureMonth(2026, 8, AUG_2026), false)
  })

  test('every later month of this year is future', () => {
    for (const m of [9, 10, 11, 12]) {
      assert.equal(isFutureMonth(2026, m, AUG_2026), true, `2026-${m}`)
    }
  })

  test('any month of a later year is future', () => {
    assert.equal(isFutureMonth(2027, 1, AUG_2026), true)
  })

  test('past months and past years are not future', () => {
    for (const m of [1, 2, 3, 4, 5, 6, 7]) {
      assert.equal(isFutureMonth(2026, m, AUG_2026), false, `2026-${m}`)
    }
    assert.equal(isFutureMonth(2025, 12, AUG_2026), false)
  })
})

describe('the picker cannot offer a month that has not started', () => {
  test('the current year stops at the current month', () => {
    assert.deepEqual(selectableMonthsInYear(2026, AUG_2026), [1, 2, 3, 4, 5, 6, 7, 8])
  })

  test('a past year offers all twelve', () => {
    assert.deepEqual(selectableMonthsInYear(2025, AUG_2026), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  test('a future year offers nothing at all', () => {
    assert.deepEqual(selectableMonthsInYear(2027, AUG_2026), [])
  })

  test('years are bounded and newest first', () => {
    assert.deepEqual(selectableYears(AUG_2026, 2), [2026, 2025, 2024])
  })

  test('no selectable month is ever a future month', () => {
    for (const { year, month } of selectableMonths(AUG_2026, 2)) {
      assert.equal(isFutureMonth(year, month, AUG_2026), false, `${year}-${month} must not be offered`)
    }
  })

  test('the newest option is the current month, and September is absent', () => {
    const all = selectableMonths(AUG_2026, 2)
    assert.deepEqual(all[0], { year: 2026, month: 8 })
    assert.equal(
      all.some(x => x.year === 2026 && x.month === 9), false,
      'September 2026 must not be offered in August 2026',
    )
  })

  test('in January the current year offers only January', () => {
    const jan = new Date('2026-01-05T07:00:00Z')
    assert.deepEqual(selectableMonthsInYear(2026, jan), [1])
    assert.deepEqual(selectableMonths(jan, 1)[0], { year: 2026, month: 1 })
  })
})

describe('the not-uploaded empty state names the month', () => {
  test('the message is specific rather than generic', () => {
    const msg = monthNotImportedMessage('August 2026')
    assert.match(msg, /August 2026/)
    assert.match(msg, /has not been uploaded/i)
  })

  test('the title does not say "absent"', () => {
    assert.equal(/absent/i.test(MONTH_NOT_IMPORTED_TITLE), false)
    assert.match(MONTH_NOT_IMPORTED_TITLE, /not uploaded/i)
  })
})
