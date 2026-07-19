import { useQuery } from '@tanstack/react-query'

// Task Management's unread badge count — used by every module sidebar that
// hasn't been given its own module-scoped count (NotificationsNavItem's
// default). The endpoint defaults to `category=task` server-side when none is
// given, so this is Task Management's own count, not a cross-module total.
// Query key (['notifications', 'count']) and endpoint (/api/notifications?count=1)
// are unchanged from before so TanStack Query still dedupes to ONE fetch no
// matter how many sidebars mount it, and existing mark-read / delete mutations
// that invalidate ['notifications', 'count'] keep it in sync.
export function useUnreadNotifications(): number {
  const { data } = useQuery({
    queryKey: ['notifications', 'count'],
    queryFn: async () => {
      const res = await fetch('/api/notifications?count=1&category=task')
      if (!res.ok) return { unreadCount: 0 }
      return res.json() as Promise<{ unreadCount: number }>
    },
    staleTime: 30 * 1000,
  })
  return data?.unreadCount ?? 0
}

// Finance-scoped variant of the badge count. Same endpoint and shape, narrowed
// server-side to Finance's own types via `?category=finance`. Its query key
// (['notifications', 'count', 'finance']) is a prefix-child of ['notifications',
// 'count'], so the existing mark-read / delete mutations — which invalidate
// ['notifications', 'count'] — clear this count too, no extra wiring needed.
export function useUnreadFinanceNotifications(): number {
  const { data } = useQuery({
    queryKey: ['notifications', 'count', 'finance'],
    queryFn: async () => {
      const res = await fetch('/api/notifications?count=1&category=finance')
      if (!res.ok) return { unreadCount: 0 }
      return res.json() as Promise<{ unreadCount: number }>
    },
    staleTime: 30 * 1000,
  })
  return data?.unreadCount ?? 0
}

// Orders-scoped variant of the badge count. Same shape as the Finance variant,
// narrowed server-side to Orders' own types via `?category=order`.
export function useUnreadOrderNotifications(): number {
  const { data } = useQuery({
    queryKey: ['notifications', 'count', 'order'],
    queryFn: async () => {
      const res = await fetch('/api/notifications?count=1&category=order')
      if (!res.ok) return { unreadCount: 0 }
      return res.json() as Promise<{ unreadCount: number }>
    },
    staleTime: 30 * 1000,
  })
  return data?.unreadCount ?? 0
}
