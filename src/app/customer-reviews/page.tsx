'use client'

import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'
import { candidateGeneratedReviewsHidden } from '@/lib/customerReviews/generatedWorkflow'
import { OverviewScreen } from './OverviewScreen'
import { MyReviewsScreen } from './MyReviewsScreen'
import { CustomReviewsScreen } from './CustomReviewsScreen'

// The module landing page, and it answers whichever question the viewer has.
//
//   a verifier   → Overview: what needs my attention?
//   anybody else → My Reviews: what work do I have?
//
// DURING THE CUSTOM REVIEW PHASE a candidate's My Reviews is the Custom Review
// workspace: Submit Custom Review, their monthly position, and their own
// submissions. The generated-review screen is not rendered for them at all, so
// it reads no assigned cards and offers no Book (see generatedWorkflow.ts).
//
// ONE ROUTE, TWO SCREENS, and that is deliberate rather than a shortcut. A
// candidate has exactly one destination in this module, so giving them a
// separate URL would mean a sidebar entry that goes somewhere they can also
// reach by clicking the module — two ways to the same place.
//
// The Suspense boundary is required: My Reviews reads a search param for the
// one-shot "review verified" notice.
export default function CustomerReviewsPage() {
  const { caps, loading } = useCustomerReviews()

  if (loading) return <LoadingScreen />

  return (
    <Suspense fallback={<LoadingScreen />}>
      {caps.canVerify
        ? <OverviewScreen />
        : candidateGeneratedReviewsHidden(caps) ? <CustomReviewsScreen /> : <MyReviewsScreen />}
    </Suspense>
  )
}
