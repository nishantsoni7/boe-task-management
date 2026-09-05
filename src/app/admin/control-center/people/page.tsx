'use client'

import { MembersWorkspace } from '@/components/controlCenter/MembersWorkspace'

// Control Center › People › Employees. The screen itself is the shared
// MembersWorkspace, so this route adds a destination rather than a second
// implementation — the same arrangement Positions already uses. Gating is the
// Control Center layout's admin check plus this segment's ModuleGuard.
export default function ControlCenterPeoplePage() {
  return <MembersWorkspace />
}
