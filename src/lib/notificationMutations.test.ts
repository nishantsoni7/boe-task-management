/**
 * Notification mutations — behavioural tests
 *
 * These drive the REAL mutation option objects (the same ones
 * useNotificationMutations passes to useMutation) through TanStack's
 * MutationObserver against a real QueryClient, with `fetch` injected. So the
 * optimistic write, the snapshot, the rollback and the reconciliation under
 * test are exactly the code that runs in the browser — not a re-implementation.
 *
 * Covers the reported defect and its neighbours:
 *   · a successful single delete keeps the row gone
 *   · a 500 rolls the row back and reports an error
 *   · a network throw rolls the row back and reports an error
 *   · a rapid double-click sends exactly one DELETE
 *   · deleting an unread row decrements that module's badge
 *   · a task-scoped delete leaves the Finance/Orders caches alone
 *   · an already-deleted row (deleted:false) is an idempotent success
 *
 * Run:
 *   npx tsx --test src/lib/notificationMutations.test.ts
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { QueryClient, MutationObserver } from '@tanstack/react-query'
import type { Notification } from './types'
import type { NotificationCategory } from './notifications'
import {
  deleteSingleOptions,
  deleteSelectedOptions,
  deleteAllOptions,
  markReadOptions,
  createPendingGuard,
  type FetchLike,
  type NotificationMutationDeps,
} from './notificationMutations'
import { notificationKeys } from './notificationCache'

// ── Fixtures ────────────────────────────────────────────────────────────────

const notif = (id: string, isRead = false): Notification => ({
  id,
  user_id: 'user-1',
  task_id: null,
  entity_id: null,
  type: 'task_assigned',
  title: 'Someone acknowledged task',
  body: 'A task title',
  is_read: isRead,
  is_push_sent: true,
  is_digest: false,
  created_at: '2026-07-29T10:00:00.000Z',
  read_at: null,
} as unknown as Notification)

const TASK_ROWS    = [notif('t1'), notif('t2', true), notif('t3')]
const FINANCE_ROWS = [notif('f1'), notif('f2', true)]
const ORDER_ROWS   = [notif('o1')]

/** A QueryClient with no retries — a test must see the first failure, not the third. */
function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
}

/** Seed all three module lists and all three badge counts. */
function seed(qc: QueryClient) {
  qc.setQueryData(notificationKeys.list('task'),    [...TASK_ROWS])
  qc.setQueryData(notificationKeys.list('finance'), [...FINANCE_ROWS])
  qc.setQueryData(notificationKeys.list('order'),   [...ORDER_ROWS])
  qc.setQueryData(notificationKeys.count('task'),    { unreadCount: 2 })
  qc.setQueryData(notificationKeys.count('finance'), { unreadCount: 1 })
  qc.setQueryData(notificationKeys.count('order'),   { unreadCount: 1 })
}

const listOf = (qc: QueryClient, c: NotificationCategory) =>
  qc.getQueryData<Notification[]>(notificationKeys.list(c))
const idsOf = (qc: QueryClient, c: NotificationCategory) => (listOf(qc, c) ?? []).map(n => n.id)
const countOf = (qc: QueryClient, c: NotificationCategory) =>
  qc.getQueryData<{ unreadCount: number }>(notificationKeys.count(c))?.unreadCount

/** Minimal Response stand-in — only the members the mutation code touches. */
const jsonResponse = (status: number, body: unknown): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
} as Response)

type Recorder = { calls: { url: string; method?: string }[]; fetchFn: FetchLike }

/** A fetch that records every call and replies with whatever `reply` returns. */
function recorder(reply: (url: string) => Promise<Response>): Recorder {
  const calls: { url: string; method?: string }[] = []
  return {
    calls,
    fetchFn: async (url, init) => {
      calls.push({ url, method: init?.method })
      return reply(url)
    },
  }
}

/** Run a mutation to completion; resolves with the error instead of throwing. */
async function run<TVars>(
  qc: QueryClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: any,
  variables: TVars,
): Promise<{ ok: boolean; error?: Error }> {
  // `any` throughout: each option set has a different TVariables, and the point
  // here is to run the real objects, not to re-derive their generics.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const observer: any = new MutationObserver(qc, options)
  try {
    await observer.mutate(variables)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err as Error }
  }
}

function makeDeps(
  qc: QueryClient,
  fetchFn: FetchLike,
  category: NotificationCategory = 'task',
): NotificationMutationDeps & { errors: string[] } {
  const errors: string[] = []
  return {
    qc,
    category,
    fetchFn,
    reportError: (m: string) => { errors.push(m) },
    errors,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('deleteSingle', () => {
  let qc: QueryClient
  beforeEach(() => { qc = makeClient(); seed(qc) })

  test('successful deletion removes the row and keeps it removed', async () => {
    const rec = recorder(async () => jsonResponse(200, { success: true, deleted: true, id: 't1' }))
    const deps = makeDeps(qc, rec.fetchFn)

    const result = await run(qc, deleteSingleOptions(deps), 't1')

    assert.equal(result.ok, true)
    assert.deepEqual(idsOf(qc, 'task'), ['t2', 't3'])
    assert.deepEqual(deps.errors, [])
    assert.equal(rec.calls.length, 1)
    assert.equal(rec.calls[0].method, 'DELETE')
  })

  test('the row is gone from the cache BEFORE the request resolves', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const deps = makeDeps(qc, async () => {
      // Assert mid-flight: this is the optimistic window the user actually sees.
      assert.deepEqual(idsOf(qc, 'task'), ['t2', 't3'], 'row should already be hidden')
      await gate
      return jsonResponse(200, { success: true, deleted: true })
    })

    const pending = run(qc, deleteSingleOptions(deps), 't1')
    release()
    await pending
    assert.deepEqual(idsOf(qc, 'task'), ['t2', 't3'])
  })

  test('a server 500 rolls the row back and reports an error', async () => {
    const deps = makeDeps(qc, async () => jsonResponse(500, { error: 'Could not delete the notification' }))

    const result = await run(qc, deleteSingleOptions(deps), 't1')

    assert.equal(result.ok, false)
    assert.deepEqual(idsOf(qc, 'task'), ['t1', 't2', 't3'], 'row must be restored')
    assert.equal(countOf(qc, 'task'), 2, 'badge must be restored')
    assert.equal(deps.errors.length, 1)
    assert.match(deps.errors[0], /Could not delete the notification/)
  })

  test('a network failure rolls the row back and reports an error', async () => {
    const deps = makeDeps(qc, async () => { throw new TypeError('Failed to fetch') })

    const result = await run(qc, deleteSingleOptions(deps), 't1')

    assert.equal(result.ok, false)
    assert.deepEqual(idsOf(qc, 'task'), ['t1', 't2', 't3'])
    assert.equal(countOf(qc, 'task'), 2)
    assert.equal(deps.errors.length, 1)
    assert.match(deps.errors[0], /Failed to fetch/)
  })

  test('a non-JSON error body still produces a usable message', async () => {
    const deps = makeDeps(qc, async () => ({
      ok: false,
      status: 502,
      json: async () => { throw new SyntaxError('Unexpected token <') },
    } as unknown as Response))

    await run(qc, deleteSingleOptions(deps), 't1')

    assert.equal(deps.errors.length, 1)
    assert.match(deps.errors[0], /HTTP 502/)
    assert.deepEqual(idsOf(qc, 'task'), ['t1', 't2', 't3'])
  })

  test('deleting an unread row decrements the unread count', async () => {
    const deps = makeDeps(qc, async () => jsonResponse(200, { success: true, deleted: true }))
    await run(qc, deleteSingleOptions(deps), 't1')   // t1 is unread
    assert.equal(countOf(qc, 'task'), 1)
  })

  test('deleting an already-read row leaves the unread count alone', async () => {
    const deps = makeDeps(qc, async () => jsonResponse(200, { success: true, deleted: true }))
    await run(qc, deleteSingleOptions(deps), 't2')   // t2 is read
    assert.equal(countOf(qc, 'task'), 2)
  })

  test('an already-deleted row (deleted:false) is an idempotent success', async () => {
    const deps = makeDeps(qc, async () => jsonResponse(200, { success: true, deleted: false, id: 't1' }))

    const result = await run(qc, deleteSingleOptions(deps), 't1')

    assert.equal(result.ok, true, 'must not be treated as a failure')
    assert.deepEqual(idsOf(qc, 'task'), ['t2', 't3'], 'row must stay removed, not resurrect')
    assert.deepEqual(deps.errors, [], 'no error should be shown')
  })

  test('a successful delete issues exactly ONE request — no reconciliation refetch', async () => {
    // The success path patches the caches directly and only MARKS them stale.
    // A refetch here would be redundant and, worse, could land after the delete
    // and put the row back on screen.
    const rec = recorder(async () => jsonResponse(200, { success: true, deleted: true }))
    const deps = makeDeps(qc, rec.fetchFn)

    await run(qc, deleteSingleOptions(deps), 't1')

    assert.equal(rec.calls.length, 1, `expected 1 request, saw ${rec.calls.length}`)
    assert.equal(rec.calls[0].method, 'DELETE')
    // Stale, so the next mount reconciles with the server...
    assert.equal(qc.getQueryState(notificationKeys.list('task'))?.isInvalidated, true)
    // ...but the correct data is still sitting there for the user to look at.
    assert.deepEqual(idsOf(qc, 'task'), ['t2', 't3'])
  })

  test('a task-scoped delete does not mutate the Finance or Orders caches', async () => {
    const deps = makeDeps(qc, async () => jsonResponse(200, { success: true, deleted: true }), 'task')

    await run(qc, deleteSingleOptions(deps), 't1')

    assert.deepEqual(idsOf(qc, 'finance'), ['f1', 'f2'])
    assert.deepEqual(idsOf(qc, 'order'),   ['o1'])
    assert.equal(countOf(qc, 'finance'), 1)
    assert.equal(countOf(qc, 'order'),   1)
  })

  test('rollback restores every list, not just the acting one', async () => {
    // A row cached in two modules' lists must come back in both.
    qc.setQueryData(notificationKeys.list('finance'), [...FINANCE_ROWS, notif('t1')])
    const deps = makeDeps(qc, async () => jsonResponse(500, { error: 'boom' }))

    await run(qc, deleteSingleOptions(deps), 't1')

    assert.deepEqual(idsOf(qc, 'task'),    ['t1', 't2', 't3'])
    assert.deepEqual(idsOf(qc, 'finance'), ['f1', 'f2', 't1'])
  })

  test('a list that was never fetched stays undefined rather than becoming []', async () => {
    const fresh = makeClient()
    fresh.setQueryData(notificationKeys.list('task'), [...TASK_ROWS])
    const deps = makeDeps(fresh, async () => jsonResponse(500, { error: 'boom' }))

    await run(fresh, deleteSingleOptions(deps), 't1')

    // `undefined` means "not loaded"; `[]` would render as "no notifications".
    assert.equal(listOf(fresh, 'finance'), undefined)
    assert.equal(countOf(fresh, 'finance'), undefined)
  })
})

describe('deleteSingle — duplicate submission', () => {
  test('a rapid double-click sends exactly one DELETE', async () => {
    const qc = makeClient()
    seed(qc)
    const guard = createPendingGuard()
    const rec = recorder(async () => jsonResponse(200, { success: true, deleted: true }))
    const deps: NotificationMutationDeps = {
      qc,
      category: 'task',
      fetchFn: rec.fetchFn,
      reportError: () => {},
      releasePending: (id) => guard.release(id),
    }
    const options = deleteSingleOptions(deps)

    // Exactly what the click handler does — twice, in the same tick, before any
    // re-render could have disabled the button.
    const fire = (id: string) => (guard.tryAcquire(id) ? run(qc, options, id) : null)
    const first  = fire('t1')
    const second = fire('t1')

    assert.notEqual(first, null, 'first click must go through')
    assert.equal(second, null, 'second click must be rejected outright')
    await first

    assert.equal(rec.calls.length, 1, 'exactly one request')
    assert.deepEqual(idsOf(qc, 'task'), ['t2', 't3'])
    assert.equal(guard.size(), 0, 'lock released after settle')
  })

  test('the lock is released after a failure so the user can retry', async () => {
    const qc = makeClient()
    seed(qc)
    const guard = createPendingGuard()
    const deps: NotificationMutationDeps = {
      qc,
      category: 'task',
      fetchFn: async () => jsonResponse(500, { error: 'boom' }),
      reportError: () => {},
      releasePending: (id) => guard.release(id),
    }

    guard.tryAcquire('t1')
    await run(qc, deleteSingleOptions(deps), 't1')

    assert.equal(guard.has('t1'), false, 'a failed delete must not leave the row locked forever')
    assert.deepEqual(idsOf(qc, 'task'), ['t1', 't2', 't3'])
  })
})

describe('createPendingGuard', () => {
  test('acquire is exclusive until released', () => {
    const g = createPendingGuard()
    assert.equal(g.tryAcquire('a'), true)
    assert.equal(g.tryAcquire('a'), false)
    assert.equal(g.tryAcquire('b'), true)
    assert.equal(g.size(), 2)
    g.release('a')
    assert.equal(g.has('a'), false)
    assert.equal(g.tryAcquire('a'), true)
  })

  test('snapshot is a copy, not a live view', () => {
    const g = createPendingGuard()
    g.tryAcquire('a')
    const snap = g.snapshot()
    g.tryAcquire('b')
    assert.deepEqual([...snap], ['a'])
  })
})

describe('deleteSelected', () => {
  let qc: QueryClient
  beforeEach(() => { qc = makeClient(); seed(qc) })

  test('removes every selected row and decrements by the unread ones only', async () => {
    const deps = makeDeps(qc, async () => jsonResponse(200, { success: true, deletedIds: ['t1', 't2'], deletedCount: 2 }))

    await run(qc, deleteSelectedOptions(deps), ['t1', 't2'])   // t1 unread, t2 read

    assert.deepEqual(idsOf(qc, 'task'), ['t3'])
    assert.equal(countOf(qc, 'task'), 1)
  })

  test('a 500 restores every selected row and the count', async () => {
    const deps = makeDeps(qc, async () => jsonResponse(500, { error: 'Could not delete the selected notifications' }))

    const result = await run(qc, deleteSelectedOptions(deps), ['t1', 't2'])

    assert.equal(result.ok, false)
    assert.deepEqual(idsOf(qc, 'task'), ['t1', 't2', 't3'])
    assert.equal(countOf(qc, 'task'), 2)
    assert.equal(deps.errors.length, 1)
  })

  test('a network failure restores every selected row', async () => {
    const deps = makeDeps(qc, async () => { throw new TypeError('Failed to fetch') })
    await run(qc, deleteSelectedOptions(deps), ['t1', 't3'])
    assert.deepEqual(idsOf(qc, 'task'), ['t1', 't2', 't3'])
    assert.equal(countOf(qc, 'task'), 2)
  })
})

describe('deleteAll', () => {
  let qc: QueryClient
  beforeEach(() => { qc = makeClient(); seed(qc) })

  test('clears only the acting module and zeroes only its badge', async () => {
    const rec = recorder(async () => jsonResponse(200, { success: true, category: 'task', deletedCount: 3 }))
    const deps = makeDeps(qc, rec.fetchFn, 'task')

    await run(qc, deleteAllOptions(deps), undefined)

    assert.deepEqual(idsOf(qc, 'task'), [])
    assert.equal(countOf(qc, 'task'), 0)
    // Module scoping — the whole point of the category filter.
    assert.deepEqual(idsOf(qc, 'finance'), ['f1', 'f2'])
    assert.deepEqual(idsOf(qc, 'order'),   ['o1'])
    assert.equal(countOf(qc, 'finance'), 1)
    assert.equal(countOf(qc, 'order'),   1)
    assert.match(rec.calls[0].url, /category=task/)
  })

  test('Finance delete-all sends its own category and spares the task list', async () => {
    const rec = recorder(async () => jsonResponse(200, { success: true, deletedCount: 2 }))
    const deps = makeDeps(qc, rec.fetchFn, 'finance')

    await run(qc, deleteAllOptions(deps), undefined)

    assert.match(rec.calls[0].url, /category=finance/)
    assert.deepEqual(idsOf(qc, 'finance'), [])
    assert.deepEqual(idsOf(qc, 'task'), ['t1', 't2', 't3'])
    assert.equal(countOf(qc, 'task'), 2)
  })

  test('a failure restores the full list and the badge', async () => {
    const deps = makeDeps(qc, async () => jsonResponse(500, { error: 'Could not delete notifications' }))

    const result = await run(qc, deleteAllOptions(deps), undefined)

    assert.equal(result.ok, false)
    assert.deepEqual(idsOf(qc, 'task'), ['t1', 't2', 't3'])
    assert.equal(countOf(qc, 'task'), 2)
  })
})

describe('markRead', () => {
  let qc: QueryClient
  beforeEach(() => { qc = makeClient(); seed(qc) })

  test('flips the row and decrements the badge', async () => {
    const deps = makeDeps(qc, async () => jsonResponse(200, { success: true, updatedCount: 1 }))

    await run(qc, markReadOptions(deps), 't1')

    assert.equal(listOf(qc, 'task')?.find(n => n.id === 't1')?.is_read, true)
    assert.equal(countOf(qc, 'task'), 1)
  })

  test('marking an already-read row does not change the badge', async () => {
    const deps = makeDeps(qc, async () => jsonResponse(200, { success: true, updatedCount: 0 }))
    await run(qc, markReadOptions(deps), 't2')
    assert.equal(countOf(qc, 'task'), 2)
  })

  test('a failure restores both the read flag and the badge', async () => {
    const deps = makeDeps(qc, async () => jsonResponse(500, { error: 'Could not update the notification' }))

    await run(qc, markReadOptions(deps), 't1')

    assert.equal(listOf(qc, 'task')?.find(n => n.id === 't1')?.is_read, false)
    assert.equal(countOf(qc, 'task'), 2)
    assert.equal(deps.errors.length, 1)
  })
})
