'use client'

import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import { MyReviewsScreen } from '../MyReviewsScreen'

// A VERIFIER'S OWN ASSIGNED WORK, and the only reason this route exists.
//
// A candidate reaches My Reviews at the module root, so this is not in the
// sidebar — a second way to the same place is exactly the duplicate navigation
// this redesign removed. But a verifier's root is Overview, and a verifier who
// also holds `use` can be assigned a batch like anybody else. Without this they
// would have no way to open their own reviews.
//
// It is linked from Overview, and only when they actually have some.
export default function MyReviewsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <MyReviewsScreen />
    </Suspense>
  )
}
