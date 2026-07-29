// Shared React Query key helpers + cache primitives for notifications.
//
// Why this file exists: notification query keys were previously written out as
// literals in four different places (useNotifications, useUnreadNotifications,
// NotificationsView's mutations, and the layouts' badge hooks). Because
// TanStack matches keys by PREFIX, small inconsistencies there had real
// consequences — e.g. invalidating ['notifications'] fans out to all three
// module lists AND all three unread counts (six refetches for one delete).
// Every key now comes from `notificationKeys` so list / count / mutate can
// never disagree again.
//
// Key shapes are UNCHANGED from what was already in use — this file only
// centralises them:
//   list  task    -> ['notifications', 'task']
//   list  finance -> ['notifications', 'finance']
//   list  order   -> ['notifications', 'order']
//   count task    -> ['notifications', 'count']              (historic default)
//   count finance -> ['notifications', 'count', 'finance']
//   count order   -> ['notifications', 'count', 'order']
//
// NOTE the deliberate asymmetry on the task count key: it is ['notifications',
// 'count'] with no trailing category, because every module sidebar has been
// reading that exact key since before categories existed. Changing it would
// silently orphan those badges, so it stays.

import type { QueryClient } from '@tanstack/react-query'
import type { Notification } from '@/lib/types'
import type { NotificationCategory } from '@/lib/notifications'

/** Every module whose notifications live in the shared `notifications` table. */
export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = ['task', 'finance', 'order']

export const notificationKeys = {
  /** Prefix covering every notification query (lists AND counts). Broadest possible. */
  root: () => ['notifications'] as const,
  /** One module's notification list. */
  list: (category: NotificationCategory) => ['notifications', category] as const,
  /** Prefix covering every module's unread count — matches all three count keys. */
  countRoot: () => ['notifications', 'count'] as const,
  /** One module's unread count. `task` keeps the historic un-suffixed key. */
  count: (category: NotificationCategory) =>
    (category === 'task'
      ? (['notifications', 'count'] as const)
      : (['notifications', 'count', category] as const)),
} as const

export type NotificationListSnapshot = {
  category: NotificationCategory
  data: Notification[] | undefined
}[]

export type UnreadCountShape = { unreadCount: number }

export type NotificationCountSnapshot = {
  category: NotificationCategory
  data: UnreadCountShape | undefined
}[]

export type NotificationCacheSnapshot = {
  lists: NotificationListSnapshot
  counts: NotificationCountSnapshot
}

/**
 * Capture every notification list AND count cache before an optimistic update.
 *
 * All three categories are snapshotted, not just the active view's: a single
 * row can legitimately sit in more than one cache (a user who has visited
 * /notifications and /finance/notifications in the same session holds two
 * lists), and a rollback that restored only the active one would leave the
 * others permanently wrong. `undefined` entries are preserved as `undefined`
 * so restoring never fabricates an empty list for a cache that was never
 * populated — that would read as "no notifications" instead of "not loaded".
 */
export function snapshotNotificationCache(qc: QueryClient): NotificationCacheSnapshot {
  return {
    lists: NOTIFICATION_CATEGORIES.map(category => ({
      category,
      data: qc.getQueryData<Notification[]>(notificationKeys.list(category)),
    })),
    counts: NOTIFICATION_CATEGORIES.map(category => ({
      category,
      data: qc.getQueryData<UnreadCountShape>(notificationKeys.count(category)),
    })),
  }
}

/**
 * Put every snapshotted list/count cache back exactly as it was.
 *
 * A snapshotted `undefined` is restored by REMOVING the cache entry, not by
 * writing `undefined` — TanStack treats `setQueryData(key, undefined)` as "no
 * change" and silently keeps whatever is there. Without this, rolling back a
 * failed "Delete all" on a list that had never been fetched would leave the
 * optimistic `[]` in place, and the page would claim the inbox was empty. An
 * active observer refetches after the removal and gets the real data, which is
 * exactly the right outcome for a cache whose true state we no longer know.
 */
export function restoreNotificationCache(qc: QueryClient, snap: NotificationCacheSnapshot): void {
  const put = (key: readonly unknown[], data: unknown) => {
    if (data === undefined) qc.removeQueries({ queryKey: key, exact: true })
    else qc.setQueryData(key, data)
  }
  for (const { category, data } of snap.lists)  put(notificationKeys.list(category), data)
  for (const { category, data } of snap.counts) put(notificationKeys.count(category), data)
}

/**
 * Remove `ids` from every cached notification list.
 *
 * Applied across all categories rather than just the acting view's, so a row
 * deleted from /notifications also disappears from an already-cached
 * /finance/notifications list instead of lingering there until its next
 * refetch. Lists that were never fetched stay `undefined` — see the note in
 * snapshotNotificationCache.
 */
export function removeNotificationsFromLists(qc: QueryClient, ids: ReadonlySet<string>): void {
  if (ids.size === 0) return
  for (const category of NOTIFICATION_CATEGORIES) {
    const key = notificationKeys.list(category)
    const current = qc.getQueryData<Notification[]>(key)
    if (!current) continue
    const next = current.filter(n => !ids.has(n.id))
    if (next.length !== current.length) qc.setQueryData(key, next)
  }
}

/**
 * Adjust one module's unread badge by `delta` without a refetch.
 *
 * Deterministic and therefore safe to patch directly: the caller knows exactly
 * how many *unread* rows it just removed or marked read, and the endpoint that
 * produced them was already scoped to this same category. Clamped at zero so a
 * double-applied patch can never render a negative badge. No-ops when the
 * count was never fetched — inventing a count for an unmounted badge would be
 * a guess, and the next mount fetches the real value anyway.
 */
export function patchUnreadCount(
  qc: QueryClient,
  category: NotificationCategory,
  delta: number,
): void {
  if (delta === 0) return
  const key = notificationKeys.count(category)
  const current = qc.getQueryData<UnreadCountShape>(key)
  if (!current) return
  qc.setQueryData<UnreadCountShape>(key, { unreadCount: Math.max(0, current.unreadCount + delta) })
}

/** Set one module's unread badge to an exact value (used by "mark all read" / "delete all"). */
export function setUnreadCount(
  qc: QueryClient,
  category: NotificationCategory,
  unreadCount: number,
): void {
  const key = notificationKeys.count(category)
  if (qc.getQueryData<UnreadCountShape>(key) === undefined) return
  qc.setQueryData<UnreadCountShape>(key, { unreadCount: Math.max(0, unreadCount) })
}

/** How many of `ids` are currently unread in the given cached list. */
export function countUnreadAmong(
  rows: Notification[] | undefined,
  ids: ReadonlySet<string>,
): number {
  if (!rows) return 0
  return rows.reduce((acc, n) => (ids.has(n.id) && !n.is_read ? acc + 1 : acc), 0)
}

/**
 * Read a failed API response into a short, user-safe message.
 *
 * Never returns an empty string — a delete that fails must always be able to
 * say *something*, and callers use the return value directly as UI text. The
 * body is read defensively because an error response is exactly the case most
 * likely to be an HTML error page or an empty body rather than JSON.
 */
/**
 * Fetch one module's notification list.
 *
 * THROWS on any non-2xx. The previous implementation returned `[]` instead,
 * which React Query cached as a successful empty result — so a 500 or a dropped
 * connection rendered as "No notifications yet" and the user had no signal that
 * anything had failed. Throwing puts the query into its error state, where
 * TanStack keeps the last successful data available for display.
 *
 * `fetchFn` is injectable for tests; production passes nothing.
 */
export async function fetchNotificationList(
  category: NotificationCategory,
  fetchFn: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<Notification[]> {
  const res = await fetchFn(`/api/notifications?category=${category}`)
  if (!res.ok) throw new Error(await readApiError(res, 'Could not load notifications'))
  const body = await res.json()
  return body?.notifications ?? []
}

export async function readApiError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json()
    if (body && typeof body.error === 'string' && body.error.trim()) return body.error
  } catch {
    // Non-JSON body (proxy error page, empty 502, …) — fall through.
  }
  return `${fallback} (HTTP ${res.status})`
}
