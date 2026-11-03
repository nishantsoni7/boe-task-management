'use client'

import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import { BoardScreen } from '@/components/salesLeads/BoardScreen'

// useSearchParams (the filters and the open lead live in the URL) needs a Suspense boundary.
export default function LeadBoardPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <BoardScreen />
    </Suspense>
  )
}
