'use client'

import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import { CustomerReviewListScreen } from './CustomerReviewListScreen'

// The module landing page. Two clicks from here to a prepared invitation: New
// Request → save → the request screen shows the exact message and the WhatsApp
// button.
//
// The Suspense boundary is required: the list screen keeps its tab and search
// in the URL, so it reads search params.
export default function CustomerReviewsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <CustomerReviewListScreen />
    </Suspense>
  )
}
