'use client'

import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'
import { OverviewScreen } from './OverviewScreen'
import { MyReviewsScreen } from './MyReviewsScreen'

// The module landing page, and it answers whichever question the viewer has.
//
//   a verifier   → Overview: what needs my attention?
//   anybody else → My Reviews: what work do I have?
//
// ONE ROUTE, TWO SCREENS, and that is deliberate rather than a shortcut. A
// candidate has exactly one destination in this module, so giving them a
// separate URL would mean a sidebar entry that goes somewhere they can also
// reach by clicking the module — two ways to the same place, which is the
// duplication this redesign removed. A verifier's own assigned work is on the
// same screen a candidate sees, reachable from their sidebar's first entry.
//
// The Suspense boundary is required: My Reviews reads a search param for the
// one-shot "review verified" notice.
export default function CustomerReviewsPage() {
  const { caps, loading } = useCustomerReviews()

  if (loading) return <LoadingScreen />

  return (
    <Suspense fallback={<LoadingScreen />}>
      {caps.canVerify ? <OverviewScreen /> : <MyReviewsScreen />}
    </Suspense>
  )
}
