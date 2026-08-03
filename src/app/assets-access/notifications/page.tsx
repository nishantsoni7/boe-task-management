'use client'

import { AssetsLayout } from '@/components/layout/AssetsLayout'
import { NotificationsView } from '@/components/notifications/NotificationsView'
import { useAssetsAccess } from '@/hooks/useAssetsAccess'
import type { UserProfile } from '@/lib/types'

// Assets & Access notifications — the SAME shared list UI, mutations and delete
// behaviour as Task Management's /notifications page and Orders'
// /orders/notifications, narrowed to `asset_%` types by NotificationsView's
// `category` prop (see getNotificationCategoryFilter in src/lib/notifications.ts).
//
// Nothing about read/unread, mark-all-read, select, delete-one, delete-selected
// or delete-all is reimplemented here: those all live in NotificationsView and
// useNotificationMutations, so Assets inherits the optimistic update, the
// rollback on failure, the per-row pending lock, and the exact same buttons in
// the same places. That is the whole point of the shared component — a second
// notification architecture would drift within a month.

// NotificationsView's Layout contract is fixed (profile / title / subtitle /
// actions / onSignOut / children), and AssetsLayout additionally needs the
// permission flags that decide which sidebar entries exist. This adapter is
// where the two meet; it resolves capabilities for the SIGNED-IN user, exactly
// as every other Assets screen does.
function AssetsNotificationsLayout({
  profile, title, subtitle, actions, onSignOut, children,
}: {
  profile: UserProfile | null
  title: string
  subtitle?: string
  actions?: React.ReactNode
  onSignOut: () => void
  children: React.ReactNode
}) {
  const { caps } = useAssetsAccess()

  return (
    <AssetsLayout
      profile={profile}
      title={title}
      subtitle={subtitle}
      actions={actions}
      onSignOut={onSignOut}
      canViewInventory={caps.canViewAssetInventory}
      canManageAccess={caps.canManageAccess}
      canSeeAssetRequests={caps.canReviewAssetRequests || caps.canRequestAssetChanges}
      canReviewAssetRequests={caps.canReviewAssetRequests}
    >
      {children}
    </AssetsLayout>
  )
}

export default function AssetsNotificationsPage() {
  return <NotificationsView category="asset" Layout={AssetsNotificationsLayout} />
}
