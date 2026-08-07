/**
 * The month's working days, generated rather than observed.
 *
 * The regression these guard: a date used to exist in the attendance screens
 * only if somebody had punched on it. Everything below is a case where that is
 * wrong — and the month-boundary and cross-month cases are here so the fix
 * cannot turn out to be July-shaped.
 *
 * Run:
 *   npx tsx --test src/lib/attendance/monthCalendar.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { monthDates, monthRange, isWeeklyOff, workingDatesInMonth, nonWorkingReason } from './monthCalendar'

describe('monthDates', () => {
  test('covers every calendar day, first to last', () => {
    const july = monthDates(2026, 7)
    assert.equal(july.length, 31)
    assert.equal(july[0], '2026-07-01')
    assert.equal(july[30], '2026-07-31')
  })

  test('gets month lengths right, including February in a leap year', () => {
    assert.equal(monthDates(2026, 2).length, 28)
    assert.equal(monthDates(2028, 2).length, 29)   // leap
    assert.equal(monthDates(2026, 4).length, 30)
    assert.equal(monthDates(2026, 12).length, 31)
  })

  test('single-digit months and days are zero-padded', () => {
    assert.equal(monthDates(2026, 1)[0], '2026-01-01')
    assert.equal(monthDates(2026, 9)[8], '2026-09-09')
  })

  test('December does not roll into the next year', () => {
    const dec = monthDates(2026, 12)
    assert.equal(dec[dec.length - 1], '2026-12-31')
    assert.ok(dec.every(d => d.startsWith('2026-12-')))
  })
})

describe('monthRange', () => {
  test('is inclusive at both ends', () => {
    assert.deepEqual(monthRange(2026, 7), { from: '2026-07-01', to: '2026-07-31' })
    assert.deepEqual(monthRange(2026, 2), { from: '2026-02-01', to: '2026-02-28' })
    assert.deepEqual(monthRange(2026, 11), { from: '2026-11-01', to: '2026-11-30' })
  })
})

describe('isWeeklyOff', () => {
  test('finds every Sunday in July 2026 and nothing else', () => {
    const sundays = monthDates(2026, 7).filter(isWeeklyOff)
    assert.deepEqual(sundays, ['2026-07-05', '2026-07-12', '2026-07-19', '2026-07-26'])
  })

  test('the answer does not depend on the reader being in UTC', () => {
    // A date-only value has one weekday. Built in UTC, read in UTC.
    assert.equal(isWeeklyOff('2026-07-21'), false)   // Tuesday
    assert.equal(isWeeklyOff('2026-07-20'), false)   // Monday
    assert.equal(isWeeklyOff('2026-07-19'), true)    // Sunday
  })
})

describe('workingDatesInMonth', () => {
  test('July 2026 has 27 working days, and 21 July is one of them', () => {
    const days = workingDatesInMonth(2026, 7)
    assert.equal(days.length, 27)
    assert.ok(days.includes('2026-07-21'))
    // The sequence around the date that went missing.
    const i = days.indexOf('2026-07-21')
    assert.equal(days[i - 1], '2026-07-20')
    assert.equal(days[i + 1], '2026-07-22')
  })

  test('both month boundaries are included', () => {
    const days = workingDatesInMonth(2026, 7)
    assert.equal(days[0], '2026-07-01')
    assert.equal(days[days.length - 1], '2026-07-31')
  })

  test('the list has no duplicates and is in date order', () => {
    const days = workingDatesInMonth(2026, 7)
    assert.equal(new Set(days).size, days.length)
    assert.deepEqual([...days].sort(), days)
  })

  test('is not July-specific — other months come out complete too', () => {
    // May 2026: 31 days, Sundays 3/10/17/24/31 → 26 working days.
    const may = workingDatesInMonth(2026, 5)
    assert.equal(may.length, 26)
    assert.equal(may[0], '2026-05-01')
    assert.equal(may[may.length - 1], '2026-05-30')

    // June 2026: 30 days, Sundays 7/14/21/28 → 26 working days.
    const june = workingDatesInMonth(2026, 6)
    assert.equal(june.length, 26)
    assert.ok(june.includes('2026-06-01'))
    assert.ok(june.includes('2026-06-30'))

    // February 2028, a leap February beginning on a Tuesday.
    const feb = workingDatesInMonth(2028, 2)
    assert.equal(feb.length, 29 - 4)
    assert.ok(feb.includes('2028-02-29'))
  })

  test('company holidays drop out', () => {
    const days = workingDatesInMonth(2026, 7, { holidays: ['2026-07-21', '2026-07-22'] })
    assert.equal(days.length, 25)
    assert.ok(!days.includes('2026-07-21'))
    assert.ok(!days.includes('2026-07-22'))
    assert.ok(days.includes('2026-07-20'))
    assert.ok(days.includes('2026-07-23'))
  })

  test('a holiday that falls on a Sunday is not removed twice', () => {
    const days = workingDatesInMonth(2026, 7, { holidays: ['2026-07-19'] })
    assert.equal(days.length, 27)
  })

  test('dates before joining and on or after exit are not this employee’s', () => {
    const joined = workingDatesInMonth(2026, 7, { joiningDate: '2026-07-15' })
    assert.equal(joined[0], '2026-07-15')
    assert.ok(!joined.includes('2026-07-14'))

    const left = workingDatesInMonth(2026, 7, { exitDate: '2026-07-15' })
    assert.equal(left[left.length - 1], '2026-07-14')
    assert.ok(!left.includes('2026-07-15'))

    const both = workingDatesInMonth(2026, 7, { joiningDate: '2026-07-06', exitDate: '2026-07-11' })
    assert.deepEqual(both, ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10'])
  })

  test('a month nobody has punched in still has its working days', () => {
    // The point of the fix: this list does not consult attendance at all.
    assert.equal(workingDatesInMonth(2026, 8).length, 26)
  })
})

describe('nonWorkingReason', () => {
  test('names why a date is excluded, in the engine’s precedence', () => {
    assert.equal(nonWorkingReason('2026-07-19'), 'weekly_off')
    assert.equal(nonWorkingReason('2026-07-21', { holidays: ['2026-07-21'] }), 'holiday')
    assert.equal(nonWorkingReason('2026-07-01', { joiningDate: '2026-07-15' }), 'pre_joining')
    assert.equal(nonWorkingReason('2026-07-20', { exitDate: '2026-07-15' }), 'post_exit')
  })

  test('a Sunday that is also a holiday reads as the weekly off', () => {
    assert.equal(nonWorkingReason('2026-07-19', { holidays: ['2026-07-19'] }), 'weekly_off')
  })

  test('an ordinary working day has no reason', () => {
    assert.equal(nonWorkingReason('2026-07-21'), null)
    assert.equal(nonWorkingReason('2026-07-20'), null)
    assert.equal(nonWorkingReason('2026-07-22'), null)
  })
})
