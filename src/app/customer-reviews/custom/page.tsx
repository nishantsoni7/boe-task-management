'use client'

import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import { CustomSubmissionsScreen } from '../CustomSubmissionsScreen'

// The verifier's queue of Custom Review Submissions: reviews employees arranged
// themselves, with the screenshot that proves each was published. The screen
// sends anyone without `verify` back to the module root.
//
// The Suspense boundary is required: the screen reads `?submission=` — the link
// a reviewer notification opens — to open that review directly.
export default function CustomSubmissionsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <CustomSubmissionsScreen />
    </Suspense>
  )
}
