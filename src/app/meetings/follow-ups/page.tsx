'use client'

import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import { FollowUpsScreen } from './FollowUpsScreen'

// Both sidebar entries — "Due Follow-ups" and "Overdue" — land here with `?due=`
// preset. One screen, one query, two doors into it.
export default function FollowUpsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <FollowUpsScreen />
    </Suspense>
  )
}
