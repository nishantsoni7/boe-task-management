import type { EffectivePermission } from './types'

// Assets & Access capability derivation.
//
// One place that turns the raw effective permissions for the 'assets_access'
// module into the booleans the page and layout branch on, so the UI and the
// database say the same thing. Every capability below maps to exactly one
// action, and every button maps to exactly one capability — a button must
// never appear for a permission its RPC will not accept.
//
//   view    → ENTER the module and see YOUR OWN assets and access records
//   create  → add an asset
//   assign  → give an AVAILABLE asset to an employee   (assign_asset)
//   edit    → change asset master details directly
//   delete  → remove an eligible asset
//   manage  → return an asset, mark one lost, transfer, repair, retire
//             (return_asset, mark_asset_lost, …), and review other people's
//             change requests
//
// THE RULE THIS FILE EXISTS TO STATE: 'view' is NOT inventory access.
//
// It used to be. 20260723000000 §1 made 'view' a system default for every
// active employee — so that My Assets could embed the asset rows it needs —
// and this file mapped that same 'view' straight onto canViewAssetInventory.
// The result was that every employee in the company could open Asset Inventory
// and read who holds which device. Module ENTRY and ORGANISATION-WIDE
// VISIBILITY are two different questions and now have two different booleans.
//
// Inventory visibility requires a MANAGEMENT-level grant — create, assign,
// edit, delete or manage. No new action key was invented for it: each of those
// five is an operation performed FROM the inventory screen, so holding any one
// of them and being unable to open the screen would be a half-permission.
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
  /**
   * May open Assets & Access at all. Module ENTRY only — it says nothing
   * about whose records are visible once inside.
   */
  canAccessAssetsModule: boolean
  /**
   * May see My Assets and My Access — the signed-in person's OWN rows, and
   * only those. RLS scopes them to auth.uid(); this boolean only decides
   * whether the screens are offered.
   */
  canViewOwnAssets: boolean
  /**
   * May see the ORGANISATION-WIDE Asset Inventory: every asset, and who holds
   * it. A management-level grant, never the plain 'view' default.
   */
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
   * Ask a reviewer to change or remove an asset. Available to every non-admin
   * in the module, because the counterpart of an employee not holding 'edit'
   * is that they can always ASK. An admin never needs to (they act directly).
   */
  canRequestAssetChanges: boolean
  /**
   * See the review queue and reject requests. Admin, or an explicit 'manage'
   * grant — mirrors assert_asset_request_reviewer(). APPROVING additionally
   * requires the authority the approval would exercise: 'edit' for an edit
   * request, 'delete' for a removal. Review is never a back door to an action
   * the reviewer could not perform directly.
   */
  canReviewAssetRequests: boolean
}

export const NO_ASSETS_ACCESS_CAPABILITIES: AssetsAccessCapabilities = {
  canAccessAssetsModule: false,
  canViewOwnAssets: false,
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
      canAccessAssetsModule: true,
      canViewOwnAssets: true,
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

  const canCreateAsset        = allowed('create')
  const canAssignAsset        = allowed('assign')
  const canEditAsset          = allowed('edit')
  const canDeleteAsset        = allowed('delete')
  const canManageAssetCustody = allowed('manage')

  // Every one of these five is an operation performed FROM the inventory
  // screen, so holding one without being able to open it would be a
  // permission with nowhere to act. Plain 'view' is deliberately absent: it
  // is the module-entry default every employee holds, and it is what made
  // the whole inventory readable to the whole company.
  const canViewAssetInventory =
    canCreateAsset || canAssignAsset || canEditAsset || canDeleteAsset || canManageAssetCustody

  // Entry is the weakest thing this module grants. A management capability
  // implies it, so a grant can never leave someone authorized to act on a
  // module they cannot open.
  const canAccessAssetsModule = allowed('view') || canViewAssetInventory

  return {
    canAccessAssetsModule,
    canViewOwnAssets: canAccessAssetsModule,
    canViewAssetInventory,
    canCreateAsset,
    canAssignAsset,
    canEditAsset,
    canDeleteAsset,
    canManageAssetCustody,
    canManageAccess: false,
    // Anyone in the module can ask for a change. Deliberately not conditioned
    // on lacking edit/delete — the request path stays available either way,
    // and the direct buttons appear alongside it only for whoever actually
    // holds those permissions. WHICH assets may be named in a request is a
    // separate question, answered by RLS: your own, or the whole inventory if
    // you can see the whole inventory.
    canRequestAssetChanges: canAccessAssetsModule,
    canReviewAssetRequests: canManageAssetCustody,
  }
}
