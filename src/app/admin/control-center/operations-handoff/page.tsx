'use client'

import { ControlCenterSkeleton } from '@/components/layout/ControlCenterSkeleton'
import { OperationsReviewerTab } from '@/components/controlCenter/OperationsHandoffTab'
import { NO_MEMBERS, useAdminMembers } from '@/hooks/queries/useControlCenterData'

// Control Center › Orders › Operations handoff. It was ?tab=operations-handoff on the main page; the old
// address redirects here (next.config.ts). The reviewer is chosen from the live employee directory, so
// the screen waits for it (the shared cache, usually warm) before drawing.
export default function ControlCenterOperationsHandoffPage() {
  const members = useAdminMembers()
  if (members.isPending) return <ControlCenterSkeleton />
  return <OperationsReviewerTab members={members.data ?? NO_MEMBERS} />
}
