/**
 * "System Activity" rows: which ones are genuinely automatic, and which ones
 * were human events wearing the wrong label.
 *
 * getNotificationMeta falls back to heading "System" / badge "Activity" when a
 * task notification's title matches no pattern. That fallback was catching two
 * events that REQUIRE THE RECIPIENT TO ACT, and mis-parsing a third's actor.
 *
 * Run:
 *   npx tsx --test src/lib/notifications/systemActivityLabels.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { Notification } from '@/lib/types'
import { getNotificationMeta } from '@/lib/notificationMeta'
import { getNotificationCategoryFilter, isSystemGeneratedNotificationType } from '@/lib/notifications'
import { TASK_REVIEW_NOTIFICATION_SUFFIXES } from '@/lib/tasks/reviewTransitions'

const row = (title: string, over: Partial<Notification> = {}): Notification => ({
  id: 'n1', user_id: 'me', task_id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', entity_id: null,
  type: 'task_acknowledged', title, body: 'Design Clarifications to be cleared',
  is_read: false, is_push_sent: true, is_digest: false,
  created_at: '2026-08-26T10:00:00.000Z', read_at: null, ...over,
} as Notification)

// ── Class C: action required from the recipient ─────────────────────────────

describe('class C — the recipient must act — is named, not labelled "System"', () => {
  const cases: [title: string, badge: string][] = [
    // The creator has a task to approve. Explicitly must never be suppressed
    // from the person who has to decide it — and it should not read as an
    // anonymous log line either.
    ['Asha submitted task for approval', 'Awaiting your approval'],
    // The assignee has work handed back to them.
    ['Dhruv returned task to Working',   'Returned for changes'],
  ]

  for (const [title, badge] of cases) {
    test(`"${title}" carries its actor and its own badge`, () => {
      const meta = getNotificationMeta(row(title))
      assert.equal(meta.headingIsActor, true, 'the actor is a person, not "System"')
      assert.notEqual(meta.heading, 'System')
      assert.equal(meta.badge.label, badge)
      assert.equal(meta.badge.label === 'Activity', false)
      assert.equal(meta.href, '/tasks/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa')
    })
  }

  test('and both are still IN the task feed — the label changed, not the delivery', () => {
    const filter = getNotificationCategoryFilter('task')
    assert.ok(filter.includes('submitted task for approval'))
    assert.ok(filter.includes('returned task to working'))
    // Neither is a suppressed system type.
    assert.equal(isSystemGeneratedNotificationType('task_acknowledged'), false)
  })

  test('the RPC still writes exactly these titles, so the patterns cannot orphan', () => {
    for (const suffix of Object.values(TASK_REVIEW_NOTIFICATION_SUFFIXES)) {
      const meta = getNotificationMeta(row(`Asha ${suffix}`))
      assert.equal(meta.headingIsActor, true, suffix)
      assert.notEqual(meta.badge.label, 'Activity', `"${suffix}" fell through to the fallback`)
    }
  })
})

// ── Pattern ORDER, which is what broke the third one ────────────────────────

describe('the approval patterns are tested before the generic ones', () => {
  test('"approved and completed task" parses its actor correctly', () => {
    const meta = getNotificationMeta(row('Dhruv approved and completed task'))
    assert.equal(meta.heading, 'Dhruv',
      'the generic /completed task/ matched mid-sentence and swallowed "approved and"')
    assert.equal(meta.badge.label, 'Approved & completed')
  })

  test('the plain completion event is unchanged', () => {
    const meta = getNotificationMeta(row('Asha completed task'))
    assert.equal(meta.heading, 'Asha')
    assert.equal(meta.badge.label, 'Completed')
  })

  test('every other task event keeps its existing actor and badge', () => {
    for (const [title, heading, badge] of [
      ['Asha added a comment',          'Asha', 'Added comment'],
      ['Asha acknowledged task',        'Asha', 'Acknowledged'],
      ['Asha moved task to Waiting',    'Asha', 'Moved to Waiting'],
      ['Asha moved task to Blocked',    'Asha', 'Moved to Blocked'],
      ['Asha cancelled task',           'Asha', 'Cancelled'],
    ] as const) {
      const meta = getNotificationMeta(row(title))
      assert.equal(meta.heading, heading, title)
      assert.equal(meta.badge.label, badge, title)
    }
  })
})

// ── Class A stays suppressed ────────────────────────────────────────────────

describe('class A — non-actionable automatic events — remain suppressed', () => {
  test('the suppressed types are unchanged, and none of them is a task-feed title', () => {
    for (const t of ['escalation', 'overdue', 'stale_flag', 'morning_digest', 'evening_digest']) {
      assert.equal(isSystemGeneratedNotificationType(t), true, t)
    }
    const filter = getNotificationCategoryFilter('task')
    for (const fragment of ['escalat', 'overdue', 'stale']) {
      assert.equal(filter.toLowerCase().includes(fragment), false,
        `the task feed must not whitelist "${fragment}"`)
    }
  })

  test('the fallback still exists for a genuinely unrecognised row', () => {
    // Not every future title needs a pattern; an unknown one degrades to a
    // neutral, openable row rather than disappearing.
    const meta = getNotificationMeta(row('Something nobody has written yet'))
    assert.equal(meta.heading, 'System')
    assert.equal(meta.badge.label, 'Activity')
    assert.equal(meta.href, '/tasks/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'still openable')
  })
})
