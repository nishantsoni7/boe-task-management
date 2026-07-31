import type { AssetsAccessCapabilities } from '@/lib/permissions/assetsAccess'

// Which action buttons an inventory row offers.
//
// Two independent questions, and both must be yes:
//
//   1. does this person hold the permission the RPC will demand?
//   2. does the asset's current state make the operation meaningful?
//
// Kept as one pure function used by BOTH the mobile and desktop renderers, so
// the two cannot drift apart and so the matrix can be tested directly. A
// button must never appear for something the database will refuse — hiding a
// button is not authorization, it is honesty about authorization that already
// exists server-side.

export type AssetRowActions = {
  /** Assign an available asset — assets_access.assign, assign_asset(). */
  assign: boolean
  /** Take an assigned asset back — assets_access.manage, return_asset(). */
  markReturned: boolean
  /** Write an asset off — assets_access.manage, mark_asset_lost(). */
  markLost: boolean
  /** Edit master details directly — assets_access.edit. */
  edit: boolean
  /** Delete a never-assigned asset — assets_access.delete + the DB trigger. */
  remove: boolean
}

export function assetRowActions(
  caps: AssetsAccessCapabilities,
  assetStatus: string,
): AssetRowActions {
  return {
    // Only an asset nobody holds can be handed to someone.
    assign: caps.canAssignAsset && assetStatus === 'available',
    // Only an asset someone holds can come back.
    markReturned: caps.canManageAssetCustody && assetStatus === 'assigned',
    // Anything not already written off can be lost — including something
    // sitting in the cupboard that has gone missing.
    markLost: caps.canManageAssetCustody && assetStatus !== 'lost',
    // Master details are state-independent; the permission is the whole test.
    edit: caps.canEditAsset,
    // The custody-history rule is enforced at click time and by the trigger,
    // not here — this only answers "may this person delete at all".
    remove: caps.canDeleteAsset,
  }
}
