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
  istToday,
  isFutureMonth,
  attendanceCoverageThrough,
  withinCoverage,
  selectableMonths,
  selectableMonthsInYear,
  selectableYears,
  monthNotImportedMessage,
  coverageNoticeMessage,
  MONTH_NOT_IMPORTED_TITLE,
} from './monthAvailability'
import { workingDatesInMonth } from './monthCalendar'

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

// ─── The current-month cut-off ────────────────────────────────────────────────
//
// The acceptance case, verbatim: it is 8 August 2026 and the attendance import
// has only reached 5 August. The 6th and 7th are working days nobody has
// processed; the 9th onwards have not happened. None of them is an absence, and
// a month-level "imported" flag cannot tell any of them apart.

describe('istToday reads the IST calendar date', () => {
  test('midday IST', () => {
    assert.equal(istToday(AUG_2026), '2026-08-08')
  })

  test('late-evening UTC is already tomorrow in IST', () => {
    assert.equal(istToday(new Date('2026-08-08T19:00:00Z')), '2026-08-09')
  })
})

describe('attendanceCoverageThrough — how far a month may be classified', () => {
  test('1. nothing imported means nothing may be classified, current month or not', () => {
    assert.equal(attendanceCoverageThrough(2026, 8, null, AUG_2026), null)
    assert.equal(attendanceCoverageThrough(2026, 5, null, AUG_2026), null)
  })

  test('2. the current month stops at the latest imported date', () => {
    assert.equal(attendanceCoverageThrough(2026, 8, '2026-08-05', AUG_2026), '2026-08-05')
  })

  test('3. unprocessed days between the import and today are outside the cut-off', () => {
    const cut = attendanceCoverageThrough(2026, 8, '2026-08-05', AUG_2026)!
    for (const d of ['2026-08-06', '2026-08-07', '2026-08-08']) {
      assert.ok(d > cut, `${d} must fall outside a cut-off of ${cut}`)
    }
  })

  test('4. a future date can never be inside the cut-off', () => {
    // Even a machine file carrying a stray future row is capped at today.
    assert.equal(attendanceCoverageThrough(2026, 8, '2026-08-31', AUG_2026), '2026-08-08')
    const cut = attendanceCoverageThrough(2026, 8, '2026-08-05', AUG_2026)!
    for (let d = 9; d <= 31; d++) {
      assert.ok(`2026-08-${String(d).padStart(2, '0')}` > cut, `${d} Aug must be outside the cut-off`)
    }
  })

  test('5. a historical imported month keeps the whole calendar', () => {
    assert.equal(attendanceCoverageThrough(2026, 7, '2026-07-21', AUG_2026), '2026-07-31')
    assert.equal(attendanceCoverageThrough(2026, 2, '2026-02-03', AUG_2026), '2026-02-28')
    assert.equal(attendanceCoverageThrough(2025, 12, '2025-12-02', AUG_2026), '2025-12-31')
  })

  test('a month that has not started is never covered, imported rows or not', () => {
    assert.equal(attendanceCoverageThrough(2026, 9, '2026-09-01', AUG_2026), null)
    assert.equal(attendanceCoverageThrough(2027, 1, '2027-01-04', AUG_2026), null)
  })

  test('an import that has caught up with today covers today', () => {
    assert.equal(attendanceCoverageThrough(2026, 8, '2026-08-08', AUG_2026), '2026-08-08')
  })
})

describe('withinCoverage — which dates the response may speak for', () => {
  const AUGUST = workingDatesInMonth(2026, 8)

  test('3. days after the imported-through date are dropped, not returned as absent', () => {
    const covered = withinCoverage(AUGUST, attendanceCoverageThrough(2026, 8, '2026-08-05', AUG_2026))
    // 1 Aug 2026 is a Saturday, which BOE works; 2 Aug is the Sunday off.
    assert.deepEqual(covered, ['2026-08-01', '2026-08-03', '2026-08-04', '2026-08-05'])
    for (const d of covered) assert.ok(d <= '2026-08-05')
  })

  test('4. no future date survives the filter', () => {
    const covered = withinCoverage(AUGUST, attendanceCoverageThrough(2026, 8, '2026-08-05', AUG_2026))
    for (const d of covered) {
      assert.ok(d <= istToday(AUG_2026), `${d} is in the future and must not be classifiable`)
    }
  })

  test('1. an unimported month yields no dates at all', () => {
    assert.deepEqual(withinCoverage(AUGUST, attendanceCoverageThrough(2026, 8, null, AUG_2026)), [])
  })

  test('5. a historical month is untouched — every working day survives', () => {
    const july = workingDatesInMonth(2026, 7)
    const covered = withinCoverage(july, attendanceCoverageThrough(2026, 7, '2026-07-21', AUG_2026))
    assert.deepEqual(covered, july, 'a finished month must keep the full calendar')
    assert.ok(covered.includes('2026-07-21'), 'the 21 July case must keep working')
    assert.ok(covered.includes('2026-07-31'), 'including days after the last punch anyone made')
  })

  test('holidays and Sundays are still the calendar\'s business, not the cut-off\'s', () => {
    const withHoliday = workingDatesInMonth(2026, 8, { holidays: ['2026-08-04'] })
    const covered = withinCoverage(withHoliday, attendanceCoverageThrough(2026, 8, '2026-08-05', AUG_2026))
    assert.deepEqual(covered, ['2026-08-01', '2026-08-03', '2026-08-05'])
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

  test('the partly-uploaded notice names the cut-off and denies the absence reading', () => {
    const msg = coverageNoticeMessage('05 Aug, Wed')
    assert.match(msg, /05 Aug, Wed/)
    assert.match(msg, /none of them count as an absence/i)
  })
})
