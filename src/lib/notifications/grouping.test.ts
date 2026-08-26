/**
 * Notification grouping — the arrangement rules.
 *
 * The clutter: a notification row is an EVENT, and one task produces many
 * (acknowledged, a comment, submitted for approval, another comment). Each was
 * a top-level card, so one task filled the screen four or five times over.
 *
 * Grouping is presentation only. The rows are untouched, still individually
 * readable and deletable, and nothing about the table changes — so everything
 * below is a pure function over the list the page already holds.
 *
 * Run:
 *   npx tsx --test src/lib/notifications/grouping.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { Notification } from '@/lib/types'
import {
  groupNotificationsByTask,
  filterDisplayItems,
  summarizeDisplayItems,
  orderGroupEvents,
  compareNewestFirst,
  resolveGroupTitle,
  unreadIdsOf,
  allIdsOf,
  itemLatest,
  type NotificationDisplayItem,
  type NotificationTaskGroup,
} from './grouping'

const TASK_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const TASK_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

let seq = 0
/** A row exactly as /api/notifications returns it. */
function n(over: Partial<Notification> = {}): Notification {
  seq += 1
  return {
    id: `n${String(seq).padStart(3, '0')}`,
    user_id: 'me',
    task_id: TASK_A,
    entity_id: null,
    type: 'task_acknowledged',
    // The ACTOR SENTENCE lives in `title`…
    title: 'Dhruv added a comment',
    // …and the TASK TITLE in `body`. Every task write path does this.
    body: 'Design Clarifications to be cleared',
    is_read: false,
    is_push_sent: true,
    is_digest: false,
    created_at: '2026-08-26T10:00:00.000Z',
    read_at: null,
    ...over,
  } as Notification
}

const groups = (items: NotificationDisplayItem[]) =>
  items.filter((i): i is NotificationTaskGroup => i.kind === 'task')
const keys = (items: NotificationDisplayItem[]) => items.map(i => i.key)

// ── 1-3. What becomes a card ────────────────────────────────────────────────

describe('one task, one card', () => {
  test('1. five events for one task produce ONE top-level group', () => {
    const items = groupNotificationsByTask([
      n({ id: 'e1', title: 'Dhruv added a comment' }),
      n({ id: 'e2', title: 'Asha acknowledged task' }),
      n({ id: 'e3', title: 'Asha submitted task for approval' }),
      n({ id: 'e4', title: 'Dhruv added a comment' }),
      n({ id: 'e5', title: 'Dhruv approved and completed task' }),
    ])
    assert.equal(items.length, 1)
    assert.equal(items[0].kind, 'task')
    assert.equal(groups(items)[0].loadedCount, 5)
    assert.equal(groups(items)[0].title, 'Design Clarifications to be cleared')
  })

  test('2. two task ids produce two groups', () => {
    const items = groupNotificationsByTask([
      n({ id: 'a1', task_id: TASK_A }),
      n({ id: 'b1', task_id: TASK_B, body: 'Order no -426' }),
      n({ id: 'a2', task_id: TASK_A }),
    ])
    assert.equal(items.length, 2)
    assert.deepEqual(groups(items).map(g => g.taskId).sort(), [TASK_A, TASK_B].sort())
  })

  test('3. taskless notifications stay separate, and are never grouped together', () => {
    const items = groupNotificationsByTask([
      n({ id: 'f1', task_id: null, type: 'finance_submitted', body: 'Acme Ltd' }),
      n({ id: 'p1', task_id: null, type: 'payroll_issue_raised', body: null }),
      n({ id: 'a1', task_id: TASK_A }),
    ])
    assert.equal(items.length, 3)
    assert.equal(items.filter(i => i.kind === 'single').length, 2,
      'a Finance row and a payroll row have nothing in common but a missing task id')
  })

  test('a blank or whitespace task id is treated as taskless, not as a group key', () => {
    const items = groupNotificationsByTask([
      n({ id: 'x', task_id: '   ' as unknown as string }),
      n({ id: 'y', task_id: '' as unknown as string }),
    ])
    assert.equal(items.length, 2)
    assert.equal(items.every(i => i.kind === 'single'), true)
  })
})

// ── 4-5, 7-8. Order ─────────────────────────────────────────────────────────

describe('order is total and stable', () => {
  test('4. groups are ordered by their latest event, newest first', () => {
    const items = groupNotificationsByTask([
      n({ id: 'a', task_id: TASK_A, created_at: '2026-08-26T09:00:00.000Z' }),
      n({ id: 'b', task_id: TASK_B, created_at: '2026-08-26T11:00:00.000Z' }),
    ])
    assert.deepEqual(keys(items), [`task:${TASK_B}`, `task:${TASK_A}`])
  })

  test('5. events inside a group are newest first', () => {
    const g = groups(groupNotificationsByTask([
      n({ id: 'old', created_at: '2026-08-26T08:00:00.000Z' }),
      n({ id: 'new', created_at: '2026-08-26T12:00:00.000Z' }),
      n({ id: 'mid', created_at: '2026-08-26T10:00:00.000Z' }),
    ]))[0]
    assert.deepEqual(g.notifications.map(x => x.id), ['new', 'mid', 'old'])
    assert.equal(g.latest.id, 'new')
  })

  test('8. equal timestamps fall back to id, deterministically', () => {
    const at = '2026-08-26T10:00:00.000Z'
    const forwards = groupNotificationsByTask([
      n({ id: 'n1', created_at: at }), n({ id: 'n2', created_at: at }), n({ id: 'n3', created_at: at }),
    ])
    const backwards = groupNotificationsByTask([
      n({ id: 'n3', created_at: at }), n({ id: 'n2', created_at: at }), n({ id: 'n1', created_at: at }),
    ])
    assert.deepEqual(groups(forwards)[0].notifications.map(x => x.id), ['n3', 'n2', 'n1'])
    assert.deepEqual(groups(forwards)[0].notifications.map(x => x.id),
                     groups(backwards)[0].notifications.map(x => x.id),
      'input order must not change output order')
    // The comparator itself is a total order.
    assert.equal(compareNewestFirst(n({ id: 'x', created_at: at }), n({ id: 'x', created_at: at })), 0)
  })

  test('7. a new event moves its group to the front without duplicating it', () => {
    const before = [
      n({ id: 'a1', task_id: TASK_A, created_at: '2026-08-26T09:00:00.000Z' }),
      n({ id: 'b1', task_id: TASK_B, created_at: '2026-08-26T10:00:00.000Z', body: 'Order no -426' }),
    ]
    assert.deepEqual(keys(groupNotificationsByTask(before)), [`task:${TASK_B}`, `task:${TASK_A}`])

    const after = groupNotificationsByTask([
      ...before,
      n({ id: 'a2', task_id: TASK_A, created_at: '2026-08-26T11:00:00.000Z' }),
    ])
    assert.deepEqual(keys(after), [`task:${TASK_A}`, `task:${TASK_B}`], 'A moves to the front')
    assert.equal(after.length, 2, 'and does NOT become a second card')
    assert.equal(groups(after)[0].loadedCount, 2)
    assert.equal(groups(after)[0].unreadCount, 2)
  })
})

// ── 6. Load older ───────────────────────────────────────────────────────────

describe('Load older merges rather than duplicating', () => {
  test('6. a wider page folds older events into the existing group', () => {
    const firstPage = [
      n({ id: 'a3', task_id: TASK_A, created_at: '2026-08-26T12:00:00.000Z' }),
      n({ id: 'a2', task_id: TASK_A, created_at: '2026-08-26T11:00:00.000Z' }),
    ]
    const widerPage = [
      ...firstPage,
      n({ id: 'a1', task_id: TASK_A, created_at: '2026-08-26T09:00:00.000Z' }),
      n({ id: 'b1', task_id: TASK_B, created_at: '2026-08-26T08:00:00.000Z', body: 'Order no -426' }),
    ]
    const after = groupNotificationsByTask(widerPage)
    assert.equal(groups(after).filter(g => g.taskId === TASK_A).length, 1, 'still ONE card for A')
    assert.deepEqual(groups(after)[0].notifications.map(x => x.id), ['a3', 'a2', 'a1'])
    assert.equal(after.length, 2, 'and one new card for B')
  })

  test('an id repeated in the input cannot become two events', () => {
    const dup = n({ id: 'same', created_at: '2026-08-26T10:00:00.000Z' })
    const items = groupNotificationsByTask([dup, { ...dup }, { ...dup, is_read: true }])
    assert.equal(groups(items)[0].loadedCount, 1)
    // Last occurrence wins, so a refetched row beats a stale one.
    assert.equal(groups(items)[0].notifications[0].is_read, true)
  })

  test('older events never displace newer ones', () => {
    const items = groupNotificationsByTask([
      n({ id: 'new', created_at: '2026-08-26T12:00:00.000Z' }),
      n({ id: 'ancient', created_at: '2020-01-01T00:00:00.000Z' }),
    ])
    assert.equal(groups(items)[0].latest.id, 'new')
    assert.equal(itemLatest(items[0]).id, 'new')
  })
})

// ── 9. Missing optional fields ──────────────────────────────────────────────

describe('missing optional fields render safely', () => {
  test('9. a group with no body anywhere still has a heading', () => {
    const items = groupNotificationsByTask([n({ body: null }), n({ body: '   ' })])
    assert.equal(groups(items)[0].title, 'Task')
  })

  test('9. the newest non-empty body wins', () => {
    assert.equal(resolveGroupTitle([
      n({ body: null, created_at: '2026-08-26T12:00:00.000Z' }),
      n({ body: 'The real title', created_at: '2026-08-26T11:00:00.000Z' }),
    ]), 'The real title')
    assert.equal(resolveGroupTitle([]), 'Task')
  })

  test('9. a title with no parseable actor does not throw', () => {
    const items = groupNotificationsByTask([n({ title: 'Task completed', body: 'Some task' })])
    assert.equal(groups(items).length, 1)
    assert.equal(groups(items)[0].title, 'Some task')
  })
})

// ── 10-12, 16. Read state ───────────────────────────────────────────────────

describe('read state', () => {
  const mixed = () => groupNotificationsByTask([
    n({ id: 'u1', task_id: TASK_A, is_read: false, created_at: '2026-08-26T12:00:00.000Z' }),
    n({ id: 'r1', task_id: TASK_A, is_read: true,  created_at: '2026-08-26T11:00:00.000Z' }),
    n({ id: 'u2', task_id: TASK_A, is_read: false, created_at: '2026-08-26T10:00:00.000Z' }),
    n({ id: 'r2', task_id: TASK_B, is_read: true,  created_at: '2026-08-26T09:00:00.000Z', body: 'Order no -426' }),
  ])

  test('10. the group unread count is the unread EVENTS it holds', () => {
    const a = groups(mixed()).find(g => g.taskId === TASK_A)!
    assert.equal(a.unreadCount, 2)
    assert.equal(a.loadedCount, 3)
    assert.deepEqual(unreadIdsOf(a).sort(), ['u1', 'u2'])
    assert.deepEqual(allIdsOf(a).sort(), ['r1', 'u1', 'u2'])
  })

  test('11. a mixed group stays under Unread', () => {
    const unread = filterDisplayItems(mixed(), 'unread')
    assert.deepEqual(keys(unread), [`task:${TASK_A}`])
  })

  test('12. a fully read group leaves Unread but stays under All', () => {
    const allRead = groupNotificationsByTask([
      n({ id: 'r1', is_read: true }), n({ id: 'r2', is_read: true }),
    ])
    assert.equal(filterDisplayItems(allRead, 'unread').length, 0)
    assert.equal(filterDisplayItems(allRead, 'all').length, 1)
  })

  test('a read taskless row behaves the same way', () => {
    const items = groupNotificationsByTask([n({ task_id: null, is_read: true })])
    assert.equal(filterDisplayItems(items, 'unread').length, 0)
    assert.equal(filterDisplayItems(items, 'all').length, 1)
    assert.deepEqual(unreadIdsOf(items[0]), [])
  })

  test('under Unread, unread events come first WITHOUT hiding read context', () => {
    const a = groups(mixed()).find(g => g.taskId === TASK_A)!
    assert.deepEqual(orderGroupEvents(a, 'unread').map(x => x.id), ['u1', 'u2', 'r1'])
    assert.deepEqual(orderGroupEvents(a, 'all').map(x => x.id), ['u1', 'r1', 'u2'])
    assert.equal(orderGroupEvents(a, 'unread').length, a.loadedCount, 'nothing is dropped')
  })

  test('15/16. the summary counts EVENTS and containers separately', () => {
    const s = summarizeDisplayItems(mixed())
    assert.equal(s.unreadEvents, 2, 'the headline number is events')
    assert.equal(s.unreadTaskGroups, 1)
    assert.equal(s.unreadSingles, 0)
    assert.equal(s.unreadContainers, 1)
  })

  test('15. events and containers diverge, which is the point of two numbers', () => {
    const s = summarizeDisplayItems(groupNotificationsByTask([
      n({ id: 'a1', task_id: TASK_A }), n({ id: 'a2', task_id: TASK_A }),
      n({ id: 'a3', task_id: TASK_A }), n({ id: 'b1', task_id: TASK_B, body: 'Another' }),
      n({ id: 's1', task_id: null }),
    ]))
    assert.equal(s.unreadEvents, 5)
    assert.equal(s.unreadTaskGroups, 2)
    assert.equal(s.unreadSingles, 1)
    assert.equal(s.unreadContainers, 3)
  })

  test('an empty list summarises to zeroes rather than throwing', () => {
    const s = summarizeDisplayItems(groupNotificationsByTask([]))
    assert.deepEqual(s, { unreadEvents: 0, unreadTaskGroups: 0, unreadSingles: 0, unreadContainers: 0 })
    assert.deepEqual(groupNotificationsByTask([]), [])
  })
})
