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

/**
 * The request types the launcher's For you panel lists: leave and late
 * arrival (owner, 2026-10-29). Early departure and time out during the shift
 * still wait in Attendance → Requests, just not on the first screen.
 */
export const LAUNCHER_REQUEST_TYPES = ['late_arrival', 'half_day', 'full_day_leave'] as const

/** Only the requests of the launcher's types, in the order given. */
export function launcherRequests<T extends Pick<AttendanceRequestRow, 'request_type'>>(rows: T[]): T[] {
  return rows.filter(r => (LAUNCHER_REQUEST_TYPES as readonly string[]).includes(r.request_type))
}

/** Two letters for the avatar chip: first and last name. */
export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}
