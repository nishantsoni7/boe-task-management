import { useQuery } from '@tanstack/react-query'
import type { Notification } from '@/lib/types'
import type { NotificationCategory } from '@/lib/notifications'

// `category` optionally narrows the list to one module (e.g. 'finance' for
// /finance/notifications). Its query key is a child of the default
// ['notifications'] key, so invalidating the root also refreshes this list.
export function useNotifications(category?: NotificationCategory) {
  return useQuery<Notification[]>({
    queryKey: category ? ['notifications', category] : ['notifications'],
    queryFn: async () => {
      const res = await fetch(`/api/notifications${category ? `?category=${category}` : ''}`)
      if (!res.ok) return []
      const { notifications } = await res.json()
      return notifications ?? []
    },
    staleTime: 30 * 1000,
    gcTime: 2 * 60 * 1000,
  })
}
