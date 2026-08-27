'use client'

import { Suspense } from 'react'
import { useParams } from 'next/navigation'
import { LoadingScreen } from '@/components/ui/atoms'
import { RequestDetailScreen } from './RequestDetailScreen'

// The Suspense boundary is required because CustomerReviewsLayout reads search
// params for its navigation.
export default function CustomerReviewRequestPage() {
  const routeParams = useParams<{ id: string }>()
  const id = routeParams?.id ?? ''

  return (
    <Suspense fallback={<LoadingScreen />}>
      <RequestDetailScreen requestId={id} />
    </Suspense>
  )
}
