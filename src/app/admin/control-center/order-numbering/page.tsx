'use client'

import { OrderNumberCycleTab } from '@/components/controlCenter/OrderNumberingTab'

// Control Center › Orders › Numbering. It was ?tab=order-numbering on the main page; the old address
// redirects here (next.config.ts). The database functions behind it check for an administrator themselves.
export default function ControlCenterOrderNumberingPage() {
  return <OrderNumberCycleTab />
}
