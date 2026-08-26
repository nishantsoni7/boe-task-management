/**
 * Group actions: what they change, what they must not touch, and what happens
 * when they fail.
 *
 * The mutations are driven through their real TanStack option objects against a
 * real QueryClient and an injected fetch, so the optimistic write, the unread
 * delta and the rollback are exercised rather than described.
 *
 * Run:
 *   npx tsx --test src/lib/notifications/groupMutations.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { QueryClient, MutationObserver } from '@tanstack/react-query'
import type { Notification } from '@/lib/types'
import { notificationKeys } from '@/lib/notificationCache'
import {
  markManyReadOptions,
  deleteSelectedOptions,
  type NotificationMutationDeps,
} from '@/lib/notificationMutations'
import { groupNotificationsByTask, unreadIdsOf, allIdsOf } from './grouping'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const TASK_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const TASK_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

let seq = 0
function n(over: Partial<Notification> = {}): Notification {
  seq += 1
  return {
    id: `n${seq}`, user_id: 'me', task_id: TASK_A, entity_id: null,
    type: 'task_acknowledged', title: 'Dhruv added a comment', body: 'A task',
    is_read: false, is_push_sent: true, is_digest: false,
    created_at: '2026-08-26T10:00:00.000Z', read_at: null, ...over,
  } as Notification
}

type Call = { url: string; body: unknown }

function harness(rows: Notification[], unread: number, respond: (c: Call) => Response) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  qc.setQueryData(notificationKeys.list('task'), rows)
  qc.setQueryData(notificationKeys.count('task'), { unreadCount: unread })
  const calls: Call[] = []
  const errors: string[] = []
  const deps: NotificationMutationDeps = {
    qc, category: 'task',
    reportError: m => errors.push(m),
    fetchFn: async (url, init) => {
      const call = { url, body: init?.body ? JSON.parse(String(init.body)) : null }
      calls.push(call)
      return respond(call)
    },
  }
  const list  = () => qc.getQueryData<Notification[]>(notificationKeys.list('task')) ?? []
  const count = () => qc.getQueryData<{ unreadCount: number }>(notificationKeys.count('task'))?.unreadCount
  return { qc, deps, calls, errors, list, count }
}

const ok = (body: unknown = { success: true }): Response =>
  ({ ok: true, status: 200, json: async () => body } as Response)
const fail = (): Response =>
  ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) } as Response)

/** Drives a mutation option object end to end against its QueryClient. */
async function mutate<T>(qc: QueryClient, options: object, variables: T) {
  const observer = new MutationObserver(qc, options as never)
  try { await observer.mutate(variables as never) } catch { /* handled by onError */ }
}

// ── 14, 17. Mark a group read ───────────────────────────────────────────────

describe('14/17. marking a task group read', () => {
  const rows = () => [
    n({ id: 'u1', task_id: TASK_A, is_read: false }),
    n({ id: 'r1', task_id: TASK_A, is_read: true }),
    n({ id: 'u2', task_id: TASK_A, is_read: false }),
    n({ id: 'x1', task_id: TASK_B, is_read: false }),
  ]

  test('14. every unread event in THAT group flips, and nothing else', async () => {
    const h = harness(rows(), 3, () => ok({ success: true, updatedCount: 2 }))
    const group = groupNotificationsByTask(h.list()).find(i => i.kind === 'task' && i.taskId === TASK_A)!
    await mutate(h.qc, markManyReadOptions(h.deps), unreadIdsOf(group))

    const byId = Object.fromEntries(h.list().map(r => [r.id, r]))
    assert.equal(byId.u1.is_read, true)
    assert.equal(byId.u2.is_read, true)
    assert.equal(byId.r1.is_read, true, 'already read, untouched')
    assert.equal(byId.x1.is_read, false, 'another task is not touched')
  })

  test('17. ONE request, carrying exactly the unread ids', async () => {
    const h = harness(rows(), 3, () => ok())
    const group = groupNotificationsByTask(h.list()).find(i => i.kind === 'task' && i.taskId === TASK_A)!
    await mutate(h.qc, markManyReadOptions(h.deps), unreadIdsOf(group))
    assert.equal(h.calls.length, 1, 'not one request per event')
    assert.equal(h.calls[0].url, '/api/notifications/mark-read')
    assert.deepEqual((h.calls[0].body as { ids: string[] }).ids.sort(), ['u1', 'u2'])
  })

  test('17. the canonical unread count drops by the number that were unread', async () => {
    const h = harness(rows(), 3, () => ok())
    const group = groupNotificationsByTask(h.list()).find(i => i.kind === 'task' && i.taskId === TASK_A)!
    await mutate(h.qc, markManyReadOptions(h.deps), unreadIdsOf(group))
    assert.equal(h.count(), 1, '3 - 2 unread in the group')
  })

  test('a group whose events are already read cannot move the count', async () => {
    const h = harness([n({ id: 'r1', is_read: true })], 5, () => ok())
    await mutate(h.qc, markManyReadOptions(h.deps), ['r1'])
    assert.equal(h.count(), 5)
  })

  test('22. a failure restores both the rows and the count', async () => {
    const h = harness(rows(), 3, () => fail())
    await mutate(h.qc, markManyReadOptions(h.deps), ['u1', 'u2'])
    const byId = Object.fromEntries(h.list().map(r => [r.id, r]))
    assert.equal(byId.u1.is_read, false, 'rolled back')
    assert.equal(byId.u2.is_read, false)
    assert.equal(h.count(), 3, 'and so is the badge')
    assert.equal(h.errors.length, 1, 'and the reader is told')
  })
})

// ── 18-19, 22. Delete a group ───────────────────────────────────────────────

describe('18/19. deleting a task group', () => {
  const rows = () => [
    n({ id: 'a1', task_id: TASK_A, is_read: false }),
    n({ id: 'a2', task_id: TASK_A, is_read: false }),
    n({ id: 'a3', task_id: TASK_A, is_read: true }),
    n({ id: 'b1', task_id: TASK_B, is_read: false }),
  ]

  test('18. only that task’s notifications go', async () => {
    const h = harness(rows(), 3, () => ok({ success: true, deletedIds: ['a1', 'a2', 'a3'] }))
    const group = groupNotificationsByTask(h.list()).find(i => i.kind === 'task' && i.taskId === TASK_A)!
    await mutate(h.qc, deleteSelectedOptions(h.deps), allIdsOf(group))
    assert.deepEqual(h.list().map(r => r.id), ['b1'])
  })

  test('18. the request is the EXISTING selected-delete endpoint, scoped by id', async () => {
    const h = harness(rows(), 3, () => ok({ success: true, deletedIds: ['a1', 'a2', 'a3'] }))
    const group = groupNotificationsByTask(h.list()).find(i => i.kind === 'task' && i.taskId === TASK_A)!
    await mutate(h.qc, deleteSelectedOptions(h.deps), allIdsOf(group))
    assert.equal(h.calls[0].url, '/api/notifications/delete-selected')
    assert.deepEqual((h.calls[0].body as { ids: string[] }).ids.sort(), ['a1', 'a2', 'a3'])
    // …and that endpoint is scoped to the caller, so another user's rows are
    // unreachable even if an id were guessed.
    const route = read('src/app/api/notifications/delete-selected/route.ts')
    assert.ok(route.includes(".eq('user_id', user.id)"))
    assert.ok(route.includes(".in('id', ids)"))
  })

  test('19. it cannot reach the task, its history, comments or attachments', () => {
    const route = read('src/app/api/notifications/delete-selected/route.ts')
    assert.ok(route.includes("from('notifications')"))
    for (const table of ['tasks', 'task_activity_log', 'task_comments', 'task_attachments']) {
      assert.equal(new RegExp(`from\\('${table}'\\)`).test(route), false,
        `the endpoint must never touch ${table}`)
    }
    // And the view says so before it asks.
    const view = read('src/components/notifications/NotificationsView.tsx')
    assert.ok(view.includes('This removes only your notifications for this task.'))
    assert.ok(view.includes('window.confirm('), 'several records go at once, so it confirms')
  })

  test('the unread count drops by the unread events removed, not by the total', async () => {
    const h = harness(rows(), 3, () => ok({ success: true, deletedIds: ['a1', 'a2', 'a3'] }))
    const group = groupNotificationsByTask(h.list()).find(i => i.kind === 'task' && i.taskId === TASK_A)!
    await mutate(h.qc, deleteSelectedOptions(h.deps), allIdsOf(group))
    assert.equal(h.count(), 1, '3 unread total, 2 unread removed')
  })

  test('deleting a fully read group leaves the count alone', async () => {
    const h = harness([n({ id: 'r1', is_read: true }), n({ id: 'r2', is_read: true })], 4,
      () => ok({ success: true, deletedIds: ['r1', 'r2'] }))
    await mutate(h.qc, deleteSelectedOptions(h.deps), ['r1', 'r2'])
    assert.equal(h.count(), 4)
  })

  test('22. a failed group delete restores the rows and the count', async () => {
    const h = harness(rows(), 3, () => fail())
    await mutate(h.qc, deleteSelectedOptions(h.deps), ['a1', 'a2', 'a3'])
    assert.deepEqual(h.list().map(r => r.id).sort(), ['a1', 'a2', 'a3', 'b1'])
    assert.equal(h.count(), 3)
    assert.equal(h.errors.length, 1)
    // And the grouping comes back with it.
    const items = groupNotificationsByTask(h.list())
    assert.equal(items.length, 2)
  })
})

// ── 20-21, 23. The existing workflows still hold ────────────────────────────

describe('20/21/23. individual and selected actions across groups', () => {
  test('21. selected delete spans two groups in one request', async () => {
    const h = harness([
      n({ id: 'a1', task_id: TASK_A }), n({ id: 'b1', task_id: TASK_B }),
      n({ id: 'a2', task_id: TASK_A }),
    ], 3, () => ok({ success: true, deletedIds: ['a1', 'b1'] }))
    await mutate(h.qc, deleteSelectedOptions(h.deps), ['a1', 'b1'])
    assert.deepEqual(h.list().map(r => r.id), ['a2'])
    assert.equal(h.calls.length, 1)
  })

  test('23. an in-flight widening read cannot resurrect a deleted event', () => {
    // "Load older" stands down while any mutation is pending, and a row with a
    // delete in flight is filtered out of the rendered list regardless.
    const hook = read('src/hooks/queries/useNotifications.ts')
    assert.ok(hook.includes('if (loadingOlder || blocked) return'))
    const view = read('src/components/notifications/NotificationsView.tsx')
    assert.ok(view.includes('pendingDeletes.size > 0 || markingAll || deletingBulk || deletingAll'))
    assert.ok(view.includes('useNotifications(category, mutationInFlight)'))
    // The group card also refuses to draw a row whose delete is in flight.
    const card = read('src/components/notifications/NotificationTaskGroup.tsx')
    assert.ok(card.includes('if (isPending) return null'))
  })

  test('13. expanding is a disclosure and marks nothing read', () => {
    const card = read('src/components/notifications/NotificationTaskGroup.tsx')
    const toggle = card.slice(card.indexOf('onClick={() => setOpen'), card.indexOf('aria-controls'))
    assert.equal(/markRead|markManyRead|onMarkGroupRead/.test(toggle), false,
      'the accordion trigger must not mark anything read')
  })
})

// ── 34-35. Nothing was restored or migrated ─────────────────────────────────

describe('34/35. no regression into suppressed territory', () => {
  test('34. no escalation or overdue notification path is reintroduced', () => {
    for (const f of [
      'src/lib/notifications/grouping.ts',
      'src/components/notifications/NotificationTaskGroup.tsx',
      'src/components/notifications/NotificationRow.tsx',
    ]) {
      const src = read(f)
      assert.equal(/'escalation'|'overdue'|'stale_flag'/.test(src), false, f)
    }
  })

  test('35. no migration was added by this work', () => {
    const files = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort()
    assert.equal(files.at(-1), '20261015000000_task_health_check_stops_notifying.sql',
      'grouping is a presentation change and needs no schema change')
  })
})
