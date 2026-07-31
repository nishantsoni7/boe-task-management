/**
 * Sample Tracking notification deletes — behavioural tests
 *
 * These drive the REAL functions the page calls, with `fetch` injected and a
 * tiny state holder standing in for React's useState. So the optimistic write,
 * the snapshot, the rollback and the selection handling under test are exactly
 * the code that runs in the browser — not a re-implementation.
 *
 * Covers:
 *   · single delete removes only the targeted row
 *   · bulk delete removes only the selected rows
 *   · delete all clears the caller's sample notifications
 *   · ids the server does not own come back deleted-nothing, and the client
 *     never sees another user's row
 *   · selection clears after a successful delete
 *   · a 500 / a network throw restores the list and reports an error
 *   · the empty state is reached after everything is deleted
 *   · read/unread flags survive a delete untouched
 *   · the correct endpoint + method is used for each action
 *
 * Run:
 *   npx tsx --test src/lib/sampleNotificationDeletes.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  deleteSampleNotification,
  deleteSelectedSampleNotifications,
  deleteAllSampleNotifications,
  type FetchLike,
  type SampleNotif,
  type SampleNotifState,
  type SampleDeleteDeps,
} from './sampleNotificationDeletes'
import { createPendingGuard } from './notificationMutations'

// ── Fixtures ────────────────────────────────────────────────────────────────

const notif = (id: string, isRead = false): SampleNotif => ({
  id,
  event: 'sample_request_created',
  title: 'Someone created a sample request',
  body: 'SAMPLE-001',
  is_read: isRead,
  created_at: '2026-07-30T10:00:00.000Z',
})

/** s1 unread, s2 read, s3 unread — mixed on purpose, so read-state drift shows. */
const ROWS = () => [notif('s1'), notif('s2', true), notif('s3')]

/** Minimal Response stand-in — only the members the delete code touches. */
const jsonResponse = (status: number, body: unknown): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
} as Response)

type Call = { url: string; method?: string; body?: string }

type Harness = {
  deps: SampleDeleteDeps
  state: () => SampleNotifState
  ids: () => string[]
  calls: Call[]
  released: string[]
}

/**
 * A state holder + recording fetch. `setState` writes synchronously, exactly
 * as the page's does, so a mutation always reads back what it just wrote.
 */
function harness(
  initial: Partial<SampleNotifState>,
  reply: (url: string) => Promise<Response>,
): Harness {
  let state: SampleNotifState = {
    notifs: initial.notifs ?? ROWS(),
    selected: initial.selected ?? new Set<string>(),
    error: initial.error ?? null,
  }
  const calls: Call[] = []
  const released: string[] = []

  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body as string | undefined })
    return reply(url)
  }

  return {
    deps: {
      getState: () => state,
      setState: next => { state = next },
      fetchFn,
      releasePending: id => { released.push(id) },
    },
    state: () => state,
    ids: () => state.notifs.map(n => n.id),
    calls,
    released,
  }
}

const ok = (body: unknown = { success: true }) => async () => jsonResponse(200, body)
const fails = (status: number, body: unknown) => async () => jsonResponse(status, body)
const throws = (message: string) => async (): Promise<Response> => { throw new Error(message) }

// ── Single delete ───────────────────────────────────────────────────────────

describe('deleteSampleNotification', () => {
  test('removes only the targeted row and leaves the others intact', async () => {
    const h = harness({}, ok({ success: true, deleted: true, id: 's2' }))

    await deleteSampleNotification(h.deps, 's2')

    assert.deepEqual(h.ids(), ['s1', 's3'])
    assert.equal(h.state().error, null)
  })

  test('calls DELETE on the sample endpoint, not the task one', async () => {
    const h = harness({}, ok({ success: true, deleted: true }))

    await deleteSampleNotification(h.deps, 's1')

    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].url, '/api/samples/notifications/s1')
    assert.equal(h.calls[0].method, 'DELETE')
  })

  test('drops the row from the selection as well', async () => {
    const h = harness({ selected: new Set(['s1', 's3']) }, ok())

    await deleteSampleNotification(h.deps, 's1')

    assert.deepEqual([...h.state().selected], ['s3'])
  })

  test('leaves read/unread flags on the surviving rows untouched', async () => {
    const h = harness({}, ok())

    await deleteSampleNotification(h.deps, 's1')

    assert.deepEqual(
      h.state().notifs.map(n => [n.id, n.is_read]),
      [['s2', true], ['s3', false]],
    )
  })

  test('an id the server does not own deletes nothing there and stays hidden here', async () => {
    // The route is scoped to `user_id = caller`, so another user's id matches
    // zero rows and comes back `deleted: false`. That is an idempotent success:
    // the row is not resurrected locally, and nothing about it is revealed.
    const h = harness({}, ok({ success: true, deleted: false, id: 'other-user-row' }))

    await deleteSampleNotification(h.deps, 's1')

    assert.deepEqual(h.ids(), ['s2', 's3'])
    assert.equal(h.state().error, null)
  })

  test('a 500 restores the row and reports the server message', async () => {
    const h = harness({}, fails(500, { error: 'Could not delete the notification' }))

    await deleteSampleNotification(h.deps, 's2')

    assert.deepEqual(h.ids(), ['s1', 's2', 's3'])
    assert.equal(h.state().error, 'Could not delete the notification')
  })

  test('a network throw restores the row and reports an error', async () => {
    const h = harness({}, throws('Failed to fetch'))

    await deleteSampleNotification(h.deps, 's2')

    assert.deepEqual(h.ids(), ['s1', 's2', 's3'])
    assert.equal(h.state().error, 'Failed to fetch')
  })

  test('releases its pending lock on success and on failure', async () => {
    const good = harness({}, ok())
    await deleteSampleNotification(good.deps, 's1')
    assert.deepEqual(good.released, ['s1'])

    const bad = harness({}, fails(500, { error: 'nope' }))
    await deleteSampleNotification(bad.deps, 's1')
    assert.deepEqual(bad.released, ['s1'])
  })

  test('a rapid double-click sends exactly one DELETE', async () => {
    // The page guards with createPendingGuard before calling in, exactly as
    // NotificationsView does; this asserts that guard still holds here.
    const h = harness({}, ok())
    const guard = createPendingGuard()

    const fire = (id: string) => {
      if (!guard.tryAcquire(id)) return null
      return deleteSampleNotification({ ...h.deps, releasePending: guard.release }, id)
    }

    await Promise.all([fire('s1'), fire('s1')].filter(Boolean))

    assert.equal(h.calls.length, 1)
    assert.deepEqual(h.ids(), ['s2', 's3'])
  })
})

// ── Bulk delete ─────────────────────────────────────────────────────────────

describe('deleteSelectedSampleNotifications', () => {
  test('removes only the selected rows', async () => {
    const h = harness({ selected: new Set(['s1', 's3']) }, ok({ success: true, deletedIds: ['s1', 's3'] }))

    await deleteSelectedSampleNotifications(h.deps, ['s1', 's3'])

    assert.deepEqual(h.ids(), ['s2'])
  })

  test('clears the selection after a successful delete', async () => {
    const h = harness({ selected: new Set(['s1', 's3']) }, ok())

    await deleteSelectedSampleNotifications(h.deps, ['s1', 's3'])

    assert.equal(h.state().selected.size, 0)
  })

  test('posts the ids to the sample bulk endpoint', async () => {
    const h = harness({ selected: new Set(['s1', 's3']) }, ok())

    await deleteSelectedSampleNotifications(h.deps, ['s1', 's3'])

    assert.equal(h.calls[0].url, '/api/samples/notifications/delete-selected')
    assert.equal(h.calls[0].method, 'POST')
    assert.deepEqual(JSON.parse(h.calls[0].body!), { ids: ['s1', 's3'] })
  })

  test('ids owned by another user delete nothing and are reported as such', async () => {
    // Server echoes back only what the caller actually owned. 's1' was theirs;
    // 'someone-elses' matched zero rows because of the user_id scope.
    const h = harness(
      { selected: new Set(['s1', 'someone-elses']) },
      ok({ success: true, deletedIds: ['s1'], deletedCount: 1 }),
    )

    await deleteSelectedSampleNotifications(h.deps, ['s1', 'someone-elses'])

    // Only the caller's own rows were ever in the list to begin with.
    assert.deepEqual(h.ids(), ['s2', 's3'])
    assert.equal(h.state().error, null)
  })

  test('a 500 restores every row and reports the server message', async () => {
    const h = harness(
      { selected: new Set(['s1', 's3']) },
      fails(500, { error: 'Could not delete the selected notifications' }),
    )

    await deleteSelectedSampleNotifications(h.deps, ['s1', 's3'])

    assert.deepEqual(h.ids(), ['s1', 's2', 's3'])
    assert.equal(h.state().error, 'Could not delete the selected notifications')
  })

  test('a failed bulk delete does not re-select the rolled-back rows', async () => {
    // Matches NotificationsView: selection is cleared the moment the delete is
    // initiated and is never restored, so the user is not left holding a
    // selection they did not make.
    const h = harness({ selected: new Set(['s1', 's3']) }, fails(500, { error: 'boom' }))

    await deleteSelectedSampleNotifications(h.deps, ['s1', 's3'])

    assert.equal(h.state().selected.size, 0)
    assert.deepEqual(h.ids(), ['s1', 's2', 's3'])
  })

  test('an empty selection issues no request at all', async () => {
    const h = harness({}, ok())

    await deleteSelectedSampleNotifications(h.deps, [])

    assert.equal(h.calls.length, 0)
    assert.deepEqual(h.ids(), ['s1', 's2', 's3'])
  })

  test('falls back to a generic message when the error body is not JSON', async () => {
    const h = harness({ selected: new Set(['s1']) }, async () => ({
      ok: false,
      status: 502,
      json: async () => { throw new Error('not json') },
    } as unknown as Response))

    await deleteSelectedSampleNotifications(h.deps, ['s1'])

    assert.equal(h.state().error, 'Could not delete the selected notifications (HTTP 502)')
    assert.deepEqual(h.ids(), ['s1', 's2', 's3'])
  })
})

// ── Delete all ──────────────────────────────────────────────────────────────

describe('deleteAllSampleNotifications', () => {
  test('empties the list and reaches the empty state', async () => {
    const h = harness({ selected: new Set(['s1']) }, ok({ success: true, deletedCount: 3 }))

    await deleteAllSampleNotifications(h.deps)

    assert.deepEqual(h.ids(), [])
    assert.equal(h.state().selected.size, 0)
    assert.equal(h.state().error, null)
  })

  test('calls DELETE on the sample collection endpoint with no category param', async () => {
    // `sample_notifications` holds nothing but Sample Tracking rows, so there is
    // no category to scope by — and no way for this to reach another module.
    const h = harness({}, ok())

    await deleteAllSampleNotifications(h.deps)

    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].url, '/api/samples/notifications')
    assert.equal(h.calls[0].method, 'DELETE')
  })

  test('a 500 restores the whole list and reports the server message', async () => {
    const h = harness({}, fails(500, { error: 'Could not delete notifications' }))

    await deleteAllSampleNotifications(h.deps)

    assert.deepEqual(h.ids(), ['s1', 's2', 's3'])
    assert.equal(h.state().error, 'Could not delete notifications')
  })

  test('a restored list keeps its original read/unread flags', async () => {
    const h = harness({}, fails(500, { error: 'boom' }))

    await deleteAllSampleNotifications(h.deps)

    assert.deepEqual(
      h.state().notifs.map(n => [n.id, n.is_read]),
      [['s1', false], ['s2', true], ['s3', false]],
    )
  })

  test('deleting an already-empty inbox is a success, not an error', async () => {
    const h = harness({ notifs: [] }, ok({ success: true, deletedCount: 0 }))

    await deleteAllSampleNotifications(h.deps)

    assert.deepEqual(h.ids(), [])
    assert.equal(h.state().error, null)
  })
})

// ── Cross-action ────────────────────────────────────────────────────────────

describe('sample deletes never touch task notifications', () => {
  test('every request goes to /api/samples/notifications*', async () => {
    const h = harness({ selected: new Set(['s1']) }, ok())

    await deleteSampleNotification(h.deps, 's3')
    await deleteSelectedSampleNotifications(h.deps, ['s1'])
    await deleteAllSampleNotifications(h.deps)

    assert.equal(h.calls.length, 3)
    for (const c of h.calls) {
      assert.ok(
        c.url.startsWith('/api/samples/notifications'),
        `expected a sample endpoint, got ${c.url}`,
      )
    }
  })
})
