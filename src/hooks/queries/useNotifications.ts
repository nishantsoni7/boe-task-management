import { useCallback, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Notification } from '@/lib/types'
import type { NotificationCategory } from '@/lib/notifications'
import { notificationKeys, fetchNotificationPage, readApiErrorMessage } from '@/lib/notificationCache'
import { NOTIFICATION_PAGE_SIZE, NOTIFICATION_MAX_ROWS, nextNotificationLimit } from '@/lib/notificationPaging'
import { perfStart } from '@/lib/perf'

// `category` narrows the list to one module (e.g. 'finance' for
// /finance/notifications). Keys come from notificationKeys so this query, the
// unread-count queries and every mutation agree on exactly one key shape.
//
// A failed request THROWS instead of returning []. Returning an empty array
// made a 500 or a dropped connection indistinguishable from a genuinely empty
// inbox: React Query cached the [] as a successful result, the page rendered
// "No notifications yet", and the user had no signal that anything had gone
// wrong. Throwing puts the query into its error state, where TanStack keeps the
// last successful `data` available — so a background refetch that fails leaves
// the previously loaded list on screen rather than blanking it.
//
// ── BOUNDED, AND WHY THE BOUND IS NOT IN THE QUERY KEY ──────────────────────
//
// The page opens on the newest NOTIFICATION_PAGE_SIZE rows and never asks for
// the whole history. "Load older" raises the ceiling by one page, up to
// NOTIFICATION_MAX_ROWS, and writes the wider result into THE SAME query key.
//
// Keeping the ceiling out of the key is deliberate. Every notification mutation
// — optimistic delete, rollback, mark-read reconciliation — addresses the list
// through `notificationKeys.list(category)` exactly, and that machinery is what
// fixed the "deleted notifications come back" bug. A key that grew a page
// suffix would leave those mutations writing to a key nobody reads. So the
// cached value stays what it has always been: one flat, newest-first
// `Notification[]`, and a later background refetch re-requests the same ceiling
// this hook currently holds.

export type NotificationsQuery = {
  data: Notification[] | undefined
  /** No data yet — the first page has not resolved. Never means "the inbox is empty". */
  isPending: boolean
  isError: boolean
  error: unknown
  /** Raise the ceiling by one page and merge the result in. No-op at the ceiling. */
  loadOlder: () => void
  /** The server reported rows older than the ones held, and room remains. */
  hasOlder: boolean
  loadingOlder: boolean
  /** A failed "Load older", for the page's error banner. Null otherwise. */
  olderError: string | null
  /** The current row ceiling — never above NOTIFICATION_MAX_ROWS. */
  limit: number
}

export function useNotifications(category: NotificationCategory): NotificationsQuery {
  const qc = useQueryClient()
  const [limit, setLimit] = useState(NOTIFICATION_PAGE_SIZE)
  const [serverHasMore, setServerHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState<string | null>(null)

  const query = useQuery<Notification[]>({
    queryKey: notificationKeys.list(category),
    queryFn: async () => {
      const done = perfStart('notification.list.load')
      try {
        const page = await fetchNotificationPage(category, limit)
        setServerHasMore(page.hasMore)
        return page.notifications
      } finally {
        done()
      }
    },
    staleTime: 30 * 1000,
    gcTime: 2 * 60 * 1000,
  })

  const loadOlder = useCallback(() => {
    const next = nextNotificationLimit(limit)
    if (next === limit || loadingOlder) return
    setLoadingOlder(true)
    setOlderError(null)
    void (async () => {
      const done = perfStart('notification.list.load')
      try {
        // Fetched directly rather than by bumping state and refetching: the
        // wider request must go out with the NEW ceiling, and a state update
        // does not reach the query function until the next render.
        const page = await fetchNotificationPage(category, next)
        // Same discipline the mutations use — an in-flight background GET for
        // the narrower page must not land on top of the wider result.
        await qc.cancelQueries({ queryKey: notificationKeys.list(category), exact: true })
        qc.setQueryData<Notification[]>(notificationKeys.list(category), page.notifications)
        setServerHasMore(page.hasMore)
        setLimit(next)
      } catch (err) {
        // The rows already on screen are untouched, so this is a failed
        // extension, not a failed page: say so and leave the button to retry.
        setOlderError(readApiErrorMessage(err, 'Could not load older notifications.'))
      } finally {
        done()
        setLoadingOlder(false)
      }
    })()
  }, [category, limit, loadingOlder, qc])

  return {
    data: query.data,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    loadOlder,
    hasOlder: serverHasMore && limit < NOTIFICATION_MAX_ROWS,
    loadingOlder,
    olderError,
    limit,
  }
}
