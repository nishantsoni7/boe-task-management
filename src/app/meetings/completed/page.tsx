'use client'

import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import { MeetingsListScreen } from '../MeetingsListScreen'

export default function CompletedMeetingsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <MeetingsListScreen scope="completed" />
    </Suspense>
  )
}
