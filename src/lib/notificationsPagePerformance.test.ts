/**
 * Notifications page: bounded loading, no duplicate identity work, and a shell
 * that stays interactive while the list resolves.
 *
 * Three defects are held shut here:
 *   1. the page unmounted the whole module shell behind a full-screen spinner,
 *      so arriving froze the sidebar and LEAVING had to wait for a notification
 *      request nobody still needed;
 *   2. it made its own `supabase.auth.getUser()` — a network call to the auth
 *      server — and then a second request for the profile row, both of which
 *      the surrounding layout had already made on the same navigation;
 *   3. nothing warmed the route, so the click paid for a chunk download first.
 *
 * Run:
 *   npx tsx --test src/lib/notificationsPagePerformance.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { QueryClient } from '@tanstack/react-query'
import type { Notification } from './types'
import {
  NOTIFICATION_PAGE_SIZE,
  NOTIFICATION_MAX_ROWS,
  nextNotificationLimit,
} from './notificationPaging'
import { profileKey } from '../hooks/queries/useProfile'
import {
  fetchNotificationPage,
  fetchNotificationList,
  notificationKeys,
  patchUnreadCount,
  setUnreadCount,
  countUnreadAmong,
  removeNotificationsFromLists,
  readApiErrorMessage,
} from './notificationCache'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/**
 * Source with comments removed.
 *
 * These files EXPLAIN what they no longer do — "this replaces a per-mount
 * auth.getUser()", "there is deliberately no LoadingScreen here" — so a naive
 * substring search finds the prose and reports the very thing the comment says
 * was removed. Absence assertions run against code only.
 */
const codeOf = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const LIST_ROUTE = read('src/app/api/notifications/route.ts')
const VIEW       = read('src/components/notifications/NotificationsView.tsx')
const VIEW_CODE  = codeOf(VIEW)
const HOOK       = read('src/hooks/queries/useNotifications.ts')
const HOOK_CODE  = codeOf(HOOK)
const NAV_ITEM   = read('src/components/layout/NotificationsNavItem.tsx')
const NAV_CODE   = codeOf(NAV_ITEM)

const notif = (id: string, isRead = false): Notification => ({
  id, user_id: 'u1', task_id: null, entity_id: null,
  type: 'task_acknowledged', title: 't', body: 'b',
  is_read: isRead, is_push_sent: true, is_digest: false,
  created_at: '2026-08-26T10:00:00.000Z', read_at: null,
} as unknown as Notification)

// ── 1. The initial query is bounded ─────────────────────────────────────────

describe('the first page is bounded', () => {
  test('the page opens on a sensible first page, not the full history', () => {
    assert.equal(NOTIFICATION_PAGE_SIZE, 50)
    assert.ok(NOTIFICATION_PAGE_SIZE > 0 && NOTIFICATION_PAGE_SIZE <= NOTIFICATION_MAX_ROWS)
  })

  test('the client asks for exactly that bound', async () => {
    const urls: string[] = []
    const fetchFn = async (url: string) => {
      urls.push(url)
      return { ok: true, status: 200, json: async () => ({ notifications: [notif('a')], hasMore: false }) } as Response
    }
    await fetchNotificationList('task', fetchFn)
    assert.equal(urls.length, 1)
    assert.match(urls[0], new RegExp(`limit=${NOTIFICATION_PAGE_SIZE}(\\b|$)`))
    assert.match(urls[0], /category=task/)
  })

  test('the server clamps any requested limit to the ceiling', () => {
    // A `?limit=` a caller invents cannot pull the history down.
    assert.ok(LIST_ROUTE.includes('function clampNotificationLimit'))
    assert.ok(LIST_ROUTE.includes('Math.min(Math.floor(n), NOTIFICATION_MAX_ROWS)'))
    assert.ok(LIST_ROUTE.includes('if (!Number.isFinite(n) || n < 1) return NOTIFICATION_PAGE_SIZE'))
    // Every list read is limited, always.
    assert.ok(LIST_ROUTE.includes('.limit(limit + 1)'))
    assert.equal(/\.limit\(\)/.test(LIST_ROUTE), false)
  })

  test('the ceiling really is a ceiling', () => {
    let n = NOTIFICATION_PAGE_SIZE
    for (let i = 0; i < 50; i++) n = nextNotificationLimit(n)
    assert.equal(n, NOTIFICATION_MAX_ROWS)
    assert.equal(nextNotificationLimit(NOTIFICATION_MAX_ROWS), NOTIFICATION_MAX_ROWS)
  })

  test('"Load older" raises the bound one page at a time', () => {
    assert.equal(nextNotificationLimit(50), 100)
    assert.equal(nextNotificationLimit(100), 150)
  })

  test('hasMore comes from the server, and an absent flag means "do not offer more"', async () => {
    const page = async (body: unknown) => fetchNotificationPage('task', 50,
      async () => ({ ok: true, status: 200, json: async () => body } as Response))

    assert.equal((await page({ notifications: [], hasMore: true })).hasMore, true)
    assert.equal((await page({ notifications: [], hasMore: false })).hasMore, false)
    assert.equal((await page({ notifications: [] })).hasMore, false)
  })

  test('a failed page throws rather than reading as an empty inbox', async () => {
    await assert.rejects(
      () => fetchNotificationPage('task', 50,
        async () => ({ ok: false, status: 500, json: async () => ({ error: 'nope' }) } as Response)),
      /nope/,
    )
  })
})

// ── 2. The unread count stays correct ───────────────────────────────────────

describe('unread count', () => {
  test('the badge reads its own endpoint, not the bounded list', () => {
    // A bounded list cannot know the category total, so deriving the badge from
    // it would understate a busy inbox. The count path is a separate exact
    // count and stays that way.
    assert.ok(LIST_ROUTE.includes("count: 'exact', head: true"))
    assert.ok(LIST_ROUTE.includes('NOT the category’s total unread')
      || LIST_ROUTE.includes('NOT the category'))
  })

  test('the count is shared by one key across every module shell', () => {
    assert.deepEqual(notificationKeys.count('task'), ['notifications', 'count'])
    assert.deepEqual(notificationKeys.list('task'),  ['notifications', 'task'])
  })

  test('mark-read patches the count by a known delta', () => {
    const qc = new QueryClient()
    qc.setQueryData(notificationKeys.count('task'), { unreadCount: 4 })
    patchUnreadCount(qc, 'task', -1)
    assert.deepEqual(qc.getQueryData(notificationKeys.count('task')), { unreadCount: 3 })
    patchUnreadCount(qc, 'task', -10)
    assert.deepEqual(qc.getQueryData(notificationKeys.count('task')), { unreadCount: 0 })
    qc.clear()
  })

  test('mark-all-read / delete-all set it exactly', () => {
    const qc = new QueryClient()
    qc.setQueryData(notificationKeys.count('task'), { unreadCount: 7 })
    setUnreadCount(qc, 'task', 0)
    assert.deepEqual(qc.getQueryData(notificationKeys.count('task')), { unreadCount: 0 })
    qc.clear()
  })

  test('deleting selected removes exactly those rows and counts their unreads', () => {
    const qc = new QueryClient()
    const rows = [notif('a'), notif('b', true), notif('c')]
    qc.setQueryData(notificationKeys.list('task'), rows)
    qc.setQueryData(notificationKeys.count('task'), { unreadCount: 2 })

    const ids = new Set(['a', 'b'])
    const unreadRemoved = countUnreadAmong(rows, ids)
    assert.equal(unreadRemoved, 1)

    removeNotificationsFromLists(qc, ids)
    patchUnreadCount(qc, 'task', -unreadRemoved)

    assert.deepEqual((qc.getQueryData(notificationKeys.list('task')) as Notification[]).map(n => n.id), ['c'])
    assert.deepEqual(qc.getQueryData(notificationKeys.count('task')), { unreadCount: 1 })
    qc.clear()
  })

  test('"Load older" writes into the same list key every mutation addresses', () => {
    // If the wider page landed on a different key, deletes and mark-read would
    // be writing somewhere nobody renders.
    assert.ok(HOOK.includes('qc.setQueryData<Notification[]>(notificationKeys.list(category), page.notifications)'))
    assert.ok(HOOK.includes('queryKey: notificationKeys.list(category)'))
    assert.equal(/queryKey:\s*\[.*limit/.test(HOOK_CODE), false, 'the limit must not enter the query key')
  })

  test('it cancels in-flight reads before widening, like the mutations do', () => {
    assert.ok(HOOK.includes('await qc.cancelQueries({ queryKey: notificationKeys.list(category), exact: true })'))
  })
})

// ── 3. Mutations still invalidate narrowly ──────────────────────────────────

describe('mutations invalidate only what they touched', () => {
  const MUTATIONS = read('src/lib/notificationMutations.ts')

  test('reconciliation is scoped to this module’s list and count', () => {
    assert.ok(MUTATIONS.includes('notificationKeys.list(deps.category)'))
    assert.ok(MUTATIONS.includes('notificationKeys.count(deps.category)'))
    assert.ok(MUTATIONS.includes("refetchType: 'none'"))
  })

  test('no mutation invalidates the whole notifications prefix', () => {
    assert.equal(
      /invalidateQueries\(\{\s*queryKey:\s*notificationKeys\.root\(\)/.test(MUTATIONS), false,
      'invalidating the root refetches every module list and every badge',
    )
  })

  test('delete-selected and delete-all endpoints are still wired', () => {
    assert.ok(MUTATIONS.includes('/api/notifications/delete-selected'))
    assert.ok(MUTATIONS.includes("method: 'DELETE'"))
    assert.ok(MUTATIONS.includes('/api/notifications/mark-read'))
  })
})

// ── 4. Nothing about the shell waits on notifications ───────────────────────

describe('the module shell stays interactive', () => {
  test('the view never replaces the layout with a loading screen', () => {
    assert.equal(VIEW_CODE.includes('LoadingScreen'), false,
      'a full-screen loader unmounts the sidebar and blocks navigating away')
    assert.ok(VIEW.includes('<NotificationListSkeleton />'),
      'the list area alone shows a placeholder')
  })

  test('the skeleton is chosen before any empty state can be drawn', () => {
    const skeletonAt = VIEW_CODE.indexOf('loadingFirstPage ? (')
    const emptyAt    = VIEW_CODE.indexOf('No notifications yet')
    assert.ok(skeletonAt > -1 && emptyAt > -1)
    assert.ok(skeletonAt < emptyAt,
      '"No notifications yet" must be unreachable until the query has answered')
  })

  test('the loading flag is isPending, not isLoading', () => {
    // isLoading is false for a query that has not begun fetching — exactly the
    // window in which the empty state used to flash.
    assert.ok(VIEW.includes('isPending: notifPending'))
    assert.ok(VIEW.includes('const loadingFirstPage = notifPending'))
    assert.equal(/isLoading:\s*notif/.test(VIEW_CODE), false)
  })

  test('the skeleton is layout-stable and announced', () => {
    const skeleton = read('src/components/notifications/NotificationListSkeleton.tsx')
    assert.ok(skeleton.includes("aria-busy=\"true\""))
    assert.ok(skeleton.includes("role=\"status\""))
    assert.ok(skeleton.includes("maxWidth: '900px'"), 'same width as the real card')
  })
})

// ── 5. Duplicate identity work is gone ──────────────────────────────────────

describe('no duplicate auth / profile / permission requests', () => {
  test('the view makes no auth-server call of its own', () => {
    assert.equal(VIEW_CODE.includes('auth.getUser()'), false,
      'getUser() is a network round trip the layout had already made')
    assert.equal(VIEW_CODE.includes('auth.getSession()'), false)
  })

  test('it reads identity from the shared session query, not a request', () => {
    assert.ok(VIEW.includes('useSignedInUserId'))
    assert.ok(VIEW.includes('const { data: userId, isPending: idPending } = useSignedInUserId()'))
    const hook = read('src/hooks/queries/usePermissionContext.ts')
    assert.ok(hook.includes('export function useSignedInUserId()'), 'exported for identity-only callers')
    assert.ok(hook.includes('auth.getSession()'), 'a stored-session read, not an auth-server round trip')
  })

  test('it does NOT pull the permission resolution in behind it', () => {
    // OrdersLayout and AttendancePayrollLayout resolve no permissions, and
    // /orders|/attendance|/payroll|/my-issues notifications sit under no
    // ModuleGuard. Taking usePermissionContext here would add a
    // resolve_effective_permissions_for_user RPC to their cold load.
    // The module PATH still contains the name — the hook it imports lives
    // there. What must be absent is the call.
    assert.equal(VIEW_CODE.includes('usePermissionContext('), false)
    assert.equal(VIEW_CODE.includes('permissionsByModule'), false)
  })

  test('the profile read is a cache hit wherever a shell already resolved it', () => {
    const ctx     = read('src/hooks/queries/usePermissionContext.ts')
    const profile = read('src/hooks/queries/useProfile.ts')
    // Both read the same users row with the same columns; one shared key means
    // the second reader pays nothing and the two cannot disagree.
    assert.ok(profile.includes("export const profileKey = (userId: string | null | undefined) => ['profile', userId] as const"))
    assert.ok(profile.includes('queryKey: profileKey(userId)'))
    assert.ok(ctx.includes('publishProfile(qc, userId, profile)'))
    assert.ok(ctx.includes('qc.setQueryData(profileKey(userId), profile)'))
    // Publish only — the context must never SUBSCRIBE to the profile query, or
    // it would start one on a route that only wanted permissions.
    assert.equal(ctx.includes('useProfile('), false)
  })

  test('the published key IS the key useProfile reads', () => {
    // Behavioural, not textual: if these two ever drifted apart the publish
    // would be writing into a cache entry nobody observes, and the profile
    // would silently be fetched twice again.
    const qc = new QueryClient()
    const profile = { id: 'u1', full_name: 'Ada', role: 'admin' }
    qc.setQueryData(profileKey('u1'), profile)
    assert.deepEqual(qc.getQueryData(['profile', 'u1']), profile)
    // And it is per-user, so one person's row can never be served for another.
    assert.equal(qc.getQueryData(profileKey('u2')), undefined)
    qc.clear()
  })

  test('a failed profile read is not published as an answer', () => {
    const ctx = read('src/hooks/queries/usePermissionContext.ts')
    assert.ok(ctx.includes('if (!profile) return'),
      '"the read failed" and "this person has no row" are not the same answer')
  })

  test('it still redirects a signed-out visitor, and only once resolved', () => {
    assert.ok(VIEW.includes('if (authReady && !userId) router.push(loginRedirectPath)'))
  })

  test('mounting no longer forces a second identical list request', () => {
    // The refresh effect skips its first run; mounting already fetches.
    assert.ok(VIEW.includes('if (lastRefreshKey.current === refreshKey) return'))
  })
})

// ── 6. The route is warmed ──────────────────────────────────────────────────

describe('route prefetch', () => {
  test('the sidebar entry warms its destination on mount', () => {
    assert.ok(NAV_ITEM.includes('router.prefetch(href)'))
  })

  test('it prefetches the route it navigates to', () => {
    assert.ok(NAV_ITEM.includes('router.push(href)'))
    assert.ok(NAV_ITEM.includes("href = '/notifications'"))
  })

  test('prefetching pulls no notification data', () => {
    assert.equal(/prefetch\([^)]*api\//.test(NAV_CODE), false)
  })
})

// ── 7. Error text ───────────────────────────────────────────────────────────

describe('failures stay legible', () => {
  test('a thrown error is rendered as its message, with a fallback', () => {
    assert.equal(readApiErrorMessage(new Error('boom'), 'fallback'), 'boom')
    assert.equal(readApiErrorMessage(new Error(''), 'fallback'), 'fallback')
    assert.equal(readApiErrorMessage('nope', 'fallback'), 'fallback')
  })

  test('"Load older" cannot resurrect a row a mutation has optimistically removed', () => {
    // A widening re-read returns server state, which during an in-flight delete
    // or mark-read is still the OLD state.
    assert.ok(VIEW_CODE.includes('const mutationInFlight ='))
    assert.ok(VIEW_CODE.includes('pendingDeletes.size > 0 || markingAll || deletingBulk || deletingAll'))
    assert.ok(VIEW_CODE.includes('useNotifications(category, mutationInFlight)'))
    assert.ok(HOOK_CODE.includes('if (loadingOlder || blocked) return'))
    assert.ok(HOOK_CODE.includes('&& !blocked'), 'the control is also hidden, not just inert')
  })

  test('"Load older" replaces rather than appends, so duplicates are impossible', () => {
    // There is no merge step. A row arriving between loads is simply included
    // at the top; with an OFFSET it would shift every later row and repeat one.
    assert.ok(HOOK_CODE.includes('qc.setQueryData<Notification[]>(notificationKeys.list(category), page.notifications)'))
    assert.equal(/\.\.\.(prev|old|current)/.test(HOOK_CODE), false, 'nothing is concatenated')
    assert.equal(/offset|range\(/.test(HOOK_CODE), false)
  })

  test('the server sort is total, so overlapping windows agree', () => {
    // created_at is not unique — batch inserts share a transaction timestamp —
    // so ordering by it alone lets a tied row fall on either side of the LIMIT.
    const listAt = LIST_ROUTE.indexOf(".order('created_at', { ascending: false })")
    const idAt   = LIST_ROUTE.indexOf(".order('id', { ascending: false })")
    assert.ok(listAt > -1 && idAt > listAt, 'id breaks the tie, after created_at')
  })

  test('the ceiling the query function reads is updated before the cache is', () => {
    // Otherwise an invalidation landing between setQueryData and the next
    // render would re-request the narrower page and shrink the list back.
    const ref   = HOOK_CODE.indexOf('limitRef.current = next')
    const write = HOOK_CODE.indexOf('qc.setQueryData<Notification[]>')
    assert.ok(ref > -1 && write > ref)
    assert.ok(HOOK_CODE.includes('fetchNotificationPage(category, limitRef.current, fetch, previewSubjectId)'),
      'the query function reads the ref, not the render-time state')
  })

  test('a failed "Load older" surfaces in the banner without dropping the list', () => {
    assert.ok(HOOK.includes("setOlderError(readApiErrorMessage(err, 'Could not load older notifications.'))"))
    assert.ok(VIEW.includes('?? olderError'))
  })
})
