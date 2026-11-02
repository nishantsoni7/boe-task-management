'use client'

import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import { LeadMasterScreen } from '@/components/salesLeads/LeadMasterScreen'

// useSearchParams (the filters live in the URL) needs a Suspense boundary.
export default function LeadMasterPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <LeadMasterScreen />
    </Suspense>
  )
}
