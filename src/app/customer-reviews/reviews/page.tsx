'use client'

import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import { TestCardListScreen } from '../TestCardListScreen'

// The verifier's review queue. The four workflow states are tabs inside it.
//
// The Suspense boundary is required: the screen keeps its tab and search in the
// URL, so it reads search params.
export default function ReviewsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <TestCardListScreen />
    </Suspense>
  )
}
