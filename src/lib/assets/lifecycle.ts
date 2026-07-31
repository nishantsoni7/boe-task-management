// Asset custody lifecycle rules.
//
// The state machine the Asset Inventory screen branches on, kept out of the
// page so it can be tested directly. The database half lives in
// supabase/migrations/20260722000000_assets_custody_integrity.sql and must
// keep saying the same thing.
//
// Two status fields, easily confused:
//   assets.status          — where the asset itself rests right now
//   employee_assets.status — what happened in one custody period
//
// 'returned' is an event, so it belongs to the assignment. The asset's resting
// state after a normal return is 'available' — anything else strands it, since
// Assign only offers itself for an available asset.

export type AssetStatus = 'available' | 'assigned' | 'returned' | 'lost'

export type AssignmentStatus = 'pending_acceptance' | 'accepted' | 'returned' | 'lost'

/** What the assignment row becomes when custody ends normally. */
export const ASSIGNMENT_STATUS_AFTER_RETURN: AssignmentStatus = 'returned'

/**
 * What the asset itself becomes when custody ends normally — back on the
 * shelf, immediately reassignable. Damaged/under-service returns are a
 * separate workflow and are not modelled here.
 */
export const ASSET_STATUS_AFTER_RETURN: AssetStatus = 'available'

/** Assign is offered only for an asset nobody currently holds. */
export function canAssignAsset(assetStatus: string): boolean {
  return assetStatus === 'available'
}

// Acceptance state shown in the inventory, derived from the asset plus its
// active assignment (if any) rather than stored anywhere.
export type AcceptanceStatusKey = 'pending_acceptance' | 'accepted' | 'available' | 'returned' | 'lost'

export function acceptanceStatusKey(
  assetStatus: string,
  activeAssignmentStatus: string | undefined,
): AcceptanceStatusKey {
  // Only reachable for rows stranded before 20260722000000 corrected them;
  // nothing sets an asset to 'returned' any more.
  if (assetStatus === 'returned') return 'returned'
  if (assetStatus === 'lost') return 'lost'
  if (activeAssignmentStatus === 'pending_acceptance') return 'pending_acceptance'
  if (activeAssignmentStatus === 'accepted') return 'accepted'
  return 'available'
}

export type AssetDeleteGuardInput = {
  /** From the permission engine — 'delete' on assets_access. */
  canDeleteAsset: boolean
  /** An assignment in pending_acceptance or accepted right now. */
  hasActiveAssignment: boolean
  /** Every employee_assets row ever written for this asset, any status. */
  assignmentHistoryCount: number
}

/**
 * Why this asset may not be deleted, or null if it may be.
 *
 * Mirrors the database guarantee: the assets_delete policy decides who may
 * ask, and the assets_prevent_assigned_delete trigger refuses any asset that
 * has ever been assigned. Deletion is for mistaken inventory entries only —
 * never a way to erase custody records.
 */
export function assetDeleteBlockReason(input: AssetDeleteGuardInput): string | null {
  if (!input.canDeleteAsset) {
    return 'You do not have permission to delete assets.'
  }
  if (input.hasActiveAssignment) {
    return 'This asset is currently assigned. Mark it returned or lost before deleting.'
  }
  if (input.assignmentHistoryCount > 0) {
    return 'This asset has assignment history and cannot be deleted. Its custody record is permanent.'
  }
  return null
}
