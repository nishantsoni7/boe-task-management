'use client'

import { PositionsManager } from '@/components/positions/PositionsManager'

// People › Positions inside the Control Center shell. The editor itself is the
// one shared PositionsManager, so this route adds a destination, not a second
// implementation; /settings/positions keeps working with the same component.
// Admin gating is the Control Center layout's; the positions table's own RLS
// still decides every write.
export default function ControlCenterPositionsPage() {
  return <PositionsManager />
}
