/**
 * One Order's discussion across meetings.
 *
 * The scenario these stand in for: Order 408 is discussed in Meeting A with an
 * update and a screenshot, again in Meeting B, and returns in Meeting C. Opening
 * it in C must show B then A, each with only its own record, and recording today
 * in C must leave A and B exactly as they were.
 *
 * Run:
 *   npx tsx --test src/lib/meetings/orderHistory.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  discussionStateByOrder, earlierMeetingOrders, earlierPresenceByKey, groupEarlierDiscussions,
  isDiscussionEntry, meetingIsBefore, mergeDiscussionTimeline, orderNumberKey,
  type EarlierMeetingOrder,
} from './orderHistory'
import type { MeetingHistoryEntry, MeetingOrderEvidence } from './types'

const entry = (over: Partial<MeetingHistoryEntry> = {}): MeetingHistoryEntry => ({
  id: 'h1', meeting_id: 'mA', meeting_order_id: 'oA', meeting_order_item_id: null,
  order_number: '408', sku: null, product_name: null, entry_type: 'order_update',
  previous_update: null, new_update: null, previous_status: null, new_status: null,
  previous_follow_up_date: null, new_follow_up_date: null, detail: null,
  actor_id: 'u1', created_at: '2026-09-01T10:00:00Z',
  ...over,
})

const image = (over: Partial<MeetingOrderEvidence> = {}): MeetingOrderEvidence => ({
  id: 'e1', meeting_id: 'mA', meeting_order_id: 'oA', order_number: '408',
  storage_path: 'oA/1.png', file_name: 'ticket.png', mime_type: 'image/png', size_bytes: 1200,
  uploaded_by: 'u1', created_at: '2026-09-01T10:05:00Z',
  ...over,
})

const row = (
  id: string, meetingId: string, date: string, over: Partial<EarlierMeetingOrder> = {},
): EarlierMeetingOrder => ({
  id, meeting_id: meetingId, order_number: '408', position: 'on_track',
  latest_update: null, next_review_date: null,
  meeting: {
    id: meetingId, title: `Review ${date}`, meeting_date: date,
    meeting_type: 'new_order', status: 'completed', created_at: `${date}T09:00:00Z`,
  },
  ...over,
})

/** Meeting C, today. */
const C = { id: 'mC', meeting_date: '2026-09-11', created_at: '2026-09-11T09:00:00Z' }

describe('which meetings count as earlier', () => {
  test('by meeting date, then by when the meeting was raised', () => {
    assert.equal(meetingIsBefore({ meeting_date: '2026-09-01', created_at: '2026-09-09T00:00:00Z' }, C), true)
    assert.equal(meetingIsBefore({ meeting_date: '2026-09-11', created_at: '2026-09-11T08:00:00Z' }, C), true)
    assert.equal(meetingIsBefore({ meeting_date: '2026-09-11', created_at: '2026-09-11T10:00:00Z' }, C), false)
    assert.equal(meetingIsBefore(C, C), false)
  })

  test('the current meeting, later meetings and unreadable meetings are excluded; newest first', () => {
    const rows = [
      row('oA', 'mA', '2026-09-01'),
      row('oB', 'mB', '2026-09-06'),
      row('oC', 'mC', '2026-09-11'),
      row('oD', 'mD', '2026-09-20'),
      row('oX', 'mX', '2026-08-01', { meeting: null }),
      row('oE', 'mE', '2026-09-11', {
        meeting: { id: 'mE', title: 'Same day, earlier', meeting_date: '2026-09-11', meeting_type: 'new_order', status: 'completed', created_at: '2026-09-11T08:00:00Z' },
      }),
    ]
    assert.deepEqual(earlierMeetingOrders(rows, C).map(r => r.id), ['oE', 'oB', 'oA'])
  })

  test('opening an OLD meeting never shows what happened after it', () => {
    const rows = [row('oB', 'mB', '2026-09-06'), row('oC', 'mC', '2026-09-11')]
    const meetingA = { id: 'mA', meeting_date: '2026-09-01', created_at: '2026-09-01T09:00:00Z' }
    assert.deepEqual(earlierMeetingOrders(rows, meetingA), [])
  })
})

describe('discussion versus bookkeeping', () => {
  test('being added to the agenda is never a discussion entry', () => {
    assert.equal(isDiscussionEntry(entry({ entry_type: 'order_added', detail: 'Order added to this review' })), false)
  })

  test('updates and tasks always are', () => {
    assert.equal(isDiscussionEntry(entry({ entry_type: 'order_update', new_status: 'at_risk', previous_status: 'on_track' })), true)
    assert.equal(isDiscussionEntry(entry({ entry_type: 'item_update', new_update: 'Polishing done' })), true)
    assert.equal(isDiscussionEntry(entry({ entry_type: 'task_linked', detail: 'Task created: Chase ops' })), true)
  })

  test('an added product line or an import counts only when it carried something', () => {
    assert.equal(isDiscussionEntry(entry({ entry_type: 'item_added', new_status: 'open' })), false)
    assert.equal(isDiscussionEntry(entry({ entry_type: 'item_added', new_update: 'Sample approved' })), true)
    assert.equal(isDiscussionEntry(entry({ entry_type: 'import' })), false)
    assert.equal(isDiscussionEntry(entry({ entry_type: 'import', new_follow_up_date: '2026-09-15' })), true)
  })
})

describe('one meeting’s timeline', () => {
  test('reads oldest first, so the update precedes the screenshot of what it describes', () => {
    const items = mergeDiscussionTimeline(
      [entry({ id: 'u1', new_update: 'Raised with Operations', created_at: '2026-09-01T10:00:00Z' })],
      [image({ id: 'i1', created_at: '2026-09-01T10:01:00Z' })],
    )
    assert.deepEqual(items.map(i => i.kind), ['entry', 'evidence'])
  })

  test('images attached one after another collapse into one strip; an update between them splits it', () => {
    const items = mergeDiscussionTimeline(
      [entry({ id: 'u2', new_update: 'Second point', created_at: '2026-09-01T10:10:00Z' })],
      [
        image({ id: 'i1', created_at: '2026-09-01T10:01:00Z' }),
        image({ id: 'i2', created_at: '2026-09-01T10:02:00Z' }),
        image({ id: 'i3', created_at: '2026-09-01T10:11:00Z' }),
      ],
    )
    assert.deepEqual(items.map(i => i.kind), ['evidence', 'entry', 'evidence'])
    const first = items[0]
    assert.ok(first.kind === 'evidence')
    assert.deepEqual(first.items.map(e => e.id), ['i1', 'i2'])
  })

  test('agenda bookkeeping is left out, and the inputs are not modified', () => {
    const entries = [
      entry({ id: 'added', entry_type: 'order_added', created_at: '2026-09-01T09:00:00Z' }),
      entry({ id: 'said', new_update: 'Waiting on ops', created_at: '2026-09-01T10:00:00Z' }),
    ]
    const evidence = [image({ id: 'i1' }), image({ id: 'i2', created_at: '2026-09-01T10:06:00Z' })]
    const before = JSON.stringify({ entries, evidence })
    const items = mergeDiscussionTimeline(entries, evidence)
    assert.deepEqual(items.map(i => (i.kind === 'entry' ? i.entry.id : 'images')), ['said', 'images'])
    assert.equal(JSON.stringify({ entries, evidence }), before)
  })
})

describe('Order 408 across three meetings', () => {
  // Meeting A: the issue, the request to Operations, its screenshot.
  // Meeting B: still waiting.
  const earlier = earlierMeetingOrders([
    row('oA', 'mA', '2026-09-01', { position: 'attention', next_review_date: '2026-09-06' }),
    row('oB', 'mB', '2026-09-06', { position: 'at_risk', latest_update: 'Waiting on Operations' }),
  ], C)

  const entries = [
    entry({ id: 'a1', meeting_id: 'mA', meeting_order_id: 'oA', new_update: 'Veneer defect. Ticket raised with Operations.', created_at: '2026-09-01T10:00:00Z' }),
    entry({ id: 'a0', meeting_id: 'mA', meeting_order_id: 'oA', entry_type: 'order_added', created_at: '2026-09-01T09:30:00Z' }),
    entry({ id: 'b1', meeting_id: 'mB', meeting_order_id: 'oB', new_update: 'Waiting on Operations', created_at: '2026-09-06T11:00:00Z' }),
  ]
  const evidence = [image({ id: 'ia', meeting_id: 'mA', meeting_order_id: 'oA', created_at: '2026-09-01T10:02:00Z' })]

  test('both earlier meetings appear, newest first, each carrying only its own record', () => {
    const groups = groupEarlierDiscussions(earlier, entries, evidence)
    assert.deepEqual(groups.map(g => g.meetingOrder.meeting_id), ['mB', 'mA'])

    const [b, a] = groups
    assert.deepEqual(b.items.map(i => (i.kind === 'entry' ? i.entry.id : 'images')), ['b1'])
    assert.equal(b.evidenceCount, 0)
    assert.equal(b.lastUpdate, 'Waiting on Operations')

    assert.deepEqual(a.items.map(i => (i.kind === 'entry' ? i.entry.id : 'images')), ['a1', 'images'])
    assert.equal(a.updateCount, 1)
    assert.equal(a.evidenceCount, 1)
    assert.equal(a.lastUpdate, 'Veneer defect. Ticket raised with Operations.')
    assert.equal(a.meetingOrder.position, 'attention', 'the position recorded AT that meeting')
  })

  test('recording today in Meeting C changes nothing in A or B', () => {
    const before = groupEarlierDiscussions(earlier, entries, evidence)
    const today = [
      ...entries,
      entry({ id: 'c1', meeting_id: 'mC', meeting_order_id: 'oC', new_update: 'Operations fixed it', created_at: '2026-09-11T10:00:00Z' }),
    ]
    const todayEvidence = [...evidence, image({ id: 'ic', meeting_id: 'mC', meeting_order_id: 'oC', created_at: '2026-09-11T10:01:00Z' })]
    assert.deepEqual(groupEarlierDiscussions(earlier, today, todayEvidence), before)
  })

  test('a meeting that listed the Order but recorded nothing reads as exactly that', () => {
    const [group] = groupEarlierDiscussions([row('oZ', 'mZ', '2026-08-20')], entries, evidence)
    assert.deepEqual(group.items, [])
    assert.equal(group.lastUpdate, null)
    assert.equal(group.updateCount, 0)
  })

  test('an Order discussed for the first time has no earlier meetings, not an error', () => {
    assert.deepEqual(earlierMeetingOrders([], C), [])
    assert.deepEqual(groupEarlierDiscussions([], entries, evidence), [])
  })
})

describe('the board', () => {
  test('earlier meetings are counted per Order key, before today only', () => {
    const presence = earlierPresenceByKey([
      { order_number_key: '408', meeting_id: 'mA', meeting: { meeting_date: '2026-09-01', created_at: '2026-09-01T09:00:00Z' } },
      { order_number_key: '408', meeting_id: 'mB', meeting: { meeting_date: '2026-09-06', created_at: '2026-09-06T09:00:00Z' } },
      { order_number_key: '408', meeting_id: 'mD', meeting: { meeting_date: '2026-09-20', created_at: '2026-09-20T09:00:00Z' } },
      { order_number_key: '408', meeting_id: 'mC', meeting: { meeting_date: '2026-09-11', created_at: '2026-09-11T09:00:00Z' } },
      { order_number_key: '512', meeting_id: 'mX', meeting: null },
    ], C)
    assert.deepEqual(presence.get('408'), { count: 2, lastMeetingDate: '2026-09-06' })
    assert.equal(presence.has('512'), false)
  })

  test('"discussed today" counts updates and images, never agenda bookkeeping', () => {
    const state = discussionStateByOrder(
      [
        entry({ meeting_order_id: 'o1', entry_type: 'order_added', created_at: '2026-09-11T09:00:00Z' }),
        entry({ meeting_order_id: 'o2', new_update: 'On track', created_at: '2026-09-11T10:00:00Z' }),
      ],
      [image({ meeting_order_id: 'o2', created_at: '2026-09-11T10:03:00Z' }), image({ meeting_order_id: 'o3' })],
    )
    assert.equal(state.has('o1'), false)
    assert.deepEqual(state.get('o2'), { updates: 1, evidence: 1, lastAt: '2026-09-11T10:03:00Z' })
    assert.equal(state.get('o3')?.evidence, 1)
  })

  test('the Order key is the database’s own, with the same normalisation as a fallback', () => {
    assert.equal(orderNumberKey({ order_number: ' boe-408 ', order_number_key: 'BOE-408' }), 'BOE-408')
    assert.equal(orderNumberKey({ order_number: ' boe-408 ' }), 'BOE-408')
  })
})
