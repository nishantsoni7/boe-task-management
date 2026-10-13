'use client'

import { Suspense } from 'react'
import { MembersWorkspace } from '@/components/controlCenter/MembersWorkspace'
import { ControlCenterSkeleton } from '@/components/layout/ControlCenterSkeleton'

// Control Center › People › Employees. The screen itself is the shared
// MembersWorkspace, so this route adds a destination rather than a second
// implementation — the same arrangement Positions already uses. Gating is the
// Control Center layout's admin check plus this segment's ModuleGuard.
//
// The Suspense boundary is for the workspace's deep links (?member=, ?q=,
// ?new=1), which read the URL.
export default function ControlCenterPeoplePage() {
  return (
    <Suspense fallback={<ControlCenterSkeleton />}>
      <MembersWorkspace />
    </Suspense>
  )
}
