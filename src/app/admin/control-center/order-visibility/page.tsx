'use client'

import { OrderVisibilityTab } from '@/components/controlCenter/OrderVisibilityTab'

// Control Center › Orders › Order visibility. It was ?tab=order-visibility on the main page; the old
// address redirects here (next.config.ts). The screen calls only the two owner-only RPCs.
export default function ControlCenterOrderVisibilityPage() {
  return <OrderVisibilityTab />
}
