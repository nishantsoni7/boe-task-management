import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { notificationKeys, type UnreadCountShape } from '@/lib/notificationCache'
import type { NotificationCategory } from '@/lib/notifications'
import { useSignedInUserId } from '@/hooks/queries/usePermissionContext'
import {
  readPersistedUnreadCount,
  writePersistedUnreadCount,
} from '@/lib/notificationCountCache'

// Module-scoped unread badge counts. Query keys and endpoints are UNCHANGED —
// they come from `notificationKeys` so these queries and the mutations that
// patch/invalidate them can never drift apart. TanStack dedupes to one fetch
// per key no matter how many sidebars, bottom navs or launcher cards mount the
// same hook, which is what makes this ONE request rather than one per surface.
//
// Note the task key is ['notifications', 'count'] with no category suffix:
// that is the historic key every module sidebar has read since before
// categories existed, and notificationKeys.count('task') preserves it.
//
// `enabled` exists for a caller who is not allowed the feed: they would get a
// 403, and a badge that is never rendered should not be asking for it on every
// page load. Defaults to true, so every existing caller is unchanged.
//
// ── WHY THE COUNT IS PERSISTED ──────────────────────────────────────────────
//
// The in-memory cache dies with the tab, so a hard refresh left every badge
// with nothing to show until a round trip came back. The last good value is
// written to localStorage (count, version and timestamp — never any
// notification content; see notificationCountCache.ts) and seeded here as
// `initialData`, so the number the user last saw is on screen in the first
// render.
//
// `initialDataUpdatedAt` is the seeded value's OWN timestamp, not now. That is
// the whole trick: TanStack compares it against `staleTime`, finds the value
// older than 30s, and fires the background revalidation immediately — while
// still rendering the seeded number. Passing `initialData` without it would
// mark the query fresh and suppress the request, which is the opposite of what
// this is for. A refetch never clears `data`, so a slow or failing revalidation
// leaves the last known count on screen rather than blanking it.

export type UnreadCountState = {
  /** Undefined ONLY when nothing is known yet — no cache and no response. Render a placeholder. */
  count: number | undefined
  /** True while the first value (cached or fetched) is still unknown. */
  isPending: boolean
  isError: boolean
}

/**
 * The full state, for a caller that must tell "not known yet" from "zero".
 * The launcher card uses this; the badges use the number-returning wrappers.
 */
export function useUnreadCountState(
  category: NotificationCategory,
  enabled = true,
): UnreadCountState {
  const { data: userId } = useSignedInUserId()
  const seed = readPersistedUnreadCount(userId, category)

  const { data, isPending, isError } = useQuery<UnreadCountShape>({
    queryKey: notificationKeys.count(category),
    // Waits for the id so the seed and the eventual write agree about whose
    // count this is. The request itself is authorised server-side from the
    // session, never from this value.
    enabled: enabled && !!userId,
    queryFn: async () => {
      const res = await fetch(`/api/notifications?count=1&category=${category}`)
      // A failed count keeps the badge at its last known value rather than
      // flashing 0 — a badge is ambient decoration, and showing "nothing to
      // see" because of a network blip is worse than showing a stale number.
      if (!res.ok) throw new Error(`Unread count request failed (HTTP ${res.status})`)
      return res.json() as Promise<UnreadCountShape>
    },
    staleTime: 30 * 1000,
    ...(seed ? { initialData: { unreadCount: seed.count }, initialDataUpdatedAt: seed.at } : {}),
  })

  // Persist whatever is currently displayed. Driven by `data` rather than by
  // the fetch, so an optimistic mark-read or delete — which writes this same
  // cache entry through patchUnreadCount/setUnreadCount — is persisted too,
  // without every mutation needing to know that persistence exists.
  useEffect(() => {
    if (!userId || data === undefined) return
    writePersistedUnreadCount(userId, category, data.unreadCount)
  }, [userId, category, data])

  return { count: data?.unreadCount, isPending, isError }
}

/** Badge number. Unknown reads as 0, which is what a badge hidden at zero wants. */
function useUnreadCount(category: NotificationCategory, enabled = true): number {
  return useUnreadCountState(category, enabled).count ?? 0
}

/** Task Management's unread badge count — the default for every module sidebar. */
export function useUnreadNotifications(): number {
  return useUnreadCount('task')
}

/** Finance-scoped unread badge count. */
export function useUnreadFinanceNotifications(): number {
  return useUnreadCount('finance')
}

/** Orders-scoped unread badge count. */
export function useUnreadOrderNotifications(): number {
  return useUnreadCount('order')
}

/** Assets & Access-scoped unread badge count. */
export function useUnreadAssetNotifications(): number {
  return useUnreadCount('asset')
}

/**
 * Attendance & Payroll issue count — ONE number shared by both sidebars.
 *
 * The Attendance and Payroll shells call this same hook against the same query
 * key, so TanStack serves both from a single fetch and the two badges cannot
 * show different numbers. That is the point of one category rather than two.
 *
 * Admin-only server-side: a non-admin gets 403, the query throws, and the badge
 * stays at 0 — which is also why the nav entry is only rendered for an admin.
 */
export function useUnreadAttendancePayrollNotifications(enabled = true): number {
  return useUnreadCount('attendance_payroll', enabled)
}
