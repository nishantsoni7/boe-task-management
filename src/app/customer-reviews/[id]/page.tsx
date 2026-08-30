'use client'

import { Suspense } from 'react'
import { useParams } from 'next/navigation'
import { LoadingScreen } from '@/components/ui/atoms'
import { TestCardDetailScreen } from './TestCardDetailScreen'

// The Suspense boundary is required because CustomerReviewsLayout reads search
// params for its navigation.
export default function CustomerReviewTestCardPage() {
  const routeParams = useParams<{ id: string }>()
  const id = routeParams?.id ?? ''

  return (
    <Suspense fallback={<LoadingScreen />}>
      <TestCardDetailScreen cardId={id} />
    </Suspense>
  )
}
