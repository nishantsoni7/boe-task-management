'use client'

import { OrdersLayout } from '@/components/layout/OrdersLayout'
import { NotificationsView } from '@/components/notifications/NotificationsView'

// Orders' own notifications page — same shared list UI as the global
// /notifications page (Task Management), narrowed to Orders' notification
// types only via NotificationsView's `category` prop. See
// getNotificationCategoryFilter in src/lib/notifications.ts for the filter.
export default function OrdersNotificationsPage() {
  return <NotificationsView category="order" Layout={OrdersLayout} />
}
