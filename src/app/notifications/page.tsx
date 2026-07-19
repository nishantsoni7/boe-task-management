'use client'

import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { NotificationsView } from '@/components/notifications/NotificationsView'

export default function NotificationsPage() {
  return <NotificationsView category="task" Layout={DashboardLayout} />
}
