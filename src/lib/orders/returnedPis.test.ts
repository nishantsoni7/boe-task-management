// The Modules card's read of PIs returned to you (20270507000000): validated,
// worded, and red from the third day — the same rule the sales dashboard uses.
//
// Run with: npm run test:file -- src/lib/orders/returnedPis.test.ts

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isReturnedPiUrgent, readReturnedPis, returnedAge, returnedBrief, returnedDetail,
} from './returnedPis'
import { itemKeys, isHidden, snoozeAll } from '@/lib/modules/forYouSnooze'

const row = (over: Record<string, unknown> = {}) => ({
  submission_id: 'sub-21', reference: 'PID-00021', client_name: 'IBC', by_name: 'Nishant Soni',
  since: '2026-10-27T10:00:00Z', waiting_seconds: 3 * 86400, can_open: true, ...over,
})

describe('reading the answer', () => {
  test('rows are read in the order the database sent them', () => {
    const rows = readReturnedPis([row(), row({ submission_id: 'sub-22', reference: 'PID-00022', waiting_seconds: '7200', can_open: false })])
    assert.deepEqual(rows.map(r => r.submissionId), ['sub-21', 'sub-22'])
    assert.equal(rows[0].byName, 'Nishant Soni')
    assert.equal(rows[1].waitingSeconds, 7200)
    assert.equal(rows[1].canOpen, false)
  })

  test('missing pieces are said plainly, never invented', () => {
    const [r] = readReturnedPis([row({ reference: '', client_name: null, by_name: null, since: null, waiting_seconds: 'x' })])
    assert.equal(r.reference, 'PI')
    assert.equal(r.clientName, '')
    assert.equal(r.byName, null)
    assert.equal(r.since, null)
    assert.equal(r.waitingSeconds, 0)
    assert.equal(returnedBrief(r), 'Client not recorded · PI')
    assert.equal(returnedDetail(r), 'Open it to see what to change.')
  })

  test('an answer that is not a list of rows is unreadable, not an empty list', () => {
    for (const bad of [null, {}, 'x', [null], [{ reference: 'PID-1' }], [{ submission_id: '' }]]) {
      assert.throws(() => readReturnedPis(bad), JSON.stringify(bad))
    }
    assert.deepEqual(readReturnedPis([]), [])
  })
})

describe('the words', () => {
  test('brief and detail', () => {
    const [r] = readReturnedPis([row()])
    assert.equal(returnedBrief(r), 'IBC · PID-00021')
    assert.equal(returnedDetail(r), 'Returned by Nishant Soni. Open it to see what to change.')
  })

  test('age', () => {
    assert.equal(returnedAge(3 * 86400 + 5), '3 days')
    assert.equal(returnedAge(86400), '1 day')
    assert.equal(returnedAge(5 * 3600), '5 h')
    assert.equal(returnedAge(59), 'just now')
    assert.equal(returnedAge(-1), 'just now')
  })

  test('red from the third day: two full days waited', () => {
    assert.equal(isReturnedPiUrgent(2 * 86400 - 1), false)
    assert.equal(isReturnedPiUrgent(2 * 86400), true)
  })
})

describe('Clear all', () => {
  test('hides a returned PI for 24 hours; returned again later, it shows at once', () => {
    const now = Date.UTC(2026, 9, 30, 10)
    const first = itemKeys.returnedPi('sub-21', '2026-10-27T10:00:00Z')
    const s = snoozeAll([first], now)
    assert.equal(isHidden(s, first), true)
    assert.equal(isHidden(s, itemKeys.returnedPi('sub-21', '2026-10-30T09:00:00Z')), false)
  })
})
