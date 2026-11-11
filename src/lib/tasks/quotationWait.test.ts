import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  quotationWait, WAIT_AGING_DAYS, WAIT_BAR_FULL_DAYS, WAIT_LATE_DAYS,
} from './quotationWait'

const NOW = Date.parse('2026-11-11T05:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const H = 3_600_000
const D = 24 * H

describe('how long a quotation request has been waiting', () => {
  test('under an hour, an hour, and the hours of one day', () => {
    assert.equal(quotationWait(ago(10 * 60_000), NOW)?.label, 'Under 1 hour')
    assert.equal(quotationWait(ago(H), NOW)?.label, '1 hour')
    assert.equal(quotationWait(ago(17 * H + 30 * 60_000), NOW)?.label, '17 hours')
    assert.equal(quotationWait(ago(23 * H + 59 * 60_000), NOW)?.label, '23 hours')
  })

  test('whole 24-hour days from 24 hours on, not calendar days', () => {
    assert.equal(quotationWait(ago(24 * H), NOW)?.label, '1 day')
    assert.equal(quotationWait(ago(2 * D - 1), NOW)?.label, '1 day')
    assert.equal(quotationWait(ago(9 * D + 2 * H), NOW)?.label, '9 days')
    assert.equal(quotationWait(ago(9 * D + 2 * H), NOW)?.days, 9)
  })

  test('the bands start at the owner-set day counts', () => {
    assert.equal(WAIT_AGING_DAYS, 2)
    assert.equal(WAIT_LATE_DAYS, 4)
    const band = (ms: number) => quotationWait(ago(ms), NOW)?.band
    assert.equal(band(0), 'fresh')
    assert.equal(band(2 * D - 1), 'fresh')
    assert.equal(band(2 * D), 'aging')
    assert.equal(band(4 * D - 1), 'aging')
    assert.equal(band(4 * D), 'late')
    assert.equal(band(30 * D), 'late')
  })

  test('the bar grows with the wait and stops at its full length', () => {
    assert.equal(WAIT_BAR_FULL_DAYS, 7)
    assert.equal(quotationWait(ago(0), NOW)?.fill, 0)
    assert.equal(quotationWait(ago(3.5 * D), NOW)?.fill, 0.5)
    assert.equal(quotationWait(ago(7 * D), NOW)?.fill, 1)
    assert.equal(quotationWait(ago(40 * D), NOW)?.fill, 1)
  })

  test('a created time in the future is no wait, not a crash or a negative', () => {
    const w = quotationWait(new Date(NOW + 5 * H).toISOString(), NOW)
    assert.deepEqual(w, { days: 0, band: 'fresh', label: 'Under 1 hour', fill: 0 })
  })

  test('no usable created time gives nothing to show', () => {
    assert.equal(quotationWait(null, NOW), null)
    assert.equal(quotationWait(undefined, NOW), null)
    assert.equal(quotationWait('', NOW), null)
    assert.equal(quotationWait('not a date', NOW), null)
  })
})

describe('the wait and the Dashboard order cannot disagree', () => {
  // compareByUrgency sorts quotation rows by daysSince(created_at), longest first.
  // The wait shown must come from the same floor, or a row could read "8 days"
  // above one that reads "9 days".
  const PAGE = readFileSync(join(process.cwd(), 'src/app/dashboard/page.tsx'), 'utf8').replace(/\r/g, '')

  test('daysSince on the page is still the whole-24-hour floor', () => {
    assert.ok(PAGE.includes('Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)'))
    assert.ok(PAGE.includes('const waitDiff = daysSince(b.created_at) - daysSince(a.created_at)'))
  })

  test('so the helper agrees with it for any created time', () => {
    const daysSince = (iso: string) => Math.max(0, Math.floor((NOW - new Date(iso).getTime()) / 86_400_000))
    for (const ms of [0, H, 23 * H, 24 * H, 47 * H, 2 * D, 5 * D + 11 * H, 9 * D]) {
      assert.equal(quotationWait(ago(ms), NOW)?.days, daysSince(ago(ms)), `${ms} ms`)
    }
  })
})
