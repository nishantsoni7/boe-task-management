/**
 * Meeting status transitions and the completion summary.
 *
 * These are the rules that decide when a meeting stops being editable, and they
 * are asserted here because the UI and the database each hold a copy: this
 * table must stay identical to set_meeting_status() in migration
 * 20260814000000 §8g, or the screen will offer a button whose RPC refuses.
 *
 * Run:
 *   npx tsx --test src/lib/meetings/status.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  MEETING_TRANSITIONS, canTransitionMeeting, isMeetingEditable,
  summarizeMeetingForCompletion, completionWarning,
} from './status'
import type { MeetingOrder, MeetingOrderItem, MeetingStatus } from './types'

const ALL_STATUSES: MeetingStatus[] = ['draft', 'in_progress', 'completed']

const order = (over: Partial<MeetingOrder> = {}): MeetingOrder => ({
  id: 'o1', meeting_id: 'm1', order_number: '2041', order_type: 'new_order',
  customer_name: null, expected_dispatch_date: null, position: 'on_track',
  latest_update: null, next_review_date: null, remarks: null,
  created_by: 'u1', created_at: '', updated_at: '', ...over,
})

const item = (over: Partial<MeetingOrderItem> = {}): MeetingOrderItem => ({
  id: 'i1', meeting_order_id: 'o1', sku: 'SKU-1', product_name: 'Chair',
  quantity: null, current_stage: null, latest_update: null, issue: null,
  responsible_department: null, next_follow_up_date: null, status: 'open',
  linked_task_id: null, linked_task_at: null, linked_task_by: null,
  created_by: 'u1', created_at: '', updated_at: '', ...over,
})

describe('meeting status transitions', () => {
  test('a draft can be started or completed outright', () => {
    assert.equal(canTransitionMeeting('draft', 'in_progress'), true)
    assert.equal(canTransitionMeeting('draft', 'completed'), true)
  })

  test('a live meeting can be completed, or put back to draft', () => {
    assert.equal(canTransitionMeeting('in_progress', 'completed'), true)
    assert.equal(canTransitionMeeting('in_progress', 'draft'), true)
  })

  test('a completed meeting reopens to in_progress and nothing else', () => {
    assert.equal(canTransitionMeeting('completed', 'in_progress'), true)
    // Never back to draft: the record of having been held is not erasable.
    assert.equal(canTransitionMeeting('completed', 'draft'), false)
  })

  test('a status never transitions to itself', () => {
    for (const status of ALL_STATUSES) {
      assert.equal(canTransitionMeeting(status, status), false, `${status} → ${status}`)
    }
  })

  test('the table names only real statuses', () => {
    for (const [from, targets] of Object.entries(MEETING_TRANSITIONS)) {
      assert.ok(ALL_STATUSES.includes(from as MeetingStatus))
      for (const to of targets) assert.ok(ALL_STATUSES.includes(to), `${from} → ${to}`)
    }
  })

  test('only a completed meeting is read-only', () => {
    assert.equal(isMeetingEditable('draft'), true)
    assert.equal(isMeetingEditable('in_progress'), true)
    assert.equal(isMeetingEditable('completed'), false)
  })
})

describe('completion summary', () => {
  test('counts what was reviewed, not what was touched', () => {
    // An order brought in and found to need nothing was still reviewed.
    const summary = summarizeMeetingForCompletion(
      [order({ id: 'o1' }), order({ id: 'o2', order_number: '2042' })],
      [item({ id: 'i1' }), item({ id: 'i2' })],
    )
    assert.equal(summary.ordersReviewed, 2)
    assert.equal(summary.itemsReviewed, 2)
  })

  test('open and waiting are both unresolved; resolved is not', () => {
    const summary = summarizeMeetingForCompletion([order()], [
      item({ id: 'a', status: 'open' }),
      item({ id: 'b', status: 'waiting' }),
      item({ id: 'c', status: 'resolved' }),
    ])
    assert.equal(summary.unresolvedIssues, 2)
  })

  test('follow-ups, tasks and blank updates are counted separately', () => {
    const summary = summarizeMeetingForCompletion([order()], [
      item({ id: 'a', next_follow_up_date: '2026-08-10', latest_update: 'Polishing done' }),
      item({ id: 'b', linked_task_id: 't1', latest_update: 'Fabric chased' }),
      item({ id: 'c' }),
      // Whitespace is not an update. Someone pressing space in the box must not
      // make an item look reviewed.
      item({ id: 'd', latest_update: '   ' }),
    ])
    assert.equal(summary.followUpsScheduled, 1)
    assert.equal(summary.tasksCreated, 1)
    assert.equal(summary.itemsWithoutUpdates, 2)
  })

  test('an empty meeting summarises to zeroes rather than failing', () => {
    const summary = summarizeMeetingForCompletion([], [])
    assert.deepEqual(summary, {
      ordersReviewed: 0, itemsReviewed: 0, unresolvedIssues: 0,
      followUpsScheduled: 0, tasksCreated: 0, itemsWithoutUpdates: 0,
    })
  })
})

describe('completion warning', () => {
  test('a fully resolved, fully updated meeting warns about nothing', () => {
    const summary = summarizeMeetingForCompletion([order()], [
      item({ id: 'a', status: 'resolved', latest_update: 'Dispatched' }),
    ])
    assert.equal(completionWarning(summary), null)
  })

  test('open items are named, and completion is still permitted', () => {
    const summary = summarizeMeetingForCompletion([order()], [
      item({ id: 'a', status: 'open', latest_update: 'Chasing' }),
    ])
    const warning = completionWarning(summary)
    assert.ok(warning && warning.includes('1 item is still open'))
    // The warning explains the consequence rather than blocking: the follow-ups
    // outlive the meeting.
    assert.ok(warning.includes('follow-up'))
  })

  test('both problems are reported in one sentence', () => {
    const summary = summarizeMeetingForCompletion([order()], [
      item({ id: 'a', status: 'open' }),
      item({ id: 'b', status: 'waiting' }),
    ])
    const warning = completionWarning(summary)
    assert.ok(warning)
    assert.ok(warning.includes('2 items are still open'))
    assert.ok(warning.includes('2 items have no update'))
  })
})
