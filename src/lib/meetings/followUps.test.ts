/**
 * Follow-up due / overdue classification and filtering.
 *
 * The rules here decide what appears on the Overdue screen, which is the list
 * BOE actually chases work from. Two of them are easy to get wrong in a way no
 * screen would reveal:
 *
 *   * a RESOLVED line is never a follow-up, whatever date it still carries, and
 *   * "today" is the IST business date, not the browser's or the server's.
 *
 * Every assertion below pins `today` explicitly, so the suite cannot start
 * failing at 00:30 IST for reasons that have nothing to do with the code.
 *
 * Run:
 *   npx tsx --test src/lib/meetings/followUps.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  followUpDue, daysOverdue, isFollowUp, filterFollowUps, sortFollowUps, followUpCounts,
  EMPTY_FOLLOW_UP_FILTERS, type FollowUpRow,
} from './followUps'

const TODAY = '2026-08-05'

const row = (over: Partial<FollowUpRow> = {}): FollowUpRow => ({
  itemId: 'i1', meetingId: 'm1', meetingType: 'new_order',
  orderId: 'o1', orderNumber: '2041',
  sku: 'BOE-CH-118', productName: 'Chesterfield Armchair',
  responsibleDepartment: 'operations',
  latestUpdate: 'Frames done, polish starts Monday',
  lastUpdatedAt: '2026-08-04T10:00:00Z',
  nextFollowUpDate: TODAY, status: 'open',
  linkedTaskId: null, ...over,
})

describe('followUpDue', () => {
  test('classifies past, present and future', () => {
    assert.equal(followUpDue('2026-08-04', 'open', TODAY), 'overdue')
    assert.equal(followUpDue('2026-08-05', 'open', TODAY), 'today')
    assert.equal(followUpDue('2026-08-06', 'open', TODAY), 'upcoming')
  })

  test('a line with no date is not a follow-up', () => {
    assert.equal(followUpDue(null, 'open', TODAY), null)
    assert.equal(followUpDue(undefined, 'open', TODAY), null)
  })

  test('a RESOLVED line is never a follow-up, even with a date long past', () => {
    // The database clears the date when a line resolves; this is the second
    // half of that guarantee, for rows that predate the rule or arrive by
    // another route.
    assert.equal(followUpDue('2026-01-01', 'resolved', TODAY), null)
    assert.equal(followUpDue(TODAY, 'resolved', TODAY), null)
  })

  test('waiting is still a follow-up — waiting on someone is not done', () => {
    assert.equal(followUpDue('2026-08-04', 'waiting', TODAY), 'overdue')
  })

  test('a year boundary is compared as a date, not as text length', () => {
    assert.equal(followUpDue('2025-12-31', 'open', '2026-01-01'), 'overdue')
    assert.equal(followUpDue('2026-01-02', 'open', '2025-12-31'), 'upcoming')
  })
})

describe('daysOverdue', () => {
  test('counts whole days late', () => {
    assert.equal(daysOverdue('2026-08-02', TODAY), 3)
    assert.equal(daysOverdue('2026-08-04', TODAY), 1)
  })

  test('is zero today and never negative for a future date', () => {
    assert.equal(daysOverdue(TODAY, TODAY), 0)
    assert.equal(daysOverdue('2026-09-01', TODAY), 0)
  })

  test('spans a month boundary correctly', () => {
    assert.equal(daysOverdue('2026-07-30', '2026-08-02'), 3)
  })

  test('an unparseable date reports 0 rather than NaN', () => {
    assert.equal(daysOverdue('not-a-date', TODAY), 0)
  })
})

describe('isFollowUp', () => {
  test('dated and unresolved qualifies; undated or resolved does not', () => {
    assert.equal(isFollowUp(row({ nextFollowUpDate: '2026-08-01' }), TODAY), true)
    assert.equal(isFollowUp(row({ nextFollowUpDate: null }), TODAY), false)
    assert.equal(isFollowUp(row({ status: 'resolved' }), TODAY), false)
  })
})

describe('filterFollowUps', () => {
  const rows: FollowUpRow[] = [
    row({ itemId: 'a', nextFollowUpDate: '2026-08-01', responsibleDepartment: 'operations' }),
    row({ itemId: 'b', nextFollowUpDate: TODAY, responsibleDepartment: 'design', meetingType: 'repair_order' }),
    row({ itemId: 'c', nextFollowUpDate: '2026-08-20', status: 'waiting', responsibleDepartment: null }),
    row({ itemId: 'd', nextFollowUpDate: '2026-07-01', status: 'resolved' }),
    row({ itemId: 'e', nextFollowUpDate: null }),
  ]

  const ids = (list: FollowUpRow[]) => list.map(r => r.itemId)

  test('resolved and undated rows never survive, whatever the filters', () => {
    assert.deepEqual(ids(filterFollowUps(rows, EMPTY_FOLLOW_UP_FILTERS, TODAY)), ['a', 'b', 'c'])
  })

  test('the due filter narrows to one bucket', () => {
    assert.deepEqual(ids(filterFollowUps(rows, { ...EMPTY_FOLLOW_UP_FILTERS, due: 'overdue' }, TODAY)), ['a'])
    assert.deepEqual(ids(filterFollowUps(rows, { ...EMPTY_FOLLOW_UP_FILTERS, due: 'today' }, TODAY)), ['b'])
    assert.deepEqual(ids(filterFollowUps(rows, { ...EMPTY_FOLLOW_UP_FILTERS, due: 'upcoming' }, TODAY)), ['c'])
  })

  test('meeting type, department and status each narrow independently', () => {
    assert.deepEqual(ids(filterFollowUps(rows, { ...EMPTY_FOLLOW_UP_FILTERS, meetingType: 'repair_order' }, TODAY)), ['b'])
    assert.deepEqual(ids(filterFollowUps(rows, { ...EMPTY_FOLLOW_UP_FILTERS, department: 'operations' }, TODAY)), ['a'])
    assert.deepEqual(ids(filterFollowUps(rows, { ...EMPTY_FOLLOW_UP_FILTERS, status: 'waiting' }, TODAY)), ['c'])
  })

  test('a department filter does not match rows with no department', () => {
    // Row 'c' has none. It must not be swept up by a filter for a real one.
    const filtered = filterFollowUps(rows, { ...EMPTY_FOLLOW_UP_FILTERS, department: 'design' }, TODAY)
    assert.deepEqual(ids(filtered), ['b'])
  })

  test('search covers order number, SKU, product and the update text', () => {
    const find = (q: string) => ids(filterFollowUps(rows, { ...EMPTY_FOLLOW_UP_FILTERS, search: q }, TODAY))
    assert.deepEqual(find('2041'), ['a', 'b', 'c'])
    assert.deepEqual(find('ch-118'), ['a', 'b', 'c'])       // case-insensitive
    assert.deepEqual(find('chesterfield'), ['a', 'b', 'c'])
    assert.deepEqual(find('polish'), ['a', 'b', 'c'])       // matched in the update
    assert.deepEqual(find('nothing-here'), [])
  })

  test('filters combine rather than replace one another', () => {
    const filtered = filterFollowUps(
      rows, { ...EMPTY_FOLLOW_UP_FILTERS, due: 'overdue', department: 'design' }, TODAY,
    )
    assert.deepEqual(ids(filtered), [])
  })
})

describe('sortFollowUps', () => {
  test('oldest first — the most overdue line is the one at the top', () => {
    const sorted = sortFollowUps([
      row({ itemId: 'later', nextFollowUpDate: '2026-08-20' }),
      row({ itemId: 'oldest', nextFollowUpDate: '2026-07-01' }),
      row({ itemId: 'middle', nextFollowUpDate: '2026-08-05' }),
    ])
    assert.deepEqual(sorted.map(r => r.itemId), ['oldest', 'middle', 'later'])
  })

  test('same date falls back to order number then SKU, so the list is stable', () => {
    const sorted = sortFollowUps([
      row({ itemId: 'b', orderNumber: '2041', sku: 'Z' }),
      row({ itemId: 'a', orderNumber: '2041', sku: 'A' }),
      row({ itemId: 'c', orderNumber: '2040', sku: 'M' }),
    ])
    assert.deepEqual(sorted.map(r => r.itemId), ['c', 'a', 'b'])
  })

  test('does not mutate its input', () => {
    const input = [row({ itemId: 'x', nextFollowUpDate: '2026-09-01' }), row({ itemId: 'y', nextFollowUpDate: '2026-07-01' })]
    sortFollowUps(input)
    assert.deepEqual(input.map(r => r.itemId), ['x', 'y'])
  })
})

describe('followUpCounts', () => {
  const rows: FollowUpRow[] = [
    row({ itemId: 'a', nextFollowUpDate: '2026-08-01' }),
    row({ itemId: 'b', nextFollowUpDate: '2026-08-02' }),
    row({ itemId: 'c', nextFollowUpDate: TODAY }),
    row({ itemId: 'd', nextFollowUpDate: '2026-09-01', meetingType: 'repair_order' }),
    row({ itemId: 'e', status: 'resolved', nextFollowUpDate: '2026-01-01' }),
  ]

  test('the buckets sum to the total', () => {
    const counts = followUpCounts(rows, EMPTY_FOLLOW_UP_FILTERS, TODAY)
    assert.deepEqual(counts, { all: 4, overdue: 2, today: 1, upcoming: 1 })
  })

  test('counts respect the other filters but ignore the due filter', () => {
    // A tab must show what it WOULD produce under the filters already applied —
    // otherwise clicking it contradicts its own badge.
    const counts = followUpCounts(
      rows, { ...EMPTY_FOLLOW_UP_FILTERS, due: 'overdue', meetingType: 'repair_order' }, TODAY,
    )
    assert.deepEqual(counts, { all: 1, overdue: 0, today: 0, upcoming: 1 })
  })
})
