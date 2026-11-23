// "Pending from" on the Quotations list: what counts from when, and the colours (the same limits as the Dashboard's quotation requests).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { pendingFrom } from './pendingFrom'
import { WAIT_AGING_DAYS, WAIT_LATE_DAYS } from '@/lib/tasks/quotationWait'

const NOW = Date.parse('2026-11-23T08:00:00Z')
const DAY = 86_400_000
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const row = (status: 'draft' | 'sent' | 'negotiating' | 'confirmed' | 'lost' | 'archived', created: string, sent: string | null = null) => ({ status, created_at: created, sent_at: sent })

describe('Pending from', () => {
  test('a draft counts from when it was made and says it has not been sent', () => {
    const p = pendingFrom(row('draft', ago(5 * DAY + 3_600_000)), NOW)
    assert.deepEqual(p, { label: '5 days', band: 'late', note: 'made 18 Nov 2026, not sent' })
  })

  test('a sent or negotiating quotation counts from when it was SENT, not from when it was made', () => {
    const made = ago(20 * DAY), sent = ago(2 * DAY + 3_600_000)
    assert.deepEqual(pendingFrom(row('sent', made, sent), NOW), { label: '2 days', band: 'aging', note: 'since sent 21 Nov 2026' })
    assert.deepEqual(pendingFrom(row('negotiating', made, sent), NOW), { label: '2 days', band: 'aging', note: 'since sent 21 Nov 2026' })
  })

  test('an old sent row with no sent time counts from when it was made, and says so', () => {
    assert.deepEqual(pendingFrom(row('sent', ago(DAY + 3_600_000), null), NOW), { label: '1 day', band: 'fresh', note: 'since made 22 Nov 2026' })
  })

  test('confirmed, lost and archived are not pending', () => {
    for (const st of ['confirmed', 'lost', 'archived'] as const) assert.equal(pendingFrom(row(st, ago(9 * DAY), ago(8 * DAY)), NOW), null, st)
  })

  test('hours, under an hour, and the amber and red limits are the Dashboard\'s', () => {
    assert.equal(pendingFrom(row('draft', ago(10 * 60_000)), NOW)!.label, 'Under 1 hour')
    assert.equal(pendingFrom(row('draft', ago(5 * 3_600_000)), NOW)!.label, '5 hours')
    assert.equal(pendingFrom(row('draft', ago((WAIT_AGING_DAYS * DAY) - 1)), NOW)!.band, 'fresh')
    assert.equal(pendingFrom(row('draft', ago(WAIT_AGING_DAYS * DAY)), NOW)!.band, 'aging')
    assert.equal(pendingFrom(row('draft', ago(WAIT_LATE_DAYS * DAY)), NOW)!.band, 'late')
  })

  test('a made time in the future (clock skew) is no wait, and a bad time is no pending value', () => {
    assert.equal(pendingFrom(row('draft', new Date(NOW + DAY).toISOString()), NOW)!.label, 'Under 1 hour')
    assert.equal(pendingFrom(row('draft', 'not a date'), NOW), null)
  })
})
