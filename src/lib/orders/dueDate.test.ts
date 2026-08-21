/**
 * THE DUE-DATE RULE, PINNED — including the values that must never become one.
 *
 * This is the TypeScript half of a rule that is stated twice: here for the save
 * path, and in SQL in migration 20260922000000 for the historical backfill. Every
 * boundary below is a boundary that migration also has to hold, so a change to
 * one that is not made to the other shows up as a failure here.
 *
 * THE CASE THAT MATTERS MOST is the Excel-duration mistake. A lead time typed
 * into the dispatch cell as a bare number is converted by excelSerialToIso into
 * a well-formed date in 1900, and those strings are already stored. They are
 * ISO-shaped, so pattern matching alone adopts them.
 *
 * Run:
 *   npx tsx --test src/lib/orders/dueDate.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { excelSerialToIso } from '@/lib/pi/workbookReader'
import {
  COMMITMENT_PREFIX,
  DUE_DATE_ABSENT,
  DUE_DATE_FLOOR,
  isCalendarDate,
  plausibleDueDate,
  supportingCommitment,
} from './dueDate'

/** The common shape: a PI created in January and confirmed at the end of it. */
const anchored = (candidate: string | null) => plausibleDueDate({
  candidate,
  orderConfirmationDate: '2026-01-31',
  creationDate: '2026-01-15',
})

describe('a due date is adopted only from an explicit, plausible calendar date', () => {
  test('a real date after the confirmation date is kept, exactly as given', () => {
    assert.equal(anchored('2026-03-25'), '2026-03-25')
  })

  test('due on the confirmation date itself is kept — on OR after', () => {
    assert.equal(anchored('2026-01-31'), '2026-01-31')
  })

  test('the creation date is the anchor when the PI was never confirmed', () => {
    const of = (candidate: string) =>
      plausibleDueDate({ candidate, orderConfirmationDate: null, creationDate: '2026-01-15' })
    assert.equal(of('2026-02-20'), '2026-02-20')
    assert.equal(of('2026-01-14'), null, 'a day before creation is not a due date')
  })

  test('with no anchors at all the floor decides', () => {
    const of = (candidate: string) => plausibleDueDate({ candidate })
    assert.equal(of('2026-05-01'), '2026-05-01')
    assert.equal(of(DUE_DATE_FLOOR), DUE_DATE_FLOOR, 'the floor itself is on-or-after')
    assert.equal(of('2019-12-31'), null)
  })

  test('a date before the confirmation date is rejected', () => {
    assert.equal(anchored('2026-01-30'), null)
  })

  test('an ISO-shaped string that is not a real day is rejected', () => {
    assert.equal(anchored('2026-02-30'), null, 'February has no 30th')
    assert.equal(anchored('2026-13-01'), null)
    assert.equal(isCalendarDate('2026-02-30'), false)
    assert.equal(isCalendarDate('2024-02-29'), true, 'but a leap day is real')
  })

  test('nothing, prose and part-dates yield no due date', () => {
    for (const value of [null, undefined, '', '   ', '—', '2026-03', '25-03-2026', 'March 2026']) {
      assert.equal(anchored(value as string | null), null, `${JSON.stringify(value)} is not a date`)
    }
  })
})

describe('an Excel duration never becomes a due date', () => {
  // The exact mechanism: excelSerialToIso rejects serials under 61, so small
  // lead times survive as text — but 61 and up are converted to 1900 dates that
  // are already sitting in dispatch_commitment on saved records.
  test('61, 90, 120 and 365 really do convert to 1900 dates', () => {
    assert.equal(excelSerialToIso(61), '1900-03-01')
    assert.equal(excelSerialToIso(90), '1900-03-30')
    assert.equal(excelSerialToIso(120), '1900-04-29')
    assert.equal(excelSerialToIso(365), '1900-12-30')
    assert.equal(excelSerialToIso(45), null, 'and under 61 is refused outright')
  })

  test('and every one of them is refused as a due date', () => {
    for (const serial of [61, 90, 120, 365]) {
      const iso = excelSerialToIso(serial)
      assert.equal(anchored(iso), null, `${serial} → ${iso} must never be adopted`)
    }
  })

  test('even when the record’s own anchors were mis-parsed the same way', () => {
    // The anchor cannot vouch for the value: a row whose dispatch cell was a
    // duration may well have a confirmation date that was one too. The absolute
    // floor is what holds here, and this is the case it exists for.
    assert.equal(plausibleDueDate({
      candidate: '1900-03-30',
      orderConfirmationDate: '1900-02-01',
      creationDate: '1900-01-05',
    }), null)
  })
})

describe('the commitment text is prose, and stays prose', () => {
  test('a duration is offered as supporting text, never as a date', () => {
    assert.equal(supportingCommitment('6 weeks from date of confirmation'),
      '6 weeks from date of confirmation')
    assert.equal(supportingCommitment('45 days from advance'), '45 days from advance')
    assert.equal(supportingCommitment('6-8 weeks'), '6-8 weeks')
    // Nothing above resolved to a date — the whole point.
    for (const text of ['6 weeks from date of confirmation', '45 days from advance', '6-8 weeks']) {
      assert.equal(anchored(text), null)
    }
  })

  test('a bare ISO string is not repeated as a commitment', () => {
    // It either became the due date, or it was refused as implausible. Printing
    // "Commitment: 1900-03-30" under "Not set" would put the refused value back.
    assert.equal(supportingCommitment('2026-03-25'), null)
    assert.equal(supportingCommitment('1900-03-30'), null)
  })

  test('an empty commitment is nothing to show', () => {
    for (const v of [null, undefined, '', '  ', '—']) assert.equal(supportingCommitment(v), null)
  })

  test('the wording says unset rather than missing, and the prefix is fixed', () => {
    // A due date is not a field the document forgot; it is a decision nobody has
    // taken. And the prefix is what stops the prose reading as the date itself.
    assert.equal(DUE_DATE_ABSENT, 'Not set')
    assert.equal(COMMITMENT_PREFIX, 'Commitment:')
  })
})

describe('the SQL half of the rule has not drifted from this one', () => {
  // The backfill in migration 20260922000000 must apply the SAME three tests.
  // It cannot import this module, so what is checked is that each rule is
  // literally present in the SQL — enough to fail loudly if one is edited here
  // and forgotten there.
  const sql = readFileSync(
    join(process.cwd(), 'supabase/migrations/20260922000000_order_submission_due_date.sql'), 'utf8')

  test('it uses the same floor, the same anchors, and adds the column safely', () => {
    assert.match(sql, /date '2020-01-01'/, 'the floor is the one this module exports')
    assert.ok(sql.includes(DUE_DATE_FLOOR), 'and is spelled identically')
    assert.match(sql, /c\.due >= coalesce\(c\.order_confirmation_date, c\.creation_date, date '2020-01-01'\)/,
      'confirmation date, then creation date, then the floor')
    assert.match(sql, /add column if not exists due_date date/, 'idempotent')
    assert.match(sql, /where due_date is null/,
      're-running must never overwrite a date somebody corrected')
  })

  test('it only ever considers strictly ISO-shaped commitments', () => {
    assert.ok(sql.includes("~ '^\\d{4}-\\d{2}-\\d{2}$'"), 'the same strict shape')
    assert.match(sql, /as materialized/,
      'the fence that stops prose reaching the date cast')
  })

  test('nothing in it calculates a date from a duration', () => {
    for (const forbidden of [/interval/i, /\+\s*\d+\s*\*/, /make_interval/i, /date_trunc/i]) {
      assert.ok(!forbidden.test(sql), `the backfill must not compute dates (${forbidden})`)
    }
  })
})
