import type { EffectivePermission } from './types'

// Assets & Access capability derivation.
//
// One place that turns the raw effective permissions for the 'assets_access'
// module into the booleans the page and layout branch on, so the UI and the
// database say the same thing. Every capability below maps to exactly one
// action, and every button maps to exactly one capability — a button must
// never appear for a permission its RPC will not accept.
//
//   view    → read the inventory + who currently holds each asset
//   create  → add an asset
//   assign  → give an AVAILABLE asset to an employee   (assign_asset)
//   edit    → change asset master details directly
//   delete  → remove an eligible, never-assigned asset
//   manage  → return an asset, mark one lost           (return_asset,
//                                                       mark_asset_lost)
//
// 'assign' was split out of 'manage' by 20260725000000. Before that one
// capability drove three buttons, so granting someone the ability to hand out
// a laptop also gave them Return and Mark Lost.
//
// Admins bypass the engine entirely, matching the app-wide convention used by
// every other cut-over module (see src/app/orders/layout.tsx).
//
// Access Register is deliberately NOT part of this: access_records still holds
// plaintext secret_value, so its policies remain admin-only until that column
// is dealt with. canManageAccess is a role check on purpose, not an oversight.

export type AssetsAccessCapabilities = {
  /** Show the Asset Inventory screen at all. */
  canViewAssetInventory: boolean
  canCreateAsset: boolean
  /** Assign an available asset to an employee. */
  canAssignAsset: boolean
  canEditAsset: boolean
  canDeleteAsset: boolean
  /** Return an assigned asset, or mark one lost. NOT assigning. */
  canManageAssetCustody: boolean
  /** Show the Access Register screen. Admin-only while secrets are plaintext. */
  canManageAccess: boolean
  /**
   * Ask an admin to change or remove an asset. The counterpart to not
   * holding edit/delete: a non-admin who can see the inventory can always
   * raise a request, and an admin never needs to (they act directly).
   */
  canRequestAssetChanges: boolean
  /** Approve or reject other people's requests. Admin only. */
  canReviewAssetRequests: boolean
}

export const NO_ASSETS_ACCESS_CAPABILITIES: AssetsAccessCapabilities = {
  canViewAssetInventory: false,
  canCreateAsset: false,
  canAssignAsset: false,
  canEditAsset: false,
  canDeleteAsset: false,
  canManageAssetCustody: false,
  canManageAccess: false,
  canRequestAssetChanges: false,
  canReviewAssetRequests: false,
}

export function deriveAssetsAccessCapabilities(
  role: string | null | undefined,
  permissions: EffectivePermission[],
): AssetsAccessCapabilities {
  if (role === 'admin') {
    return {
      canViewAssetInventory: true,
      canCreateAsset: true,
      canAssignAsset: true,
      canEditAsset: true,
      canDeleteAsset: true,
      canManageAssetCustody: true,
      canManageAccess: true,
      // An admin edits and deletes directly, so there is nothing to request.
      canRequestAssetChanges: false,
      canReviewAssetRequests: true,
    }
  }

  const allowed = (actionKey: string) =>
    permissions.some(p => p.actionKey === actionKey && p.allowed)

  const canAssignAsset = allowed('assign')
  const canManageAssetCustody = allowed('manage')

  // Either custody capability without 'view' would grant an action with
  // nowhere to perform it, so either one opens the screen.
  const canViewAssetInventory = allowed('view') || canAssignAsset || canManageAssetCustody

  return {
    canViewAssetInventory,
    canCreateAsset: allowed('create'),
    canAssignAsset,
    canEditAsset: allowed('edit'),
    canDeleteAsset: allowed('delete'),
    canManageAssetCustody,
    canManageAccess: false,
    // Anyone who can see the inventory can ask for a change to it. This is
    // deliberately not conditioned on lacking edit/delete — the request path
    // stays available either way, and the direct buttons appear alongside it
    // only for whoever actually holds those permissions.
    canRequestAssetChanges: canViewAssetInventory,
    canReviewAssetRequests: false,
  }
}
