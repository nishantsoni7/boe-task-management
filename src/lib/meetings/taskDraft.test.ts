/**
 * Prefilling a task from a meeting discussion.
 *
 * A task created in a meeting is opened days later by someone who was not in
 * the room. What this suite holds is that the task still carries the four
 * references needed to act on it — order, SKU, meeting, and the discussion —
 * and that the three DECISIONS (assignee, due date, priority) are never
 * invented here.
 *
 * Run:
 *   npx tsx --test src/lib/meetings/taskDraft.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildMeetingTaskDraft, meetingTaskTitle, meetingTaskDescription, meetingTaskTeam } from './taskDraft'
import type { Meeting, MeetingOrder, MeetingOrderItem } from './types'

const meeting: Meeting = {
  id: 'm1', meeting_type: 'new_order', meeting_date: '2026-08-05',
  title: 'New Order Review — 5 Aug 2026', lead_id: 'u1', status: 'in_progress',
  note: null, created_by: 'u1', created_at: '', updated_at: '',
  completed_at: null, completed_by: null,
}

const order: MeetingOrder = {
  id: 'o1', meeting_id: 'm1', order_number: '2041', order_type: 'new_order',
  customer_name: 'Leela Hotel', expected_dispatch_date: '2026-09-15',
  position: 'attention', latest_update: null, next_review_date: null, remarks: null,
  created_by: 'u1', created_at: '', updated_at: '',
}

const item = (over: Partial<MeetingOrderItem> = {}): MeetingOrderItem => ({
  id: 'i1', meeting_order_id: 'o1', sku: 'BOE-CH-118', product_name: 'Chesterfield Armchair',
  quantity: 4, current_stage: 'Polishing', latest_update: 'Frames done, polish starts Monday',
  issue: 'Fabric shade pending approval', responsible_department: 'operations',
  next_follow_up_date: '2026-08-12', status: 'open',
  linked_task_id: null, linked_task_at: null, linked_task_by: null,
  created_by: 'u1', created_at: '', updated_at: '', ...over,
})

describe('meetingTaskTitle', () => {
  test('leads with the order and SKU, then the issue', () => {
    // The issue, not the update: a task is raised to deal with a problem far
    // more often than to note progress.
    assert.equal(
      meetingTaskTitle(order, item()),
      '2041 · BOE-CH-118 — Fabric shade pending approval',
    )
  })

  test('falls back to the latest update when there is no issue', () => {
    assert.equal(
      meetingTaskTitle(order, item({ issue: null })),
      '2041 · BOE-CH-118 — Frames done, polish starts Monday',
    )
  })

  test('falls back to the product name when there is neither', () => {
    // An invented verb would be worse than an honest noun.
    assert.equal(
      meetingTaskTitle(order, item({ issue: null, latest_update: null })),
      '2041 · BOE-CH-118 — Chesterfield Armchair',
    )
  })

  test('a long discussion is clamped so the task list stays readable', () => {
    const title = meetingTaskTitle(order, item({ issue: 'x'.repeat(300) }))
    assert.ok(title.length <= 90, `title was ${title.length} chars`)
    assert.ok(title.endsWith('…'))
    // The references survive the clamp — they are what make it findable.
    assert.ok(title.startsWith('2041 · BOE-CH-118'))
  })

  test('newlines in an update do not become newlines in a title', () => {
    const title = meetingTaskTitle(order, item({ issue: 'Line one\n\nLine two' }))
    assert.ok(!title.includes('\n'))
    assert.ok(title.includes('Line one Line two'))
  })
})

describe('meetingTaskDescription', () => {
  const body = meetingTaskDescription(meeting, order, item())

  test('carries every reference the assignee needs', () => {
    assert.match(body, /Order: 2041/)
    assert.match(body, /SKU: BOE-CH-118 — Chesterfield Armchair/)
    assert.match(body, /Customer: Leela Hotel/)
    assert.match(body, /From meeting: New Order Review — 5 Aug 2026 \(5 Aug 2026\)/)
  })

  test('carries the discussion as it stood', () => {
    assert.match(body, /Issue: Fabric shade pending approval/)
    assert.match(body, /Latest update: Frames done, polish starts Monday/)
    assert.match(body, /Current stage: Polishing/)
  })

  test('omits optional facts rather than printing empty labels', () => {
    const sparse = meetingTaskDescription(
      meeting,
      { ...order, customer_name: null, expected_dispatch_date: null },
      item({ quantity: null, current_stage: null, issue: null, latest_update: null, responsible_department: null }),
    )
    assert.ok(!sparse.includes('Customer:'))
    assert.ok(!sparse.includes('Quantity:'))
    assert.ok(!sparse.includes('Issue:'))
    assert.ok(!sparse.includes('Latest update:'))
    // The two references that identify the record are never optional.
    assert.match(sparse, /Order: 2041/)
    assert.match(sparse, /SKU: BOE-CH-118/)
  })

  test('a zero quantity is printed, not treated as absent', () => {
    assert.match(meetingTaskDescription(meeting, order, item({ quantity: 0 })), /Quantity: 0/)
  })
})

describe('buildMeetingTaskDraft', () => {
  test('returns only the title and the description', () => {
    // Assignee, due date and priority are decisions and are deliberately not
    // part of the draft.
    const draft = buildMeetingTaskDraft(meeting, order, item())
    assert.deepEqual(Object.keys(draft).sort(), ['description', 'title'])
  })
})

describe('meetingTaskTeam', () => {
  test('files the task under the SKU’s responsible department', () => {
    // A polishing delay is Operations' task even when Sales raised it.
    assert.equal(meetingTaskTeam(item(), 'sales'), 'operations')
  })

  test('falls back to the creator’s own team when none is set', () => {
    assert.equal(meetingTaskTeam(item({ responsible_department: null }), 'sales'), 'sales')
    assert.equal(meetingTaskTeam(item({ responsible_department: '   ' }), 'sales'), 'sales')
  })
})
