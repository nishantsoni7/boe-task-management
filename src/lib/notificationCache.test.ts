/**
 * Notification cache helpers — behavioural tests
 *
 * Covers the query-key contract (which the whole invalidation strategy rests
 * on), the snapshot/restore/patch primitives, and the list fetch — specifically
 * that a failed list request surfaces as an error rather than masquerading as
 * an empty inbox.
 *
 * Run:
 *   npx tsx --test src/lib/notificationCache.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { QueryClient } from '@tanstack/react-query'
import type { Notification } from './types'
import {
  notificationKeys,
  snapshotNotificationCache,
  restoreNotificationCache,
  removeNotificationsFromLists,
  patchUnreadCount,
  setUnreadCount,
  countUnreadAmong,
  readApiError,
  fetchNotificationList,
  NOTIFICATION_CATEGORIES,
} from './notificationCache'

const notif = (id: string, isRead = false): Notification => ({
  id, user_id: 'u1', task_id: null, entity_id: null,
  type: 'task_assigned', title: 't', body: 'b',
  is_read: isRead, is_push_sent: true, is_digest: false,
  created_at: '2026-07-29T10:00:00.000Z', read_at: null,
} as unknown as Notification)

const jsonResponse = (status: number, body: unknown): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
} as Response)

describe('notificationKeys', () => {
  test('list keys are one per module and mutually distinct', () => {
    assert.deepEqual(notificationKeys.list('task'),    ['notifications', 'task'])
    assert.deepEqual(notificationKeys.list('finance'), ['notifications', 'finance'])
    assert.deepEqual(notificationKeys.list('order'),   ['notifications', 'order'])
  })

  test('the task count key keeps its historic un-suffixed shape', () => {
    // Every module sidebar has read ['notifications','count'] since before
    // categories existed — changing it would orphan those badges.
    assert.deepEqual(notificationKeys.count('task'),    ['notifications', 'count'])
    assert.deepEqual(notificationKeys.count('finance'), ['notifications', 'count', 'finance'])
    assert.deepEqual(notificationKeys.count('order'),   ['notifications', 'count', 'order'])
  })

  test('no list key collides with a count key', () => {
    // ['notifications','count'] would collide with a list for a category named
    // 'count' — this asserts no such category exists.
    const lists = NOTIFICATION_CATEGORIES.map(c => JSON.stringify(notificationKeys.list(c)))
    const counts = NOTIFICATION_CATEGORIES.map(c => JSON.stringify(notificationKeys.count(c)))
    for (const c of counts) assert.equal(lists.includes(c), false, `${c} collides with a list key`)
  })

  test('a count key is never a prefix of a list key', () => {
    // TanStack invalidates by prefix. If ['notifications','count'] prefixed a
    // list key, invalidating the badges would also refetch a list — the exact
    // over-invalidation this refactor removes.
    for (const c of NOTIFICATION_CATEGORIES) {
      const count = notificationKeys.count(c) as readonly unknown[]
      for (const l of NOTIFICATION_CATEGORIES) {
        const list = notificationKeys.list(l) as readonly unknown[]
        const isPrefix = count.length <= list.length && count.every((seg, i) => seg === list[i])
        assert.equal(isPrefix, false, `count(${c}) prefixes list(${l})`)
      }
    }
  })
})

describe('snapshot / restore', () => {
  test('restores lists and counts exactly, including undefined', () => {
    const qc = new QueryClient()
    qc.setQueryData(notificationKeys.list('task'), [notif('a'), notif('b')])
    qc.setQueryData(notificationKeys.count('task'), { unreadCount: 2 })
    // finance/order intentionally unseeded

    const snap = snapshotNotificationCache(qc)

    qc.setQueryData(notificationKeys.list('task'), [])
    qc.setQueryData(notificationKeys.count('task'), { unreadCount: 0 })
    qc.setQueryData(notificationKeys.list('finance'), [notif('x')])

    restoreNotificationCache(qc, snap)

    assert.deepEqual(
      qc.getQueryData<Notification[]>(notificationKeys.list('task'))?.map(n => n.id),
      ['a', 'b'],
    )
    assert.deepEqual(qc.getQueryData(notificationKeys.count('task')), { unreadCount: 2 })
    // Finance was undefined when snapshotted, so it must go back to undefined —
    // not to [], which would render as "no notifications". Restoring an
    // undefined snapshot removes the entry, because setQueryData(key, undefined)
    // is a no-op in TanStack and would leave stale data in place.
    assert.equal(qc.getQueryData(notificationKeys.list('finance')), undefined)
  })

  test('rolling back a delete-all on an unfetched list does not leave it empty', () => {
    // The concrete regression: "Delete all" optimistically writes [], the
    // request fails, and a naive restore (setQueryData with undefined) is a
    // no-op — so the page keeps showing an empty inbox that was never real.
    const qc = new QueryClient()
    const snap = snapshotNotificationCache(qc)          // nothing loaded yet
    qc.setQueryData(notificationKeys.list('task'), [])  // optimistic clear
    restoreNotificationCache(qc, snap)
    assert.equal(qc.getQueryData(notificationKeys.list('task')), undefined)
  })

  test('the snapshot is not aliased to the live cache', () => {
    const qc = new QueryClient()
    const rows = [notif('a'), notif('b')]
    qc.setQueryData(notificationKeys.list('task'), rows)

    const snap = snapshotNotificationCache(qc)
    removeNotificationsFromLists(qc, new Set(['a']))
    restoreNotificationCache(qc, snap)

    assert.deepEqual(
      qc.getQueryData<Notification[]>(notificationKeys.list('task'))?.map(n => n.id),
      ['a', 'b'],
    )
  })
})

describe('removeNotificationsFromLists', () => {
  test('removes from every populated list and leaves unfetched ones undefined', () => {
    const qc = new QueryClient()
    qc.setQueryData(notificationKeys.list('task'),    [notif('a'), notif('b')])
    qc.setQueryData(notificationKeys.list('finance'), [notif('a'), notif('c')])

    removeNotificationsFromLists(qc, new Set(['a']))

    assert.deepEqual(qc.getQueryData<Notification[]>(notificationKeys.list('task'))?.map(n => n.id), ['b'])
    assert.deepEqual(qc.getQueryData<Notification[]>(notificationKeys.list('finance'))?.map(n => n.id), ['c'])
    assert.equal(qc.getQueryData(notificationKeys.list('order')), undefined)
  })

  test('an empty id set is a no-op', () => {
    const qc = new QueryClient()
    const rows = [notif('a')]
    qc.setQueryData(notificationKeys.list('task'), rows)
    removeNotificationsFromLists(qc, new Set())
    assert.equal(qc.getQueryData(notificationKeys.list('task')), rows, 'same reference — nothing rewritten')
  })
})

describe('unread count patching', () => {
  test('patch applies a delta and clamps at zero', () => {
    const qc = new QueryClient()
    qc.setQueryData(notificationKeys.count('task'), { unreadCount: 2 })
    patchUnreadCount(qc, 'task', -1)
    assert.deepEqual(qc.getQueryData(notificationKeys.count('task')), { unreadCount: 1 })
    patchUnreadCount(qc, 'task', -5)
    assert.deepEqual(qc.getQueryData(notificationKeys.count('task')), { unreadCount: 0 })
  })

  test('patch no-ops when the badge was never fetched', () => {
    const qc = new QueryClient()
    patchUnreadCount(qc, 'task', -1)
    assert.equal(qc.getQueryData(notificationKeys.count('task')), undefined)
  })

  test('patch only touches the named module', () => {
    const qc = new QueryClient()
    qc.setQueryData(notificationKeys.count('task'),    { unreadCount: 3 })
    qc.setQueryData(notificationKeys.count('finance'), { unreadCount: 4 })
    patchUnreadCount(qc, 'task', -1)
    assert.deepEqual(qc.getQueryData(notificationKeys.count('finance')), { unreadCount: 4 })
  })

  test('set writes an exact value and also no-ops when unfetched', () => {
    const qc = new QueryClient()
    setUnreadCount(qc, 'task', 0)
    assert.equal(qc.getQueryData(notificationKeys.count('task')), undefined)
    qc.setQueryData(notificationKeys.count('task'), { unreadCount: 9 })
    setUnreadCount(qc, 'task', 0)
    assert.deepEqual(qc.getQueryData(notificationKeys.count('task')), { unreadCount: 0 })
  })

  test('countUnreadAmong counts only unread rows in the id set', () => {
    const rows = [notif('a'), notif('b', true), notif('c')]
    assert.equal(countUnreadAmong(rows, new Set(['a', 'b'])), 1)
    assert.equal(countUnreadAmong(rows, new Set(['a', 'c'])), 2)
    assert.equal(countUnreadAmong(rows, new Set(['b'])), 0)
    assert.equal(countUnreadAmong(undefined, new Set(['a'])), 0)
  })
})

describe('readApiError', () => {
  test('prefers the server error message', async () => {
    assert.equal(await readApiError(jsonResponse(500, { error: 'Boom' }), 'fallback'), 'Boom')
  })

  test('falls back with the status for a non-JSON body', async () => {
    const res = { ok: false, status: 502, json: async () => { throw new Error('bad') } } as unknown as Response
    assert.equal(await readApiError(res, 'Nope'), 'Nope (HTTP 502)')
  })

  test('falls back when the error field is blank', async () => {
    assert.equal(await readApiError(jsonResponse(500, { error: '   ' }), 'Nope'), 'Nope (HTTP 500)')
  })
})

describe('fetchNotificationList', () => {
  test('returns the rows on success', async () => {
    const rows = await fetchNotificationList('task', async () =>
      jsonResponse(200, { notifications: [notif('a')], unreadCount: 1 }))
    assert.deepEqual(rows.map(n => n.id), ['a'])
  })

  test('a missing notifications field yields an empty array, not a crash', async () => {
    assert.deepEqual(await fetchNotificationList('task', async () => jsonResponse(200, {})), [])
  })

  test('a failed request THROWS — it must not masquerade as an empty inbox', async () => {
    // The regression this guards: returning [] made a 500 indistinguishable
    // from "you have no notifications", and React Query cached it as success.
    await assert.rejects(
      () => fetchNotificationList('task', async () => jsonResponse(500, { error: 'DB unavailable' })),
      /DB unavailable/,
    )
  })

  test('a network throw propagates rather than being swallowed', async () => {
    await assert.rejects(
      () => fetchNotificationList('task', async () => { throw new TypeError('Failed to fetch') }),
      /Failed to fetch/,
    )
  })

  test('an error result is never cached as data by React Query', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await assert.rejects(() => qc.fetchQuery({
      queryKey: notificationKeys.list('task'),
      queryFn: () => fetchNotificationList('task', async () => jsonResponse(500, { error: 'boom' })),
    }))
    assert.equal(qc.getQueryData(notificationKeys.list('task')), undefined)
    assert.equal(qc.getQueryState(notificationKeys.list('task'))?.status, 'error')
  })

  test('a failed refetch leaves previously loaded rows visible', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const key = notificationKeys.list('task')
    let fail = false
    const queryFn = () => fetchNotificationList('task', async () =>
      fail ? jsonResponse(500, { error: 'boom' }) : jsonResponse(200, { notifications: [notif('a')] }))

    await qc.fetchQuery({ queryKey: key, queryFn })
    fail = true
    await assert.rejects(() => qc.fetchQuery({ queryKey: key, queryFn, staleTime: 0 }))

    // Still there — the user keeps seeing their inbox instead of it blanking.
    assert.deepEqual(qc.getQueryData<Notification[]>(key)?.map(n => n.id), ['a'])
  })

  test('the request carries the module category', async () => {
    const urls: string[] = []
    await fetchNotificationList('finance', async (u) => { urls.push(u); return jsonResponse(200, { notifications: [] }) })
    assert.match(urls[0], /category=finance/)
  })
})
