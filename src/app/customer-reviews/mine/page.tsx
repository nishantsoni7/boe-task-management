'use client'

import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'
import { candidateGeneratedReviewsHidden } from '@/lib/customerReviews/generatedWorkflow'
import { MyReviewsScreen } from '../MyReviewsScreen'
import { CustomReviewsScreen } from '../CustomReviewsScreen'

// A VERIFIER'S OWN ASSIGNED WORK, and the only reason this route exists.
//
// A candidate reaches My Reviews at the module root, so this is not in the
// sidebar — a second way to the same place is exactly the duplicate navigation
// this redesign removed. But a verifier's root is Overview, and a verifier who
// also holds `use` can be assigned a batch like anybody else. Without this they
// would have no way to open their own reviews.
//
// It is linked from Overview, and only when they actually have some.
//
// A CANDIDATE WHO TYPES THIS URL during the Custom Review phase gets the Custom
// Review workspace, exactly as at the root — never the generated-review screen.
export default function MyReviewsPage() {
  const { caps, loading } = useCustomerReviews()

  if (loading) return <LoadingScreen />

  return (
    <Suspense fallback={<LoadingScreen />}>
      {candidateGeneratedReviewsHidden(caps) ? <CustomReviewsScreen /> : <MyReviewsScreen />}
    </Suspense>
  )
}
