// Pure helpers for the launcher's Pending approvals card
// (src/app/modules/PendingApprovals.tsx), kept free of React and stylesheets so
// they can be executed by the test runner.

import type { AttendanceRequestRow } from './requests'

/** How many requests the launcher lists before "See all". */
export const PENDING_APPROVALS_SHOWN = 5

/**
 * The requests this admin can act on: pending, not their own, in the order
 * the queue returned them (oldest first for `pending`). Their own requests
 * wait for another admin — the decision route refuses a self-decision.
 */
export function actionableRequests<T extends Pick<AttendanceRequestRow, 'status' | 'employee_id'>>(
  rows: T[],
  viewerId: string | null,
): T[] {
  return rows.filter(r => r.status === 'pending' && r.employee_id !== viewerId)
}

/** Two letters for the avatar chip: first and last name. */
export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}
