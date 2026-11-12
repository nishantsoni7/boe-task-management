'use client'

import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import { CustomReviewsScreen } from './CustomReviewsScreen'

// The module landing page, and it is the same for everybody with Reviews access:
// the current-month leaderboard, Submit review, and the employee's own custom
// reviews (edit / delete). The generated-review workflow is deactivated for every
// role, so there is no longer a separate verifier Overview or candidate branch —
// a verifier reaches verification through Custom Submissions and Reports in the
// sidebar.
//
// The Suspense boundary is kept: the layout reads search params for navigation.
// CustomReviewsScreen runs useCustomerReviews and shows the loading screen itself;
// a second instance here only to wait for it read the profile and the permissions
// twice (2026-11-12).
export default function CustomerReviewsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <CustomReviewsScreen />
    </Suspense>
  )
}
