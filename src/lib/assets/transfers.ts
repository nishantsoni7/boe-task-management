// Asset custody — who holds an asset right now, and which movements are legal.
//
// THE OWNERSHIP RULE this module exists to keep true:
//
//   An asset whose status is 'assigned' MUST resolve to a named custodian.
//   An asset that is not 'assigned' must NOT claim one.
//
// Both halves matter. A row showing "Assigned" with a dash in the holder column
// is an accountability hole; a row showing "Available — held by Priya" is worse,
// because it reads as settled. So the custodian is never a stored string that
// can drift: it is derived from the live custody row every time it is shown,
// and describeCustody() reports an inconsistency as an inconsistency rather
// than papering over it with an empty cell.

import type { Asset, AssetEmployee, EmployeeAsset } from './types'
// isOpenAssignment is defined once, in detail.ts, and re-exported here so
// "custody that has not ended" cannot come to mean two different things.
import { isOpenAssignment } from './detail'

export { isOpenAssignment }

/**
 * The open custody row for an asset, or null.
 *
 * Takes the LATEST open row when more than one exists. That should be
 * impossible — every RPC closes the previous period inside the same
 * transaction that opens the next — but if it ever happens, the most recent
 * assignment is the truthful answer and a silent `[0]` would be a coin toss.
 */
export function findOpenAssignment(
  rows: readonly EmployeeAsset[],
  assetId: string,
): EmployeeAsset | null {
  let best: EmployeeAsset | null = null
  for (const row of rows) {
    if (row.asset_id !== assetId || !isOpenAssignment(row.status)) continue
    if (best === null || row.assigned_at > best.assigned_at) best = row
  }
  return best
}

export type CustodyKind = 'employee' | 'location' | 'unassigned' | 'inconsistent'

export type CustodyDescription = {
  kind: CustodyKind
  /** What the Current Holder cell shows. Always a sentence, never blank. */
  label: string
  /** Set only for kind 'employee'. */
  employeeId: string | null
  /** Set only for kind 'location'. */
  location: string | null
  /**
   * True when the asset's status and its custody records disagree. The UI
   * surfaces this rather than hiding it — a contradiction in the custody
   * record is exactly the thing this module exists to make visible.
   */
  inconsistent: boolean
}

const UNKNOWN_EMPLOYEE = 'Unknown employee'

/**
 * Who holds this asset, stated for a reader.
 *
 * `employeeName` resolves an id to a display name; an id it cannot resolve
 * still yields a custodian (an unnamed one), never a dash — the asset IS held,
 * and saying otherwise would be worse than saying we cannot name the holder.
 */
export function describeCustody(
  asset: Pick<Asset, 'status' | 'location'>,
  openAssignment: EmployeeAsset | null,
  employeeName: (id: string) => string | null,
): CustodyDescription {
  const location = asset.location?.trim() || null

  if (openAssignment) {
    const name = employeeName(openAssignment.employee_id) || UNKNOWN_EMPLOYEE
    // A live custody row on an asset the inventory calls available, lost or
    // retired is a real contradiction. It is reported, not smoothed over.
    const consistent = asset.status === 'assigned' || asset.status === 'under_repair'
    return {
      kind: consistent ? 'employee' : 'inconsistent',
      label: consistent ? name : `${name} (record needs review)`,
      employeeId: openAssignment.employee_id,
      location: null,
      inconsistent: !consistent,
    }
  }

  if (asset.status === 'assigned') {
    // Status says assigned, nothing says who. Never rendered as "—".
    return {
      kind: 'inconsistent',
      label: 'Assigned — custodian missing',
      employeeId: null,
      location: null,
      inconsistent: true,
    }
  }

  if (location) {
    return { kind: 'location', label: location, employeeId: null, location, inconsistent: false }
  }

  return { kind: 'unassigned', label: 'Unassigned', employeeId: null, location: null, inconsistent: false }
}

// ── Transfer validation ──────────────────────────────────────────────────────

export type TransferTarget =
  | { kind: 'employee'; employeeId: string }
  | { kind: 'location'; location: string }

export type TransferInput = {
  assetStatus: string
  /** The current holder's user id, when a person holds it. */
  currentEmployeeId: string | null
  target: TransferTarget | null
}

/**
 * Why this transfer cannot be submitted, or null when it can.
 *
 * Every rule here is also enforced by transfer_asset() — this exists so the
 * reader is told before a round-trip, and so the two can be compared. Hiding a
 * button is not authorization; refusing early is courtesy.
 */
export function validateTransfer(input: TransferInput): string | null {
  if (input.assetStatus === 'lost') {
    return 'This asset is marked lost. Record a recovery before transferring it.'
  }
  if (input.assetStatus === 'retired' || input.assetStatus === 'disposed') {
    return 'This asset has been retired and can no longer be transferred.'
  }
  if (input.assetStatus === 'under_repair') {
    return 'This asset is away for service. Close the service record before transferring it.'
  }
  if (!input.target) {
    return 'Choose an employee or a company location to transfer to.'
  }
  if (input.target.kind === 'employee') {
    if (!input.target.employeeId) return 'Choose an employee to transfer to.'
    if (input.target.employeeId === input.currentEmployeeId) {
      return 'This asset is already held by that employee.'
    }
    return null
  }
  if (input.target.location.trim() === '') {
    return 'Enter the company location this asset is moving to.'
  }
  return null
}

export type AssignInput = {
  /**
   * The chosen asset's status, or NULL when no asset has been chosen yet.
   *
   * Null is reachable because Assign Asset is also offered as the Assets area's
   * primary action, where the reader picks the asset inside the dialog rather
   * than arriving from a row. It is a distinct state from "an asset that cannot
   * be assigned", and it gets its own sentence — telling someone their asset is
   * unavailable when they have not chosen one is a dead end.
   */
  assetStatus: string | null
  employeeId: string | null
}

/** Why this assignment cannot be submitted. Mirrors assign_asset(). */
export function validateAssignment(input: AssignInput): string | null {
  if (!input.assetStatus) return 'Choose an asset to assign.'
  if (input.assetStatus !== 'available') {
    return 'Only an available asset can be assigned. Take it back or recover it first.'
  }
  if (!input.employeeId) return 'Choose an employee to assign this asset to.'
  return null
}

export type RecoveryInput = {
  assetStatus: string
  target: TransferTarget | null
}

/** Why this recovery cannot be submitted. Mirrors recover_lost_asset(). */
export function validateRecovery(input: RecoveryInput): string | null {
  if (input.assetStatus !== 'lost') {
    return 'This asset is not marked lost, so there is nothing to recover.'
  }
  if (!input.target) {
    return 'Say where the asset was recovered to — an employee or a company location.'
  }
  if (input.target.kind === 'employee' && !input.target.employeeId) {
    return 'Choose the employee who now holds this asset.'
  }
  if (input.target.kind === 'location' && input.target.location.trim() === '') {
    return 'Enter the company location this asset was recovered to.'
  }
  return null
}

/**
 * One side of a movement, as a sentence. Used by the history table and the
 * timeline so a movement never reads as "→" with two blanks around it.
 */
export function describeTransferSide(
  employeeId: string | null,
  location: string | null,
  employeeName: (id: string) => string | null,
): string {
  if (employeeId) return employeeName(employeeId) || UNKNOWN_EMPLOYEE
  const trimmed = location?.trim()
  if (trimmed) return trimmed
  return '—'
}

/** Active employees a transfer may target: everyone except the current holder. */
export function transferCandidates(
  employees: readonly AssetEmployee[],
  currentEmployeeId: string | null,
): AssetEmployee[] {
  return employees.filter(e => e.id !== currentEmployeeId)
}
