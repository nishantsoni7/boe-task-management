/**
 * istDate — behavioural tests
 *
 * The cases that matter are the ones that used to be wrong: instants between
 * 00:00 and 05:30 IST, where the UTC date is still yesterday.
 *
 * Run:
 *   npx tsx --test src/lib/istDate.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  istDateOf, istToday, istDayStartUtc, istDayEndUtc,
  istAddDays, istDateRange, istLastNDays,
  istMonthStart, istMonthEnd, istMonthStartOffset,
  istClockToUtc, istClockOf,
} from './istDate'

describe('istDateOf', () => {
  test('1:00am IST belongs to that IST day, not the previous UTC day', () => {
    // 2026-07-30T01:00 IST === 2026-07-29T19:30Z
    assert.equal(istDateOf('2026-07-29T19:30:00.000Z'), '2026-07-30')
    assert.equal('2026-07-29T19:30:00.000Z'.slice(0, 10), '2026-07-29') // the old behaviour
  })

  test('11:59pm IST has not yet rolled over', () => {
    assert.equal(istDateOf('2026-07-30T18:29:00.000Z'), '2026-07-30')
  })

  test('midnight IST is the first instant of the new day', () => {
    assert.equal(istDateOf('2026-07-30T18:30:00.000Z'), '2026-07-31')
  })

  test('accepts Date and epoch millis', () => {
    const d = new Date('2026-07-29T19:30:00.000Z')
    assert.equal(istDateOf(d), '2026-07-30')
    assert.equal(istDateOf(d.getTime()), '2026-07-30')
  })
})

describe('istToday', () => {
  test('reads the injected clock, not the machine timezone', () => {
    assert.equal(istToday(new Date('2026-07-29T19:30:00.000Z')), '2026-07-30')
    assert.equal(istToday(new Date('2026-07-29T18:29:00.000Z')), '2026-07-29')
  })
})

describe('day bounds', () => {
  test('start is IST midnight expressed in UTC', () => {
    assert.equal(istDayStartUtc('2026-07-30'), '2026-07-29T18:30:00.000Z')
  })

  test('end is one millisecond before the next IST midnight', () => {
    assert.equal(istDayEndUtc('2026-07-30'), '2026-07-30T18:29:59.999Z')
  })

  test('bounds are contiguous across consecutive days', () => {
    const end   = Date.parse(istDayEndUtc('2026-07-30'))
    const start = Date.parse(istDayStartUtc('2026-07-31'))
    assert.equal(start - end, 1)
  })

  test('every instant inside the bounds maps back to the same date', () => {
    for (const ts of [istDayStartUtc('2026-07-30'), '2026-07-30T00:00:00.000Z', istDayEndUtc('2026-07-30')]) {
      assert.equal(istDateOf(ts), '2026-07-30')
    }
  })
})

describe('istAddDays', () => {
  test('moves forward and back', () => {
    assert.equal(istAddDays('2026-07-30',  1), '2026-07-31')
    assert.equal(istAddDays('2026-07-30', -1), '2026-07-29')
  })

  test('crosses month and year boundaries', () => {
    assert.equal(istAddDays('2026-07-31',  1), '2026-08-01')
    assert.equal(istAddDays('2026-01-01', -1), '2025-12-31')
  })

  test('handles a leap day', () => {
    assert.equal(istAddDays('2028-02-28', 1), '2028-02-29')
    assert.equal(istAddDays('2028-02-29', 1), '2028-03-01')
  })
})

describe('istDateRange', () => {
  test('is inclusive at both ends', () => {
    assert.deepEqual(
      istDateRange('2026-07-28', '2026-07-31'),
      ['2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31'],
    )
  })

  test('a single day yields one entry', () => {
    assert.deepEqual(istDateRange('2026-07-30', '2026-07-30'), ['2026-07-30'])
  })

  test('an inverted range yields nothing', () => {
    assert.deepEqual(istDateRange('2026-07-31', '2026-07-30'), [])
  })

  test('spans a month boundary without gaps or repeats', () => {
    const r = istDateRange('2026-06-28', '2026-07-03')
    assert.deepEqual(r, ['2026-06-28', '2026-06-29', '2026-06-30', '2026-07-01', '2026-07-02', '2026-07-03'])
    assert.equal(new Set(r).size, r.length)
  })
})

describe('istLastNDays', () => {
  test('counts back inclusive of the end date', () => {
    assert.deepEqual(
      istLastNDays(3, '2026-07-30'),
      ['2026-07-28', '2026-07-29', '2026-07-30'],
    )
  })

  test('returns exactly N days', () => {
    assert.equal(istLastNDays(30, '2026-07-30').length, 30)
  })
})

describe('month boundaries', () => {
  test('month start is the 1st, not the last day of the previous month', () => {
    // The old local-Date + toISOString path produced 2026-06-30 for this.
    assert.equal(istMonthStart('2026-07-30'), '2026-07-01')
  })

  test('month end knows how long each month is', () => {
    assert.equal(istMonthEnd('2026-07-15'), '2026-07-31')
    assert.equal(istMonthEnd('2026-06-15'), '2026-06-30')
    assert.equal(istMonthEnd('2026-02-15'), '2026-02-28')
    assert.equal(istMonthEnd('2028-02-15'), '2028-02-29')
  })

  test('offset walks back whole months, including across a year', () => {
    assert.equal(istMonthStartOffset('2026-07-30', 1), '2026-06-01')
    assert.equal(istMonthStartOffset('2026-01-15', 1), '2025-12-01')
    assert.equal(istMonthStartOffset('2026-07-30', 0), '2026-07-01')
  })

  test('last month runs from its start to its own end', () => {
    const first = istMonthStartOffset('2026-07-30', 1)
    assert.equal(first, '2026-06-01')
    assert.equal(istMonthEnd(first), '2026-06-30')
  })
})

describe('IST wall-clock conversion', () => {
  test('an IST clock time maps to the instant the fingerprint import would store', () => {
    // The import computes Date.UTC(y, m-1, d, hh, mm - 330) for a machine time.
    const imported = new Date(Date.UTC(2026, 6, 21, 10, 7 - 330)).toISOString()
    assert.equal(istClockToUtc('2026-07-21', '10:07'), imported)
  })

  test('a time before 05:30 IST lands on the previous UTC day', () => {
    assert.equal(istClockToUtc('2026-07-21', '01:00'), '2026-07-20T19:30:00.000Z')
  })

  test('round-trips with istClockOf', () => {
    for (const clock of ['00:00', '09:05', '10:15', '18:30', '23:59']) {
      assert.equal(istClockOf(istClockToUtc('2026-07-21', clock)!), clock)
    }
  })

  test('single-digit hours are accepted', () => {
    assert.equal(istClockToUtc('2026-07-21', '9:05'), istClockToUtc('2026-07-21', '09:05'))
  })

  test('anything that is not a valid HH:MM returns null', () => {
    for (const bad of ['', '25:00', '10:60', '10', 'ten', '10:5', '10:07:30']) {
      assert.equal(istClockToUtc('2026-07-21', bad), null, `"${bad}" must be rejected`)
    }
  })

  test('an invalid date returns null', () => {
    assert.equal(istClockToUtc('not-a-date', '10:00'), null)
  })
})
