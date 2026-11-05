'use client'

import { SalesLayout } from '@/components/layout/SalesLayout'
import { NotificationsView } from '@/components/notifications/NotificationsView'
import type { UserProfile } from '@/lib/types'

// Sales notifications: the same shared list as every other module's feed, narrowed to the `sales_*` types. The rows are
// written by the database. Every endpoint pins rows to the caller, so a person sees only what was addressed to them.

function SalesNotificationsLayout({ profile, title, subtitle, actions, onSignOut, children }: {
  profile: UserProfile | null
  title: string
  subtitle?: string
  actions?: React.ReactNode
  onSignOut: () => void
  children: React.ReactNode
}) {
  // `actions` is passed on (owner, 2026-11-05): Mark all read and Delete all
  // were dropped here, so Sales was the one feed without them.
  return <SalesLayout profile={profile} title={title} subtitle={subtitle} actions={actions} onSignOut={onSignOut}>{children}</SalesLayout>
}

export default function SalesNotificationsPage() {
  return <NotificationsView category="sales" Layout={SalesNotificationsLayout} />
}
