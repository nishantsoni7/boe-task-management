/**
 * Append-only update history — what a history row says, and which entry counts
 * as "the previous commitment".
 *
 * The one that matters: `previousUpdateForItem` must skip entries that carried
 * no update text. A save that only moved a status writes such an entry, and
 * reading the second-newest entry blindly would report a stale sentence as what
 * was said last time — on the exact screen people rely on to hold each other to
 * it.
 *
 * Run:
 *   npx tsx --test src/lib/meetings/history.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  HISTORY_ENTRY_LABEL, historyChangeLines, hasUpdateText, previousCommitment,
  sortHistory, historyForItem, historyForOrder, previousUpdateForItem,
  previousUpdateByItem,
} from './history'
import type { MeetingHistoryEntry } from './types'

const entry = (over: Partial<MeetingHistoryEntry> = {}): MeetingHistoryEntry => ({
  id: 'h1', meeting_id: 'm1', meeting_order_id: 'o1', meeting_order_item_id: 'i1',
  order_number: '2041', sku: 'A-1', product_name: 'Chair',
  entry_type: 'item_update',
  previous_update: null, new_update: null,
  previous_status: null, new_status: null,
  previous_follow_up_date: null, new_follow_up_date: null,
  detail: null, actor_id: 'u1', created_at: '2026-08-05T10:00:00Z',
  ...over,
})

describe('labels', () => {
  test('every entry type has a reader-facing label', () => {
    for (const type of ['order_added', 'order_update', 'item_added', 'item_update', 'task_linked', 'import'] as const) {
      assert.ok(HISTORY_ENTRY_LABEL[type], type)
    }
  })
})

describe('historyChangeLines', () => {
  test('a status move reads as words, not as database keys', () => {
    const lines = historyChangeLines(entry({ previous_status: 'open', new_status: 'waiting' }))
    assert.deepEqual(lines, ['Status: Open → Waiting'])
  })

  test('order positions use their own vocabulary', () => {
    const lines = historyChangeLines(entry({ previous_status: 'on_track', new_status: 'at_risk' }))
    assert.deepEqual(lines, ['Status: On Track → At Risk'])
  })

  test('a follow-up set from nothing, and one cleared, read differently', () => {
    assert.deepEqual(
      historyChangeLines(entry({ new_follow_up_date: '2026-08-12' })),
      ['Follow-up: none → 12 Aug 2026'],
    )
    assert.deepEqual(
      historyChangeLines(entry({ previous_follow_up_date: '2026-08-12' })),
      ['Follow-up: 12 Aug 2026 → cleared'],
    )
  })

  test('an untouched field produces no line at all', () => {
    // Twelve updates in a drawer stay readable only because a save that changed
    // one thing reports one thing.
    assert.deepEqual(historyChangeLines(entry({ new_update: 'Polish done' })), [])
  })

  test('the detail line is appended after the changes', () => {
    const lines = historyChangeLines(entry({
      previous_status: 'open', new_status: 'resolved', detail: 'Task created: Chase fabric',
    }))
    assert.deepEqual(lines, ['Status: Open → Resolved', 'Task created: Chase fabric'])
  })
})

describe('hasUpdateText / previousCommitment', () => {
  test('whitespace is not an update', () => {
    assert.equal(hasUpdateText(entry({ new_update: '   ' })), false)
    assert.equal(hasUpdateText(entry({ new_update: 'Polish done' })), true)
    assert.equal(hasUpdateText(entry({ new_update: null })), false)
  })

  test('a first update has no previous commitment', () => {
    assert.equal(previousCommitment(entry({ previous_update: null })), null)
    assert.equal(previousCommitment(entry({ previous_update: '  ' })), null)
    assert.equal(previousCommitment(entry({ previous_update: 'Frames done' })), 'Frames done')
  })
})

describe('scoping and ordering', () => {
  const entries = [
    entry({ id: 'a', meeting_order_item_id: 'i1', created_at: '2026-08-01T10:00:00Z' }),
    entry({ id: 'b', meeting_order_item_id: 'i2', created_at: '2026-08-03T10:00:00Z' }),
    entry({ id: 'c', meeting_order_item_id: 'i1', created_at: '2026-08-05T10:00:00Z' }),
    entry({ id: 'd', meeting_order_item_id: null, meeting_order_id: 'o1', created_at: '2026-08-04T10:00:00Z' }),
    entry({ id: 'e', meeting_order_item_id: 'i9', meeting_order_id: 'o2', created_at: '2026-08-06T10:00:00Z' }),
  ]

  test('sortHistory is newest first and does not mutate', () => {
    const sorted = sortHistory(entries)
    assert.deepEqual(sorted.map(e => e.id), ['e', 'c', 'd', 'b', 'a'])
    assert.deepEqual(entries.map(e => e.id), ['a', 'b', 'c', 'd', 'e'])
  })

  test('historyForItem matches on the item id, never on the SKU snapshot', () => {
    // Two orders can legitimately share a SKU string; the snapshots exist to
    // keep an orphaned row readable, not to identify it.
    assert.deepEqual(historyForItem(entries, 'i1').map(e => e.id), ['c', 'a'])
  })

  test('historyForOrder includes the order-level entry and its item entries', () => {
    assert.deepEqual(historyForOrder(entries, 'o1').map(e => e.id), ['c', 'd', 'b', 'a'])
  })
})

describe('previousUpdateForItem', () => {
  test('returns what the current update replaced', () => {
    const entries = [
      entry({ id: 'first',  created_at: '2026-08-01T10:00:00Z', new_update: 'Frames started' }),
      entry({ id: 'second', created_at: '2026-08-05T10:00:00Z', previous_update: 'Frames started', new_update: 'Polish done' }),
    ]
    assert.equal(previousUpdateForItem(entries, 'i1'), 'Frames started')
  })

  test('a later status-only save does not overwrite the previous commitment', () => {
    // THE case this function exists for. The newest entry carries no update, so
    // reading it — or reading the second-newest entry's new_update — would both
    // give the wrong answer.
    const entries = [
      entry({ id: 'first',  created_at: '2026-08-01T10:00:00Z', new_update: 'Frames started' }),
      entry({ id: 'second', created_at: '2026-08-05T10:00:00Z', previous_update: 'Frames started', new_update: 'Polish done' }),
      entry({ id: 'third',  created_at: '2026-08-06T10:00:00Z', previous_status: 'open', new_status: 'waiting' }),
    ]
    assert.equal(previousUpdateForItem(entries, 'i1'), 'Frames started')
  })

  test('the first update of all has nothing before it', () => {
    const entries = [entry({ created_at: '2026-08-01T10:00:00Z', new_update: 'Frames started' })]
    assert.equal(previousUpdateForItem(entries, 'i1'), null)
  })

  test('an item with no history at all returns null rather than throwing', () => {
    assert.equal(previousUpdateForItem([], 'i1'), null)
    assert.equal(previousUpdateForItem([entry({ meeting_order_item_id: 'other' })], 'i1'), null)
  })

  test('another item’s history is never borrowed', () => {
    const entries = [
      entry({ id: 'mine',  meeting_order_item_id: 'i1', created_at: '2026-08-01T10:00:00Z', new_update: 'Mine' }),
      entry({ id: 'other', meeting_order_item_id: 'i2', created_at: '2026-08-09T10:00:00Z', previous_update: 'Theirs before', new_update: 'Theirs' }),
    ]
    assert.equal(previousUpdateForItem(entries, 'i1'), null)
  })
})

describe('previousUpdateByItem', () => {
  // The batch form replaced the per-row call because the per-row call was
  // O(rows x history) on every render. It is only a safe replacement if it
  // agrees with the original on every input, so that is what is asserted —
  // equivalence, not a re-statement of the same rules.
  const entries = [
    entry({ id: 'a1', meeting_order_item_id: 'i1', created_at: '2026-08-01T10:00:00Z', new_update: 'Frames started' }),
    entry({ id: 'a2', meeting_order_item_id: 'i1', created_at: '2026-08-05T10:00:00Z', previous_update: 'Frames started', new_update: 'Polish done' }),
    // Status-only save: carries no update text and must not become "previous".
    entry({ id: 'a3', meeting_order_item_id: 'i1', created_at: '2026-08-06T10:00:00Z', previous_status: 'open', new_status: 'waiting' }),
    entry({ id: 'b1', meeting_order_item_id: 'i2', created_at: '2026-08-02T10:00:00Z', new_update: 'Only ever one' }),
    entry({ id: 'c1', meeting_order_item_id: 'i3', created_at: '2026-08-02T10:00:00Z', previous_update: '  ', new_update: 'Blank before' }),
    // Order-level entry: no item id at all.
    entry({ id: 'd1', meeting_order_item_id: null, created_at: '2026-08-07T10:00:00Z', new_update: 'Order moved' }),
  ]

  test('agrees with previousUpdateForItem for every item', () => {
    const batch = previousUpdateByItem(entries)
    for (const itemId of ['i1', 'i2', 'i3', 'i-absent']) {
      assert.equal(
        batch.get(itemId) ?? null,
        previousUpdateForItem(entries, itemId),
        `disagreed for ${itemId}`,
      )
    }
  })

  test('reports the replaced update, skipping status-only saves', () => {
    assert.equal(previousUpdateByItem(entries).get('i1'), 'Frames started')
  })

  test('a first update has no previous commitment', () => {
    assert.equal(previousUpdateByItem(entries).get('i2'), null)
    assert.equal(previousUpdateByItem(entries).get('i3'), null)
  })

  test('an order-level entry never lands under an item key', () => {
    const batch = previousUpdateByItem(entries)
    assert.equal(batch.has('null'), false)
    assert.deepEqual([...batch.keys()].sort(), ['i1', 'i2', 'i3'])
  })

  test('an empty history yields an empty map rather than throwing', () => {
    assert.equal(previousUpdateByItem([]).size, 0)
  })
})
