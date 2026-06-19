import { useQuery } from '@tanstack/react-query'
import type { Notification } from '@/lib/types'

export function useNotifications() {
  return useQuery<Notification[]>({
    queryKey: ['notifications'],
    queryFn: async () => {
      const res = await fetch('/api/notifications')
      if (!res.ok) return []
      const { notifications } = await res.json()
      return notifications ?? []
    },
    staleTime: 30 * 1000,
    gcTime: 2 * 60 * 1000,
  })
}
