/**
 * WHEN A NOTIFICATION CARD IS ALLOWED TO SKIP A RE-RENDER.
 *
 * The defect: marking ONE group read repainted EVERY card. Measured on a
 * 20-card page with the same data before and after this comparator existed:
 *
 *   group "Mark all read"   BEFORE  121 mutations in the synchronous render
 *                                   burst, 242 in total across two waves
 *                           AFTER     6 mutations in the burst, 17 in total
 *   expand / collapse       BEFORE    8 mutations   AFTER  8 — unchanged
 *
 * These tests pin the two rules that make that safe: a card re-renders when its
 * CONTENT changes, and when its own membership of the page-wide selection or
 * pending-delete sets changes. Anything a card draws must be compared here, or
 * a real change would be skipped — the failure mode that matters.
 *
 * Run:
 *   npx tsx --test src/lib/notifications/groupRenderIdentity.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { sameGroupContent, sameSetMembership } from './groupRenderIdentity'
import type { NotificationTaskGroup } from './grouping'
import type { Notification } from '@/lib/types'

const ev = (over: Partial<Notification> = {}): Notification => ({
  id: 'n1', user_id: 'me', task_id: 't1', entity_id: 't1',
  type: 'task_status_update', title: 'Task', body: 'body',
  is_read: false, is_push_sent: false, is_digest: false,
  created_at: '2026-08-29T10:00:00Z', read_at: null,
  activity_log_id: 'a1',
  ...over,
} as Notification)

const grp = (over: Partial<NotificationTaskGroup> = {}): NotificationTaskGroup => {
  const notifications = over.notifications ?? [ev()]
  return {
    kind: 'task', key: 'task:t1', taskId: 't1', title: 'Task',
    notifications,
    unreadCount: notifications.filter(n => !n.is_read).length,
    loadedCount: notifications.length,
    latest: notifications[0],
    ...over,
  }
}

describe('a card whose content did not change does not re-render', () => {
  test('two structurally identical groups compare equal', () => {
    assert.equal(sameGroupContent(grp(), grp()), true)
  })

  test('the same object is trivially equal', () => {
    const g = grp()
    assert.equal(sameGroupContent(g, g), true)
  })
})

describe('every fact the card draws forces a re-render when it changes', () => {
  const cases: [string, Partial<Notification>][] = [
    ['is_read',         { is_read: true }],
    ['title',           { title: 'Different' }],
    ['body',            { body: 'Different' }],
    ['created_at',      { created_at: '2026-08-29T11:00:00Z' }],
    ['activity_log_id', { activity_log_id: 'a2' }],
    ['id',              { id: 'n2' }],
  ]
  for (const [field, patch] of cases) {
    test(`${field} changed`, () => {
      assert.equal(sameGroupContent(grp(), grp({ notifications: [ev(patch)] })), false)
    })
  }

  test('unreadCount changed — the badge is on the card', () => {
    assert.equal(sameGroupContent(grp(), grp({ unreadCount: 5 })), false)
  })

  test('loadedCount changed — "N updates" is on the card', () => {
    assert.equal(sameGroupContent(grp(), grp({ loadedCount: 9 })), false)
  })

  test('the task title changed', () => {
    assert.equal(sameGroupContent(grp(), grp({ title: 'Renamed' })), false)
  })

  test('an event was added or removed', () => {
    assert.equal(sameGroupContent(grp(), grp({ notifications: [ev(), ev({ id: 'n2' })] })), false)
  })
})

describe('the enrichment on the row counts as content', () => {
  const withCtx = (ctx: Record<string, unknown> | null) =>
    grp({ notifications: [ev({ context: ctx } as Partial<Notification>)] })

  const base = { taskTitle: 'T', assigneeName: 'A', assigneeId: 'a', creatorName: 'C', creatorId: 'c', activity: null }

  test('an unchanged context is equal', () => {
    assert.equal(sameGroupContent(withCtx({ ...base }), withCtx({ ...base })), true)
  })

  test('a changed creator name re-renders — this is the header fix', () => {
    assert.equal(sameGroupContent(withCtx({ ...base }), withCtx({ ...base, creatorName: 'Other' })), false)
  })

  test('a changed assignee id re-renders', () => {
    assert.equal(sameGroupContent(withCtx({ ...base }), withCtx({ ...base, assigneeId: 'z' })), false)
  })

  test('context appearing or disappearing re-renders', () => {
    assert.equal(sameGroupContent(withCtx(null), withCtx({ ...base })), false)
  })
})

describe('only this card’s own rows in the page-wide sets matter', () => {
  const g = grp({ notifications: [ev({ id: 'n1' }), ev({ id: 'n2' })] })

  test('a different card’s row being selected does not re-render this one', () => {
    assert.equal(sameSetMembership(g, new Set(['other']), new Set(['other', 'elsewhere'])), true)
  })

  test('one of this card’s rows being selected does', () => {
    assert.equal(sameSetMembership(g, new Set(), new Set(['n2'])), false)
  })

  test('deselecting one of this card’s rows does', () => {
    assert.equal(sameSetMembership(g, new Set(['n1']), new Set()), false)
  })

  test('the identical set is trivially equal', () => {
    const s = new Set(['n1'])
    assert.equal(sameSetMembership(g, s, s), true)
  })

  test('a pending delete on another card leaves this one alone', () => {
    assert.equal(sameSetMembership(g, new Set(), new Set(['someone-elses-row'])), true)
  })
})
