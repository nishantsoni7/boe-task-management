import { useQuery } from '@tanstack/react-query'
import { notificationKeys, type UnreadCountShape } from '@/lib/notificationCache'
import type { NotificationCategory } from '@/lib/notifications'

// Module-scoped unread badge counts. Query keys and endpoints are UNCHANGED —
// they now just come from `notificationKeys` instead of repeated literals, so
// these queries and the mutations that patch/invalidate them can never drift
// apart. TanStack still dedupes to one fetch per key no matter how many
// sidebars mount the same hook.
//
// Note the task key is ['notifications', 'count'] with no category suffix:
// that is the historic key every module sidebar has read since before
// categories existed, and notificationKeys.count('task') preserves it.
//
// `enabled` exists for the admin-only categories: a caller who is not allowed
// the feed gets a 403, and a badge that is never rendered should not be asking
// for it on every page load. Defaults to true, so every existing caller is
// unchanged.
function useUnreadCount(category: NotificationCategory, enabled = true): number {
  const { data } = useQuery<UnreadCountShape>({
    queryKey: notificationKeys.count(category),
    enabled,
    queryFn: async () => {
      const res = await fetch(`/api/notifications?count=1&category=${category}`)
      // A failed count keeps the badge at its last known value rather than
      // flashing 0 — a badge is ambient decoration, and showing "nothing to
      // see" because of a network blip is worse than showing a stale number.
      if (!res.ok) throw new Error(`Unread count request failed (HTTP ${res.status})`)
      return res.json() as Promise<UnreadCountShape>
    },
    staleTime: 30 * 1000,
  })
  return data?.unreadCount ?? 0
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
