import type { EffectivePermission } from './types'

// Assets & Access capability derivation.
//
// One place that turns the raw effective permissions for the 'assets_access'
// module into the booleans the page and layout actually branch on, so the UI
// and the RLS policies in
// supabase/migrations/20260721000000_assets_access_permission_cutover.sql
// stay describable in the same terms:
//
//   view    → read the full inventory + who currently holds each asset
//   create  → add assets
//   edit    → change asset master details
//   delete  → permanently remove an asset (admin-only by default)
//   manage  → assign / mark returned / mark lost (writes to employee_assets)
//
// Admins bypass the engine entirely, matching the app-wide convention used by
// every other cut-over module (see src/app/orders/layout.tsx).
//
// Access Register is deliberately NOT part of this: access_records still holds
// plaintext secret_value, so its policies remain admin-only until that column
// is dealt with. canManageAccess is a role check on purpose, not an oversight.

export type AssetsAccessCapabilities = {
  /** Show the Asset Inventory screen at all. */
  canViewInventory: boolean
  canCreateAsset: boolean
  canEditAsset: boolean
  canDeleteAsset: boolean
  /** Assign, mark returned, mark lost — anything writing employee_assets. */
  canManageAssignments: boolean
  /** Show the Access Register screen. Admin-only while secrets are plaintext. */
  canManageAccess: boolean
}

export const NO_ASSETS_ACCESS_CAPABILITIES: AssetsAccessCapabilities = {
  canViewInventory: false,
  canCreateAsset: false,
  canEditAsset: false,
  canDeleteAsset: false,
  canManageAssignments: false,
  canManageAccess: false,
}

export function deriveAssetsAccessCapabilities(
  role: string | null | undefined,
  permissions: EffectivePermission[],
): AssetsAccessCapabilities {
  if (role === 'admin') {
    return {
      canViewInventory: true,
      canCreateAsset: true,
      canEditAsset: true,
      canDeleteAsset: true,
      canManageAssignments: true,
      canManageAccess: true,
    }
  }

  const allowed = (actionKey: string) =>
    permissions.some(p => p.actionKey === actionKey && p.allowed)

  const canManageAssignments = allowed('manage')

  return {
    // 'manage' without 'view' would otherwise grant the write actions with
    // nowhere to perform them, so it opens the screen too.
    canViewInventory: allowed('view') || canManageAssignments,
    canCreateAsset: allowed('create'),
    canEditAsset: allowed('edit'),
    canDeleteAsset: allowed('delete'),
    canManageAssignments,
    canManageAccess: false,
  }
}
