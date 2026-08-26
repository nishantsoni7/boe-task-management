/**
 * A task-group action must reach EVERY notification for that task — including
 * the ones the browser has never loaded.
 *
 * THE DEFECT THIS CLOSES. The first version of these actions submitted the ids
 * currently in the page. The page is bounded to the newest 50, so:
 *   · "mark all updates read" left older unread rows behind;
 *   · "delete all notifications for this task" appeared to work, and the group
 *     came straight back on the next "Load older";
 *   · the badge stayed wrong, because the client cannot count rows it has never
 *     seen.
 *
 * The fix moves the decision to the database: the client names a TASK, the
 * server resolves the set under the same category filter and system-type
 * exclusion the list route uses, and returns the exact affected counts from the
 * mutating statement itself.
 *
 * Run:
 *   npx tsx --test src/lib/notifications/taskGroupScope.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { QueryClient, MutationObserver } from '@tanstack/react-query'
import type { Notification } from '@/lib/types'
import { notificationKeys } from '@/lib/notificationCache'
import {
  markTaskGroupReadOptions,
  deleteTaskGroupOptions,
  type NotificationMutationDeps,
} from '@/lib/notificationMutations'
import { groupNotificationsByTask } from './grouping'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const MARK_ROUTE = read('src/app/api/notifications/mark-read/route.ts')
const LIST_ROUTE = read('src/app/api/notifications/route.ts')

const TASK_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const TASK_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

function n(i: number, over: Partial<Notification> = {}): Notification {
  return {
    id: `n${String(i).padStart(4, '0')}`, user_id: 'me', task_id: TASK_A, entity_id: null,
    type: 'task_acknowledged', title: 'Dhruv added a comment', body: 'A big task',
    is_read: false, is_push_sent: true, is_digest: false,
    created_at: new Date(Date.UTC(2026, 7, 26, 0, 0, i)).toISOString(), read_at: null, ...over,
  } as Notification
}

type Call = { url: string; method?: string; body: unknown }

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
      const call = { url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null }
      calls.push(call)
      return respond(call)
    },
  }
  return {
    qc, deps, calls, errors,
    list:  () => qc.getQueryData<Notification[]>(notificationKeys.list('task')) ?? [],
    count: () => qc.getQueryData<{ unreadCount: number }>(notificationKeys.count('task'))?.unreadCount,
  }
}

const ok = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body } as Response)
const fail = (): Response => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) } as Response)

async function mutate<T>(qc: QueryClient, options: object, v: T) {
  const observer = new MutationObserver(qc, options as never)
  try { await observer.mutate(v as never) } catch { /* onError handles it */ }
}

// ── 1-4, 9. THE 250-NOTIFICATION TASK ───────────────────────────────────────

describe('a task with 250 notifications, 50 of them loaded', () => {
  const TOTAL = 250
  const LOADED = 50
  /** The newest 50 — exactly what the bounded page holds. */
  const loadedPage = () => [
    ...Array.from({ length: LOADED }, (_, i) => n(TOTAL - i)),          // task A, unread
    n(9001, { task_id: TASK_B, body: 'Another task' }),                  // a different task
  ]

  test('1/2. the page holds 50 of the 250, and the group knows it', () => {
    const g = groupNotificationsByTask(loadedPage()).find(i => i.kind === 'task' && i.taskId === TASK_A)
    assert.ok(g && g.kind === 'task')
    assert.equal(g.loadedCount, LOADED, 'the client can only ever see the window')
    assert.equal(g.loadedCount < TOTAL, true)
  })

  test('3. mark-task-read names the TASK, not 50 ids', async () => {
    const h = harness(loadedPage(), 300, () => ok({ success: true, updatedCount: TOTAL, unreadAffected: TOTAL }))
    await mutate(h.qc, markTaskGroupReadOptions(h.deps), TASK_A)

    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].url, '/api/notifications/mark-read')
    const body = h.calls[0].body as { taskId?: string; ids?: string[]; category?: string }
    assert.equal(body.taskId, TASK_A)
    assert.equal(body.category, 'task')
    assert.equal(body.ids, undefined, 'a bounded id list would be the bug')
  })

  test('3/9. the badge drops by the SERVER’s 250, not the loaded 50', async () => {
    const h = harness(loadedPage(), 300, () => ok({ success: true, updatedCount: TOTAL, unreadAffected: TOTAL }))
    await mutate(h.qc, markTaskGroupReadOptions(h.deps), TASK_A)
    assert.equal(h.count(), 300 - TOTAL, 'optimistic 50, corrected to the exact 250')
  })

  test('4. delete-task-group names the TASK, and drops the exact unread total', async () => {
    const h = harness(loadedPage(), 300,
      () => ok({ success: true, deletedCount: TOTAL, unreadAffected: TOTAL }))
    await mutate(h.qc, deleteTaskGroupOptions(h.deps), TASK_A)

    assert.equal(h.calls[0].method, 'DELETE')
    assert.match(h.calls[0].url, /^\/api\/notifications\?category=task&taskId=/)
    assert.ok(h.calls[0].url.includes(TASK_A))
    assert.equal(h.count(), 300 - TOTAL)
  })

  test('5. after deletion the list is REFETCHED, so Load Older cannot bring it back', async () => {
    const h = harness(loadedPage(), 300, () => ok({ success: true, deletedCount: TOTAL, unreadAffected: TOTAL }))
    await mutate(h.qc, deleteTaskGroupOptions(h.deps), TASK_A)
    const state = h.qc.getQueryState(notificationKeys.list('task'))
    assert.equal(state?.isInvalidated, true, 'the cached window is no longer trusted')
    // …and settling a group action must NOT use the mark-stale-only path, which
    // is right for a provably-correct cache and wrong here.
    const src = read('src/lib/notificationMutations.ts')
    const fn = src.slice(src.indexOf('function reconcileGroup'), src.indexOf('function reconcile('))
    assert.equal(fn.includes("refetchType: 'none'"), false)
  })

  test('6. another task’s notifications are untouched', async () => {
    const h = harness(loadedPage(), 300, () => ok({ success: true, deletedCount: TOTAL, unreadAffected: TOTAL }))
    await mutate(h.qc, deleteTaskGroupOptions(h.deps), TASK_A)
    assert.deepEqual(h.list().map(r => r.task_id), [TASK_B])
  })

  test('10. failure restores rows, grouping and count together', async () => {
    const h = harness(loadedPage(), 300, () => fail())
    await mutate(h.qc, deleteTaskGroupOptions(h.deps), TASK_A)
    assert.equal(h.list().length, LOADED + 1, 'every loaded row is back')
    assert.equal(h.count(), 300, 'and so is the badge')
    assert.equal(h.errors.length, 1)
    const g = groupNotificationsByTask(h.list()).find(i => i.kind === 'task' && i.taskId === TASK_A)
    assert.ok(g && g.kind === 'task' && g.loadedCount === LOADED, 'and the group')
  })

  test('a server that reports no exact count leaves the visible number alone', async () => {
    // Rather than subtract a knowingly incomplete value, keep what is on screen
    // and let the badge query re-read it.
    const h = harness(loadedPage(), 300, () => ok({ success: true, deletedCount: TOTAL }))
    await mutate(h.qc, deleteTaskGroupOptions(h.deps), TASK_A)
    assert.equal(h.count(), 300 - LOADED, 'only the optimistic delta, never a guess at the rest')
    assert.equal(h.qc.getQueryState(notificationKeys.count('task'))?.isInvalidated, true,
      'and it is queued for revalidation')
  })

  test('the count is corrected, never cleared first', async () => {
    const seen: (number | undefined)[] = []
    const h = harness(loadedPage(), 300, () => ok({ success: true, unreadAffected: TOTAL }))
    const unsub = h.qc.getQueryCache().subscribe(() => seen.push(h.count()))
    await mutate(h.qc, markTaskGroupReadOptions(h.deps), TASK_A)
    unsub()
    assert.equal(seen.includes(undefined), false, 'the badge never blanks mid-flight')
  })
})

// ── 7-8. Route scoping ──────────────────────────────────────────────────────

describe('7/8. the server decides the set, and decides it narrowly', () => {
  test('7. the caller is resolved server-side; no user_id is accepted from the client', () => {
    for (const [name, src] of [['mark-read', MARK_ROUTE], ['delete', LIST_ROUTE]] as const) {
      assert.ok(src.includes('await authClient.auth.getUser()'), `${name} verifies the caller`)
      assert.ok(src.includes(".eq('user_id', user.id)"), `${name} scopes to that caller`)
      assert.equal(/body.*user_?[Ii]d|searchParams\.get\('user/.test(src), false,
        `${name} must never take a user id from the request`)
    }
  })

  test('8. a task-group action carries the SAME category and system filters as the list', () => {
    // mark-read: the taskId branch is the all-branch plus one condition.
    assert.ok(MARK_ROUTE.includes('if (all || taskId != null) {'))
    assert.ok(MARK_ROUTE.includes("if (taskId != null) query = query.eq('task_id', taskId as string)"))
    assert.ok(MARK_ROUTE.includes('getNotificationCategoryFilter(categoryResult.category)'))
    assert.ok(MARK_ROUTE.includes("SYSTEM_TYPE_EXCLUSION"))

    // delete: taskId narrows the already category-scoped DELETE.
    assert.ok(LIST_ROUTE.includes("if (taskId !== null) deleteQuery = deleteQuery.eq('task_id', taskId)"))
    const del = LIST_ROUTE.slice(LIST_ROUTE.indexOf('export async function DELETE'))
    assert.ok(del.includes('.or(activityFilter)'))
    assert.ok(del.includes(".not('type', 'in', SYSTEM_TYPE_EXCLUSION)"))
  })

  test('8. hidden system types stay hidden — the exclusion is never dropped for a group', () => {
    const del = LIST_ROUTE.slice(LIST_ROUTE.indexOf('export async function DELETE'))
    const narrowAt = del.indexOf("deleteQuery.eq('task_id'")
    const excludeAt = del.indexOf("SYSTEM_TYPE_EXCLUSION")
    assert.ok(excludeAt > -1 && narrowAt > excludeAt,
      'the task narrowing is applied ON TOP of the exclusion, not instead of it')
  })

  test('the routes reject ambiguous, empty and malformed selectors', () => {
    assert.ok(MARK_ROUTE.includes("{ error: 'id, ids, taskId or all is required' }"))
    assert.ok(MARK_ROUTE.includes("{ error: 'Provide exactly one of id, ids, taskId or all' }"))
    assert.ok(MARK_ROUTE.includes("if (taskId != null && !isValidUUID(taskId as string))"))
    assert.ok(MARK_ROUTE.includes('Cannot mark more than'), 'oversized id lists are refused')
    assert.ok(LIST_ROUTE.includes("if (taskId !== null && !isValidUUID(taskId))"))
    // An unsupported category is refused before any filter is built.
    assert.ok(LIST_ROUTE.includes('resolveNotificationCategory'))
    assert.ok(MARK_ROUTE.includes('resolveNotificationCategory'))
  })

  test('exact counts come FROM the mutating statement, not a separate query', () => {
    // A count-then-mutate pair could disagree; one statement cannot.
    assert.ok(LIST_ROUTE.includes("await deleteQuery.select('id, is_read')"))
    assert.ok(LIST_ROUTE.includes('deleted.reduce((acc, r) => (r.is_read ? acc : acc + 1), 0)'))
    const del = LIST_ROUTE.slice(LIST_ROUTE.indexOf('export async function DELETE'))
    assert.equal(/count:\s*'exact'/.test(del), false, 'no separate count before the delete')
    // mark-read filters on is_read = false, so every returned row WAS unread.
    assert.ok(MARK_ROUTE.includes(".eq('is_read', false)"))
    assert.ok(MARK_ROUTE.includes('unreadAffected: (all || taskId != null) ? updatedCount : undefined'))
  })

  test('the group delete names ONE table', () => {
    const del = LIST_ROUTE.slice(LIST_ROUTE.indexOf('export async function DELETE'))
    for (const table of ['tasks', 'task_activity_log', 'task_comments', 'task_attachments']) {
      assert.equal(new RegExp(`from\\('${table}'\\)`).test(del), false, table)
    }
    assert.ok(del.includes("from('notifications')"))
  })

  test('/delete-selected stays id-only, as its own test demands', () => {
    const selected = read('src/app/api/notifications/delete-selected/route.ts')
    assert.equal(/getNotificationCategoryFilter|taskId/.test(selected), false)
    assert.ok(selected.includes(".eq('user_id', user.id)"))
  })
})

// ── 3. Individual actions stay id-based ─────────────────────────────────────

describe('individual and selected actions are unchanged', () => {
  test('single mark-read, single delete and selected delete still take ids', () => {
    const src = read('src/lib/notificationMutations.ts')
    assert.ok(src.includes("body: JSON.stringify({ id }),"), 'single mark-read')
    assert.ok(src.includes('`/api/notifications/${id}`'), 'single delete')
    assert.ok(src.includes("body: JSON.stringify({ ids }),"), 'selected')
  })

  test('the confirmation states exactly what survives', () => {
    const view = read('src/components/notifications/NotificationsView.tsx')
    assert.ok(view.includes('Delete all notifications for this task?'))
    assert.ok(view.includes(
      'This removes the notification entries only. The task and its activity history will remain.'))
    assert.equal(view.includes('Delete these updates'), false,
      'the old wording understated the scope')
  })
})
