'use client'

import { SalesLayout } from '@/components/layout/SalesLayout'
import { NotificationsView } from '@/components/notifications/NotificationsView'
import type { UserProfile } from '@/lib/types'

// Sales notifications: the same shared list as every other module's feed, narrowed to the `sales_*` types. The rows are
// written by the database. Every endpoint pins rows to the caller, so a person sees only what was addressed to them.

function SalesNotificationsLayout({ profile, title, subtitle, onSignOut, children }: {
  profile: UserProfile | null
  title: string
  subtitle?: string
  actions?: React.ReactNode
  onSignOut: () => void
  children: React.ReactNode
}) {
  return <SalesLayout profile={profile} title={title} subtitle={subtitle} onSignOut={onSignOut}>{children}</SalesLayout>
}

export default function SalesNotificationsPage() {
  return <NotificationsView category="sales" Layout={SalesNotificationsLayout} />
}
