'use client'

import { FinanceLayout } from '@/components/layout/FinanceLayout'
import { NotificationsView } from '@/components/notifications/NotificationsView'

// Finance's own notifications page — same shared list UI as the global
// /notifications page (Task Management), narrowed to Finance's notification
// types only via NotificationsView's `category` prop. See
// getNotificationCategoryFilter in src/lib/notifications.ts for the filter.
export default function FinanceNotificationsPage() {
  return <NotificationsView category="finance" Layout={FinanceLayout} />
}
