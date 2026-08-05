'use client'

import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import { MeetingWorkScreen } from './MeetingWorkScreen'

// The Suspense boundary is required because MeetingsLayout reads search params
// to decide which follow-up nav entry is current.
export default function MeetingDetailPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <MeetingWorkScreen />
    </Suspense>
  )
}
