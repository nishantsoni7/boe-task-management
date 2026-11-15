'use client'

import { OrderNotificationRecipientsTab } from '@/components/controlCenter/OrderNotificationsTab'

// Control Center › Orders › Notifications. It was ?tab=order-notifications on the main page; the old
// address redirects here (next.config.ts). Written under the admin-only policies of the recipients table.
export default function ControlCenterOrderNotificationsPage() {
  return <OrderNotificationRecipientsTab />
}
