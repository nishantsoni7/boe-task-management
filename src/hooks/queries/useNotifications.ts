import { useCallback, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useDisplaySubject } from '@/hooks/queries/useDisplaySubject'
import type { Notification } from '@/lib/types'
import type { NotificationCategory } from '@/lib/notifications'
import { notificationKeys, fetchNotificationPage, readApiErrorMessage } from '@/lib/notificationCache'
import type { TaskHeaderMap, ActivityDetailMap } from '@/lib/notifications/pageEnrichment'
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
// suffix would leave those mutations writing to a key nobody reads.
//
// ── WHY "LOAD OLDER" REPLACES RATHER THAN APPENDS ───────────────────────────
//
// It asks for the newest N rows, where N is the raised ceiling, and REPLACES
// the cached array with the answer. Three properties follow from that, and all
// three are the reason it is not an OFFSET-and-append:
//
//   · no duplicates are structurally possible — there is no merge step in which
//     a row could appear twice;
//   · a notification that ARRIVES BETWEEN loads is simply included at the top.
//     With an offset the same arrival would shift every later row down by one
//     and the second page would repeat a row the first had already shown;
//   · ordering is stable across the two requests because the server sort is
//     total (created_at desc, id desc — see /api/notifications).
//
// The one hazard left is a mutation in flight: the server has not yet applied a
// delete or a mark-read that the cache has already applied optimistically, so a
// wider re-read would bring the old state back. `blocked` is how the caller
// closes that window — see NotificationsView, which passes its own pending
// mutation state.

export type NotificationsQuery = {
  data: Notification[] | undefined
  /**
   * Task title + assignee, keyed by task id, for the page currently held.
   *
   * Resolved server-side in two bounded queries per page — never one per card,
   * and never inferred from the newest event's actor. Empty until the first
   * page lands, and empty from a server that does not send it; both render as
   * "Assignee unavailable" rather than as a wrong name.
   */
  taskHeaders: TaskHeaderMap
  /** Linked activity detail, keyed by activity id. Empty for historical rows. */
  activityDetails: ActivityDetailMap
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

export function useNotifications(
  category: NotificationCategory,
  /**
   * True while the caller has an optimistic mutation in flight. Refuses
   * "Load older" for as long as it holds: a wider read would return rows the
   * server has not yet deleted or marked read, putting them back on screen.
   */
  blocked = false,
): NotificationsQuery {
  // THE AUTHORITY for what the query function asks for. A ref rather than the
  // state below because `setLimit` does not reach the registered query function
  // until the next render, and an invalidation landing inside that window would
  // re-request the OLD ceiling and shrink the list back. Read only inside
  // callbacks — never during render, where `limit` is used instead.
  const limitRef = useRef(NOTIFICATION_PAGE_SIZE)
  const [limit, setLimit] = useState(NOTIFICATION_PAGE_SIZE)
  const [serverHasMore, setServerHasMore] = useState(false)
  // ── THESE TWO ARE A FALLBACK NOW, NOT THE SOURCE OF TRUTH ──
  //
  // They are assigned inside `queryFn`, and `queryFn` does not always run: with
  // `staleTime: 30s` a page served from cache skips it entirely, a mutation
  // writes rows back with `setQueryData` without it, and two observers of one
  // key share a single call so only one of them is ever assigned. In every one
  // of those cases the ROWS render and these stay `{}` — which is exactly how a
  // correctly linked comment came out as a bare "Comment added".
  //
  // So the detail now travels ON each row (`Notification.context`, attached by
  // /api/notifications), where it shares the rows' lifetime and cannot fall
  // behind them. These are kept because they cost nothing and still serve a
  // payload written before `context` existed.
  const [taskHeaders, setTaskHeaders] = useState<TaskHeaderMap>({})
  const [activityDetails, setActivityDetails] = useState<ActivityDetailMap>({})
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState<string | null>(null)

  // THE LIST BELONGS TO THE DISPLAY SUBJECT — see the note in
  // useUnreadNotifications. The id also keys the cache, so previewing an
  // employee cannot overwrite the administrator's own loaded page.
  const { subjectUserId, viewMode } = useDisplaySubject()
  const previewSubjectId = viewMode ? subjectUserId : null

  const qc = useQueryClient()

  const query = useQuery<Notification[]>({
    queryKey: [...notificationKeys.list(category), previewSubjectId],
    queryFn: async () => {
      const done = perfStart('notification.list.load')
      try {
        const page = await fetchNotificationPage(category, limitRef.current, fetch, previewSubjectId)
        setServerHasMore(page.hasMore)
        setTaskHeaders(page.taskHeaders)
        setActivityDetails(page.activityDetails)
        return page.notifications
      } finally {
        done()
      }
    },
    staleTime: 30 * 1000,
    gcTime: 2 * 60 * 1000,
  })

  const loadOlder = useCallback(() => {
    if (loadingOlder || blocked) return
    const next = nextNotificationLimit(limitRef.current)
    if (next === limitRef.current) return
    setLoadingOlder(true)
    setOlderError(null)
    void (async () => {
      const done = perfStart('notification.list.load')
      try {
        // Fetched directly rather than by bumping state and refetching: the
        // wider request must go out with the NEW ceiling, and a state update
        // does not reach the query function until the next render.
        const page = await fetchNotificationPage(category, next, fetch, previewSubjectId)
        // Same discipline the mutations use — an in-flight background GET for
        // the narrower page must not land on top of the wider result.
        await qc.cancelQueries({ queryKey: notificationKeys.list(category), exact: true })
        limitRef.current = next
        setTaskHeaders(page.taskHeaders)
        setActivityDetails(page.activityDetails)
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
  }, [category, loadingOlder, blocked, qc, previewSubjectId])

  return {
    data: query.data,
    // Title + assignee per task id. Never a per-card fetch: it arrives with the
    // page it describes and is replaced wholesale when a wider page replaces it.
    taskHeaders,
    activityDetails,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    loadOlder,
    hasOlder: serverHasMore && limit < NOTIFICATION_MAX_ROWS && !blocked,
    loadingOlder,
    olderError,
    limit,
  }
}
