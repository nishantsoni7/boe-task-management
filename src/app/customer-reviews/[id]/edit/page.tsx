'use client'

import { Suspense } from 'react'
import { useParams } from 'next/navigation'
import { LoadingScreen } from '@/components/ui/atoms'
import { EditRequestScreen } from './EditRequestScreen'

// The Suspense boundary is required because CustomerReviewsLayout reads search
// params for its navigation.
export default function EditCustomerReviewRequestPage() {
  const routeParams = useParams<{ id: string }>()
  const id = routeParams?.id ?? ''

  return (
    <Suspense fallback={<LoadingScreen />}>
      <EditRequestScreen requestId={id} />
    </Suspense>
  )
}
