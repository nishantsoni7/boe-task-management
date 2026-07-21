import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'

// Neutral nav-badge count for OrdersLayout's "Order Requests" item — the number
// of order requests still needing action, matching the Order Requests page's
// "All" tab exactly. That tab's filter is `match: () => true` over the page's
// own `order_requests` select, which excludes status = 'converted'; the same
// exclusion is applied here, so the two are the same scope by construction —
// every remaining status (submitted, needs_clarification, rejected) is
// included, and RLS decides visibility identically for both queries.
//
// Converted requests are excluded because conversion is the exit from this
// module: the row is retained permanently in the database and reached through
// its Confirmed Order, so counting it would keep advertising work that is
// already done. Deliberately NOT narrowed to 'submitted' either — management
// needs the full volume of open requests, not just the ones awaiting first
// review.
//
// Not an unread count: viewing a request, or reading a notification, never
// changes it. `order_requests` mutations on the requests page invalidate this
// query key (['order-requests', 'total-count']) so the badge stays in sync
// without waiting out staleTime.
//
// Returns `undefined` while the first fetch is in flight so the badge can stay
// blank rather than flash a misleading "0"; once resolved it is always a
// number, including a genuine 0.
export function useOrderRequestsCount(): number | undefined {
  const { data } = useQuery({
    queryKey: ['order-requests', 'total-count'],
    queryFn: async () => {
      const supabase = createClient()
      const { count } = await supabase
        .from('order_requests')
        .select('id', { count: 'exact', head: true })
        .neq('status', 'converted')
      return count ?? 0
    },
    staleTime: 30 * 1000,
  })
  return data
}
