import { useQuery } from '@tanstack/react-query'
import type { Notification } from '@/lib/types'
import type { NotificationCategory } from '@/lib/notifications'
import { notificationKeys, fetchNotificationList } from '@/lib/notificationCache'
import { perfStart } from '@/lib/perf'

// `category` narrows the list to one module (e.g. 'finance' for
// /finance/notifications). Keys come from notificationKeys so this query, the
// unread-count queries and every mutation agree on exactly one key shape.
//
// A failed request now THROWS instead of returning []. Returning an empty
// array made a 500 or a dropped connection indistinguishable from a genuinely
// empty inbox: React Query cached the [] as a successful result, the page
// rendered "No notifications yet", and the user had no signal that anything
// had gone wrong. Throwing puts the query into its error state, where
// TanStack keeps the last successful `data` available — so a background
// refetch that fails leaves the previously loaded list on screen rather than
// blanking it.
export function useNotifications(category: NotificationCategory) {
  return useQuery<Notification[]>({
    queryKey: notificationKeys.list(category),
    queryFn: async () => {
      const done = perfStart('notification.list.load')
      try {
        return await fetchNotificationList(category)
      } finally {
        done()
      }
    },
    staleTime: 30 * 1000,
    gcTime: 2 * 60 * 1000,
  })
}
