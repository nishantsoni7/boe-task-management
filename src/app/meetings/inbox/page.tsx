'use client'

import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import { MeetingInboxScreen } from './MeetingInboxScreen'

// The Meeting Inbox. Inside the Meetings module, behind MeetingsGuard, in the
// module's own shell.
//
// The Suspense boundary is required because MeetingsLayout reads search params
// for its follow-up nav highlight.
export default function MeetingInboxPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <MeetingInboxScreen />
    </Suspense>
  )
}
