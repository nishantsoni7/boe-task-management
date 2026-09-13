'use client'

import { CustomerReviewsLayout } from '@/components/layout/CustomerReviewsLayout'
import { NotificationsView } from '@/components/notifications/NotificationsView'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'
import type { UserProfile } from '@/lib/types'

// Review Workflow notifications — the SAME shared list UI, mutations and delete
// behaviour as every other module's feed, narrowed to the `customer_review_*`
// types by NotificationsView's `category` prop (getNotificationCategoryFilter in
// src/lib/notifications.ts). Nothing about read/unread or delete is
// reimplemented here.
//
// The rows are custom reviews submitted or reapplied for approval, addressed by
// the database to the people who resolve `verify`. Every endpoint pins rows to
// the caller, so anyone else opening this page sees an empty feed rather than a
// colleague's queue.

function ReviewNotificationsLayout({
  profile, title, subtitle, actions, onSignOut, children,
}: {
  profile: UserProfile | null
  title: string
  subtitle?: string
  actions?: React.ReactNode
  onSignOut: () => void
  children: React.ReactNode
}) {
  const { caps } = useCustomerReviews()

  return (
    <CustomerReviewsLayout
      profile={profile}
      title={title}
      subtitle={subtitle}
      actions={actions}
      canVerify={caps.canVerify}
      onSignOut={onSignOut}
    >
      {children}
    </CustomerReviewsLayout>
  )
}

export default function ReviewNotificationsPage() {
  return <NotificationsView category="review" Layout={ReviewNotificationsLayout} />
}
