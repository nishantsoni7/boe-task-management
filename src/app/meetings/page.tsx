'use client'

import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import { MeetingsListScreen } from './MeetingsListScreen'

// The module landing page. Two clicks from here to a live review: New Meeting →
// Create lands directly on the working screen, and an existing row opens it.
//
// The Suspense boundary is required: both this screen and MeetingsLayout read
// search params (filters, and the follow-up nav highlight).
export default function MeetingsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <MeetingsListScreen scope="active" />
    </Suspense>
  )
}
