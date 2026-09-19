import { OrdersRouteFallback } from '@/components/layout/ModuleRouteFallback'

// Every Orders route, while its code or server payload is on the way: the
// Orders shell with the destination lit and titled, and a skeleton body — not a
// blank screen, and not the full-page spinner. It sits INSIDE the Orders guard
// (layout.tsx), so nothing here renders before module access is decided, and it
// reads no data of its own. See ModuleRouteFallback.
export default function OrdersLoading() {
  return <OrdersRouteFallback />
}
