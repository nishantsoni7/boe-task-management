/**
 * The task-group card, RENDERED.
 *
 * Source text cannot tell "the control exists" from "the control reaches the
 * DOM", and the whole point of this change is what a reader sees. So this
 * renders the real component with react-dom/server — already a dependency, no
 * test framework added — and looks at the markup.
 *
 * Run:
 *   npx tsx --test src/components/notifications/NotificationTaskGroup.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Notification } from '@/lib/types'
import { NotificationTaskGroup } from './NotificationTaskGroup'
import { NotificationRow } from './NotificationRow'
import { groupNotificationsByTask, type NotificationTaskGroup as TaskGroup } from '@/lib/notifications/grouping'

const TASK = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'

let seq = 0
function n(over: Partial<Notification> = {}): Notification {
  seq += 1
  return {
    id: `n${seq}`, user_id: 'me', task_id: TASK, entity_id: null,
    type: 'task_acknowledged', title: 'Dhruv added a comment',
    body: 'Design Clarifications to be cleared',
    is_read: false, is_push_sent: true, is_digest: false,
    created_at: '2026-08-26T10:00:00.000Z', read_at: null, ...over,
  } as Notification
}

function groupOf(rows: Notification[]): TaskGroup {
  const items = groupNotificationsByTask(rows)
  const g = items.find(i => i.kind === 'task')
  assert.ok(g && g.kind === 'task')
  return g
}

const noop = () => {}
const render = (group: TaskGroup, over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    <NotificationTaskGroup
      group={group}
      filter="all"
      selected={new Set()}
      pendingDeletes={new Set()}
      onToggleSelect={noop}
      onOpenTask={noop}
      onMarkGroupRead={noop}
      onDeleteGroup={noop}
      onDeleteOne={noop}
      onRowClick={noop}
      {...over}
    />,
  )

const FOUR = () => groupOf([
  n({ id: 'e1', title: 'Dhruv added a comment',        created_at: '2026-08-26T12:00:00.000Z' }),
  n({ id: 'e2', title: 'Asha acknowledged task',       created_at: '2026-08-26T11:00:00.000Z' }),
  n({ id: 'e3', title: 'Asha submitted task for approval', created_at: '2026-08-26T10:00:00.000Z' }),
  n({ id: 'e4', title: 'Dhruv added a comment',        created_at: '2026-08-26T09:00:00.000Z', is_read: true }),
])

// ── 24. Collapsed ───────────────────────────────────────────────────────────

describe('24. collapsed, it is ONE compact card', () => {
  const html = render(FOUR())

  test('the task title is the heading', () => {
    assert.ok(html.includes('Design Clarifications to be cleared'))
  })

  test('the summary is the task, its owner and the update count', () => {
    // REPLACES the old summary line ("3 unread · Latest: Added comment · 4
    // loaded updates"). That line answered questions nobody had asked while
    // omitting the one they had — whose task is this. The header now carries
    // the task title, "Assigned to: <name>" and the count, and the events
    // themselves carry the activity. Unread is a dot and a left accent, not a
    // pill (see the layout tests).
    assert.ok(html.includes('Assigned to:'))
    assert.ok(html.includes('4 updates'), 'events loaded, always called updates')
    assert.equal(html.includes('Latest:'), false, 'the summary line is gone')
    assert.equal(html.includes('loaded updates'), false)
  })

  test('the four events are NOT rendered as four rows until expanded', () => {
    // The panel is hidden and its contents are not in the tree at all.
    assert.ok(html.includes('hidden=""'), 'the accordion panel is hidden')
    assert.equal(html.includes('UNREAD'), false, 'no sub-notification is drawn')
    assert.equal((html.match(/aria-pressed=/g) ?? []).length, 0, 'no per-event checkbox')
  })
})

// ── 25-26. Expanded ─────────────────────────────────────────────────────────

describe('25-26. expanded, and one View Task', () => {
  // renderToStaticMarkup cannot click, so the panel's contents are asserted
  // through the collapsed/expanded contract instead: hidden when closed, and
  // the group owns exactly one View Task either way.
  const html = render(FOUR())

  test('26. exactly ONE View Task action, at group level', () => {
    assert.equal((html.match(/View Task/g) ?? []).length, 1)
    assert.ok(html.includes('aria-label="View task Design Clarifications to be cleared"'))
  })

  test('the group owns mark-read and delete, each a real button', () => {
    assert.ok(html.includes('aria-label="Mark all updates for this task as read: Design Clarifications to be cleared"'))
    assert.ok(html.includes('aria-label="Delete all notifications for this task: Design Clarifications to be cleared"'))
    assert.equal((html.match(/<button/g) ?? []).length >= 4, true)
    assert.equal((html.match(/type="button"/g) ?? []).length >= 4, true, 'every control is a real button')
  })

  test('a fully read group offers no mark-read and shows no unread badge', () => {
    const read = render(groupOf([n({ is_read: true }), n({ is_read: true })]))
    assert.equal(read.includes('unread'), false)
    assert.equal(read.includes('Mark all read'), false)
    assert.ok(read.includes('View Task'), 'but is still openable')
  })
})

// ── 27. Accessibility ───────────────────────────────────────────────────────

describe('27. accordion semantics', () => {
  const html = render(FOUR())

  test('aria-expanded is present and starts collapsed', () => {
    assert.ok(html.includes('aria-expanded="false"'))
    assert.equal((html.match(/aria-expanded=/g) ?? []).length, 1, 'one trigger, not one per row')
  })

  test('aria-controls names the panel it opens, and the panel exists with that id', () => {
    const m = html.match(/aria-controls="([^"]+)"/)
    assert.ok(m, 'the trigger declares what it controls')
    assert.ok(html.includes(`id="${m![1]}"`), 'and that region is in the tree')
  })

  test('the accessible label includes the task title', () => {
    assert.ok(html.includes('aria-label="Expand 4 updates for Design Clarifications to be cleared"'))
  })

  test('the group actions are SIBLINGS of the trigger, not nested inside it', () => {
    // A button inside a button is invalid, and it makes every action toggle the
    // accordion by accident.
    const trigger = html.indexOf('aria-expanded=')
    const triggerClose = html.indexOf('</button>', trigger)
    const viewTask = html.indexOf('View Task')
    assert.ok(triggerClose < viewTask, 'View Task must sit outside the accordion trigger')
  })
})

// ── 28. Mobile ──────────────────────────────────────────────────────────────

describe('28. mobile hides no required action', () => {
  const html = render(FOUR(), { isMobile: true })

  test('every group action is still present', () => {
    assert.ok(html.includes('View Task'))
    assert.ok(html.includes('Mark all read'))
    assert.ok(html.includes('Delete all notifications for this task'))
    // The "3 unread" pill is deliberately gone — unread is now one small dot
    // per event plus a subtle left accent. What must NOT be lost is the way to
    // act on it, which is this button, shown only when something is unread.
    assert.ok(html.includes('Mark all read'), 'the unread ACTION stays visible')
  })

  test('the title wraps rather than truncating', () => {
    assert.ok(html.includes('overflow-wrap:anywhere'))
    assert.equal(/white-space:nowrap[^"]*"[^>]*>Design Clarifications/.test(html), false)
  })

  test('touch targets meet the project’s 44px mobile minimum', () => {
    assert.ok(html.includes('min-height:44px'), 'the project already uses 44/48 elsewhere')
    assert.equal(html.includes('min-height:34px'), false, '34 was below anything established here')
  })

  test('nothing scrolls horizontally', () => {
    assert.equal(/overflow-x:\s*auto|overflow-x:\s*scroll/.test(html), false)
  })
})

// ── The taskless row is untouched ───────────────────────────────────────────

describe('taskless rows keep the row they always had', () => {
  test('a standalone row renders its own View action and delete', () => {
    const html = renderToStaticMarkup(
      <NotificationRow
        n={n({ task_id: null, type: 'finance_submitted', title: 'PR-1042', body: 'Acme Ltd' })}
        isLast
        selected={false}
        pending={false}
        onToggleSelect={noop}
        onOpen={noop}
        onDelete={noop}
        onRowClick={noop}
      />,
    )
    assert.ok(html.includes('PR-1042'))
    assert.ok(html.includes('Acme Ltd'))
    assert.equal(html.includes('aria-expanded'), false, 'a single row is not an accordion')
  })
})
