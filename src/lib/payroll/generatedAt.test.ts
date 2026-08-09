/**
 * The "Generated" timestamp in the Payroll Result Detail header.
 *
 * The header showed the date alone, so two payroll runs on the same day were
 * indistinguishable. `payroll_results.generated_at` is a timestamptz and always
 * carried the time — nothing new is stored, it is simply no longer discarded.
 *
 * What these pin is the TIMEZONE. Formatting without an explicit zone uses
 * whatever the runtime is set to, so the same instant would read differently on
 * a UTC server and an IST laptop, and a payroll timestamp would be wrong for
 * every admin reading it. Asia/Kolkata is pinned, which also makes the string
 * identical on server and client — the property hydration safety depends on.
 *
 * Run:
 *   npx tsx --test src/lib/payroll/generatedAt.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { formatGeneratedAt } from '@/lib/payroll/months'

describe('formatGeneratedAt', () => {
  test('renders a stored instant as IST date and 12-hour time', () => {
    // 06:46 UTC is 12:16 IST (+05:30).
    assert.equal(formatGeneratedAt('2026-08-08T06:46:00.000Z'), '08 Aug 2026, 12:16 PM')
  })

  test('the offset is applied, not the host timezone', () => {
    // Chosen so the two differ by a whole DAY as well as a time: 20:30 UTC on
    // the 2nd is 02:00 IST on the 3rd. A formatter running in UTC would print
    // the wrong date here, not merely the wrong hour.
    assert.equal(formatGeneratedAt('2026-08-02T20:30:00.000Z'), '03 Aug 2026, 02:00 AM')
  })

  test('the real stored value from this period formats correctly', () => {
    // payroll_results.generated_at as PostgREST returns it, offset suffix and
    // fractional seconds included.
    assert.equal(formatGeneratedAt('2026-08-03T07:21:53.471+00:00'), '03 Aug 2026, 12:51 PM')
  })

  test('midnight and noon are not confused', () => {
    // 18:30 UTC = 00:00 IST next day; 06:30 UTC = 12:00 IST same day.
    assert.equal(formatGeneratedAt('2026-08-07T18:30:00.000Z'), '08 Aug 2026, 12:00 AM')
    assert.equal(formatGeneratedAt('2026-08-08T06:30:00.000Z'), '08 Aug 2026, 12:00 PM')
  })

  test('the meridiem is uppercase and separated by a plain space', () => {
    const out = formatGeneratedAt('2026-08-08T06:46:00.000Z')!
    assert.ok(out.endsWith(' PM'), `expected a plain-space " PM", got ${JSON.stringify(out)}`)
    // Some ICU builds use a narrow no-break space, which is invisible in a diff
    // and would break any comparison against this string.
    assert.equal(out.includes(' '), false, 'no narrow no-break space')
    assert.equal(out.includes(' '), false, 'no non-breaking space')
  })

  test('a missing or unparseable timestamp yields null, never a guessed time', () => {
    assert.equal(formatGeneratedAt(null),        null)
    assert.equal(formatGeneratedAt(undefined),   null)
    assert.equal(formatGeneratedAt(''),          null)
    assert.equal(formatGeneratedAt('not a date'), null)
  })

  test('the same instant formats identically however it is written', () => {
    // Server and client can hand this over in different notations; the rendered
    // string must not depend on which.
    assert.equal(
      formatGeneratedAt('2026-08-08T06:46:00.000Z'),
      formatGeneratedAt('2026-08-08T12:16:00.000+05:30'),
    )
  })
})
