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
  /** The signed-in person is an administrator. */
  isAdmin: boolean
  /** An assignment in pending_acceptance or accepted right now. */
  hasActiveAssignment: boolean
}

/**
 * Why this asset may not be permanently deleted, or null if it may be.
 *
 * Mirrors public.permanently_delete_asset (20260803000000): an administrator
 * may erase an asset outright — including its assignment, custody, service,
 * warranty and activity history — and nobody else may.
 *
 * HISTORY IS NO LONGER A BLOCK. It was, up to 20260802000000, because the only
 * delete available was the ordinary one that would have stranded or destroyed
 * those records piecemeal. The purge function removes them together in one
 * transaction, so "this asset has assignment history" stopped being a reason
 * and became the warning the confirmation dialog states.
 *
 * An OPEN assignment still blocks, and deliberately: somebody is holding the
 * asset right now, which is a fact about the present, not the past, and Mark
 * Returned or Mark Lost is one click away. Retire/dispose remain the reversible
 * route for an asset that is simply out of service.
 */
export function assetDeleteBlockReason(input: AssetDeleteGuardInput): string | null {
  if (!input.canDeleteAsset || !input.isAdmin) {
    return 'Only an administrator can permanently delete an asset.'
  }
  if (input.hasActiveAssignment) {
    return 'This asset is currently assigned. Mark it returned or lost before deleting.'
  }
  return null
}
