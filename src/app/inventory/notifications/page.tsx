'use client'

import { InventoryLayout } from '@/components/layout/InventoryLayout'
import { NotificationsView } from '@/components/notifications/NotificationsView'
import { useInventory } from '@/hooks/useInventory'
import type { UserProfile } from '@/lib/types'

// Inventory notifications — the SAME shared list UI, mutations and delete behaviour as every other module's
// feed, narrowed to the `inventory_booking_*` types by NotificationsView's `category` prop
// (getNotificationCategoryFilter in src/lib/notifications.ts).
//
// The rows are written by the database in the transaction of the booking change: a new request goes to every
// approver, a decision goes to the salesperson who asked. Every endpoint pins rows to the caller, so anyone
// opening this page sees only what was addressed to them.

function InventoryNotificationsLayout({
  profile, title, subtitle, actions, onSignOut, children,
}: {
  profile: UserProfile | null
  title: string
  subtitle?: string
  actions?: React.ReactNode
  onSignOut: () => void
  children: React.ReactNode
}) {
  const { access, pending } = useInventory()
  return (
    <InventoryLayout profile={profile} access={access} pending={pending} title={title} subtitle={subtitle} actions={actions} onSignOut={onSignOut}>
      {children}
    </InventoryLayout>
  )
}

export default function InventoryNotificationsPage() {
  return <NotificationsView category="inventory" Layout={InventoryNotificationsLayout} />
}
