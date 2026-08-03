/**
 * deriveAssetsAccessCapabilities — behavioural tests.
 *
 * These lock down the UI half of the Assets & Access authorization model. The
 * RLS half is verified against a live Supabase project
 * (supabase/tests/assets_access_boundary_assertions.sql), not here — but the
 * two must express the same rules, so every case below names the policy or
 * predicate it mirrors.
 *
 * THE CENTRAL RULE, and the reason most of this file exists: 'view' is module
 * ENTRY plus YOUR OWN records. It is NOT the organisation-wide inventory. It
 * used to be, and because 20260723000000 §1 makes 'view' a system default for
 * every active employee, that meant everyone in the company could read who
 * held which device.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/assetsAccess.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { deriveAssetsAccessCapabilities, NO_ASSETS_ACCESS_CAPABILITIES } from './assetsAccess'
import type { EffectivePermission } from './types'

// Shapes what resolve_effective_permissions() returns: a row per supported
// action, allowed true or false, plus the level that decided it.
function perms(allowedActions: string[]): EffectivePermission[] {
  return ['view', 'create', 'assign', 'edit', 'delete', 'manage'].map(actionKey => ({
    actionKey,
    allowed: allowedActions.includes(actionKey),
    source: allowedActions.includes(actionKey) ? 'role' : 'system_default',
  }))
}

/** Every action that is NOT a management grant, for exhaustive sweeps. */
const MANAGEMENT_ACTIONS = ['create', 'assign', 'edit', 'delete', 'manage'] as const

describe('deriveAssetsAccessCapabilities — admin', () => {
  test('admin bypasses the engine and gets everything', () => {
    // Empty permission set on purpose: admins must not depend on seeded rows.
    const caps = deriveAssetsAccessCapabilities('admin', [])
    assert.deepEqual(caps, {
      canAccessAssetsModule: true,
      canViewOwnAssets: true,
      canViewAssetInventory: true,
      canCreateAsset: true,
      canAssignAsset: true,
      canEditAsset: true,
      canDeleteAsset: true,
      canManageAssetCustody: true,
      canManageAccess: true,
      // An admin acts directly, so they raise no requests and review all.
      canRequestAssetChanges: false,
      canReviewAssetRequests: true,
    })
  })

  test('admin keeps full capability even when the engine denies every action', () => {
    const caps = deriveAssetsAccessCapabilities('admin', perms([]))
    assert.equal(caps.canViewAssetInventory, true)
    assert.equal(caps.canCreateAsset, true)
    assert.equal(caps.canDeleteAsset, true)
    assert.equal(caps.canManageAccess, true)
    assert.equal(caps.canReviewAssetRequests, true)
  })
})

describe("'view' is module entry, never the inventory", () => {
  test('an employee with only view: in the module, own records, no inventory', () => {
    const caps = deriveAssetsAccessCapabilities('member', perms(['view']))
    assert.equal(caps.canAccessAssetsModule, true)
    assert.equal(caps.canViewOwnAssets, true)
    // THE fix. This was true, and it is what let every employee read the
    // whole company's asset assignments.
    assert.equal(caps.canViewAssetInventory, false)
    assert.equal(caps.canCreateAsset, false)
    assert.equal(caps.canAssignAsset, false)
    assert.equal(caps.canEditAsset, false)
    assert.equal(caps.canDeleteAsset, false)
    assert.equal(caps.canManageAssetCustody, false)
    assert.equal(caps.canManageAccess, false)
    assert.equal(caps.canReviewAssetRequests, false)
    // The counterpart of holding no write capability: they can always ask.
    assert.equal(caps.canRequestAssetChanges, true)
  })

  test('the manager ROLE with only view is exactly an employee', () => {
    // Being a manager is not a source of asset authority: 20260723000000 §2
    // deleted every non-admin role_permissions row for this module, so a
    // manager resolves the same system-default 'view' as anyone else.
    const manager  = deriveAssetsAccessCapabilities('manager', perms(['view']))
    const employee = deriveAssetsAccessCapabilities('member',  perms(['view']))
    assert.deepEqual(manager, employee)
    assert.equal(manager.canViewAssetInventory, false)
  })

  test('no role name other than admin opens the inventory', () => {
    for (const role of ['manager', 'member', 'bdm', 'lead', '', 'ADMIN']) {
      assert.equal(
        deriveAssetsAccessCapabilities(role, perms(['view'])).canViewAssetInventory,
        false,
        role,
      )
    }
  })

  test('missing/unknown role is treated as unprivileged, not as admin', () => {
    assert.deepEqual(deriveAssetsAccessCapabilities(null, perms([])), NO_ASSETS_ACCESS_CAPABILITIES)
    assert.deepEqual(deriveAssetsAccessCapabilities(undefined, perms([])), NO_ASSETS_ACCESS_CAPABILITIES)
    assert.equal(deriveAssetsAccessCapabilities('bdm', perms([])).canDeleteAsset, false)
  })

  test('no grants at all means no module, not just no inventory', () => {
    assert.deepEqual(deriveAssetsAccessCapabilities('member', perms([])), NO_ASSETS_ACCESS_CAPABILITIES)
    assert.deepEqual(deriveAssetsAccessCapabilities('member', []), NO_ASSETS_ACCESS_CAPABILITIES)
  })

  test('an employee override can revoke view, closing the module', () => {
    const caps = deriveAssetsAccessCapabilities('member', [
      { actionKey: 'view', allowed: false, source: 'employee_override' },
    ])
    assert.equal(caps.canAccessAssetsModule, false)
    assert.equal(caps.canViewOwnAssets, false)
    assert.equal(caps.canRequestAssetChanges, false)
  })
})

describe('inventory visibility needs a management grant', () => {
  test('each management action on its own opens the inventory', () => {
    // Mirrors can_view_asset_inventory() in 20260810000000 §1 exactly. Every
    // one of these is an operation performed FROM the inventory screen, so a
    // grant without the screen would be a permission with nowhere to act.
    for (const action of MANAGEMENT_ACTIONS) {
      assert.equal(
        deriveAssetsAccessCapabilities('member', perms([action])).canViewAssetInventory,
        true,
        action,
      )
    }
  })

  test('a management grant implies module entry, with or without view', () => {
    for (const action of MANAGEMENT_ACTIONS) {
      const caps = deriveAssetsAccessCapabilities('member', perms([action]))
      assert.equal(caps.canAccessAssetsModule, true, action)
      assert.equal(caps.canViewOwnAssets, true, action)
    }
  })

  test('edit: inventory and edit, and nothing that was not granted', () => {
    const caps = deriveAssetsAccessCapabilities('member', perms(['view', 'edit']))
    assert.equal(caps.canViewAssetInventory, true)
    assert.equal(caps.canEditAsset, true)
    assert.equal(caps.canCreateAsset, false)
    assert.equal(caps.canDeleteAsset, false)
    assert.equal(caps.canAssignAsset, false)
    assert.equal(caps.canManageAssetCustody, false)
    assert.equal(caps.canReviewAssetRequests, false)
  })

  test('manage: inventory, custody and review — but not create or delete', () => {
    const caps = deriveAssetsAccessCapabilities('member', perms(['view', 'manage']))
    assert.equal(caps.canViewAssetInventory, true)
    assert.equal(caps.canManageAssetCustody, true)
    assert.equal(caps.canReviewAssetRequests, true)
    assert.equal(caps.canCreateAsset, false)
    assert.equal(caps.canDeleteAsset, false)
    // Custody work never implies editing master details, and vice versa —
    // assign_asset / return_asset / mark_asset_lost authorize on 'manage'
    // alone and never on 'edit'.
    assert.equal(caps.canEditAsset, false)
  })

  test('create: inventory and create only — the one non-admin who may add assets', () => {
    // Create Asset is a button on the inventory screen. Withholding the screen
    // from its only user would make the grant unusable.
    const caps = deriveAssetsAccessCapabilities('member', perms(['view', 'create']))
    assert.equal(caps.canViewAssetInventory, true)
    assert.equal(caps.canCreateAsset, true)
    assert.equal(caps.canEditAsset, false)
    assert.equal(caps.canDeleteAsset, false)
    assert.equal(caps.canAssignAsset, false)
    assert.equal(caps.canManageAssetCustody, false)
    assert.equal(caps.canReviewAssetRequests, false)
  })

  test('delete alone does not confer create, edit, assign or custody', () => {
    const caps = deriveAssetsAccessCapabilities('manager', perms(['delete']))
    assert.equal(caps.canDeleteAsset, true)
    assert.equal(caps.canCreateAsset, false)
    assert.equal(caps.canEditAsset, false)
    assert.equal(caps.canAssignAsset, false)
    assert.equal(caps.canManageAssetCustody, false)
  })

  test('explicit allowed:false denies even when the action row is present', () => {
    const caps = deriveAssetsAccessCapabilities('manager', [
      { actionKey: 'manage', allowed: false, source: 'employee_override' },
      { actionKey: 'view',   allowed: true,  source: 'role' },
    ])
    assert.equal(caps.canManageAssetCustody, false)
    assert.equal(caps.canViewAssetInventory, false)
    assert.equal(caps.canAccessAssetsModule, true)
  })
})

describe("'assign', split out of 'manage' by 20260725000000", () => {
  test('assign defaults to false — no grant, no assign', () => {
    assert.equal(deriveAssetsAccessCapabilities('member', perms([])).canAssignAsset, false)
    assert.equal(NO_ASSETS_ACCESS_CAPABILITIES.canAssignAsset, false)
  })

  test('admin holds assign through the admin bypass, with no rows at all', () => {
    assert.equal(deriveAssetsAccessCapabilities('admin', []).canAssignAsset, true)
  })

  test('create does not imply assign, and assign does not imply create or edit', () => {
    assert.equal(deriveAssetsAccessCapabilities('member', perms(['create'])).canAssignAsset, false)
    assert.equal(deriveAssetsAccessCapabilities('member', perms(['assign'])).canCreateAsset, false)
    assert.equal(deriveAssetsAccessCapabilities('member', perms(['assign'])).canEditAsset, false)
  })

  test('the split runs both ways — assign is not manage and manage is not assign', () => {
    const assigner = deriveAssetsAccessCapabilities('member', perms(['assign']))
    assert.equal(assigner.canAssignAsset, true)
    assert.equal(assigner.canManageAssetCustody, false)
    // …and therefore no review right either.
    assert.equal(assigner.canReviewAssetRequests, false)

    const manager = deriveAssetsAccessCapabilities('member', perms(['manage']))
    assert.equal(manager.canManageAssetCustody, true)
    assert.equal(manager.canAssignAsset, false)
  })

  test('an employee override can grant assign, and nothing rides along with it', () => {
    const caps = deriveAssetsAccessCapabilities('member', [
      { actionKey: 'view',   allowed: true, source: 'system_default' },
      { actionKey: 'create', allowed: true, source: 'employee_override' },
      { actionKey: 'assign', allowed: true, source: 'employee_override' },
    ])
    assert.equal(caps.canAssignAsset, true)
    assert.equal(caps.canCreateAsset, true)
    assert.equal(caps.canEditAsset, false)
    assert.equal(caps.canDeleteAsset, false)
    assert.equal(caps.canManageAssetCustody, false)
  })

  test('an employee override can revoke assign', () => {
    const caps = deriveAssetsAccessCapabilities('member', [
      { actionKey: 'view',   allowed: true,  source: 'system_default' },
      { actionKey: 'assign', allowed: false, source: 'employee_override' },
    ])
    assert.equal(caps.canAssignAsset, false)
  })

  test('the manager role does not receive assign automatically', () => {
    assert.equal(deriveAssetsAccessCapabilities('manager', perms(['view'])).canAssignAsset, false)
  })
})

describe('requesting and reviewing', () => {
  test('everyone in the module may raise a request; nobody outside it may', () => {
    assert.equal(deriveAssetsAccessCapabilities('member', perms(['view'])).canRequestAssetChanges, true)
    assert.equal(deriveAssetsAccessCapabilities('member', perms(['manage'])).canRequestAssetChanges, true)
    assert.equal(deriveAssetsAccessCapabilities('member', perms([])).canRequestAssetChanges, false)
    // The admin has the buttons already.
    assert.equal(deriveAssetsAccessCapabilities('admin', []).canRequestAssetChanges, false)
  })

  test("review is 'manage' or admin — and no other action confers it", () => {
    // Mirrors can_review_asset_requests() (20260810000000 §1).
    for (const action of ['view', 'create', 'assign', 'edit', 'delete']) {
      for (const role of ['member', 'manager', 'bdm']) {
        assert.equal(
          deriveAssetsAccessCapabilities(role, perms([action])).canReviewAssetRequests,
          false,
          `${role} + ${action}`,
        )
      }
    }
    assert.equal(deriveAssetsAccessCapabilities('member', perms(['manage'])).canReviewAssetRequests, true)
    assert.equal(deriveAssetsAccessCapabilities('admin', []).canReviewAssetRequests, true)
  })

  test('review is not a back door to edit or delete', () => {
    // The reviewer boolean says "may work the queue and reject". Approving an
    // edit still needs 'edit', and approving a REMOVAL is admin-only — decided
    // by canApproveChangeRequest() in lib/assets/changeRequests.ts and
    // re-checked by approve_asset_change_request() server-side.
    const caps = deriveAssetsAccessCapabilities('manager', perms(['manage']))
    assert.equal(caps.canReviewAssetRequests, true)
    assert.equal(caps.canEditAsset, false)
    assert.equal(caps.canDeleteAsset, false)
  })

  test("the grantable 'delete' permission is not an approval right", () => {
    // 20260803000000 §3: 'delete' covers the ordinary, policy-governed delete
    // of a never-assigned inventory mistake. It confers no review right at
    // all, so it can never reach the removal-approval path.
    const caps = deriveAssetsAccessCapabilities('manager', perms(['manage', 'delete']))
    assert.equal(caps.canDeleteAsset, true)
    assert.equal(caps.canReviewAssetRequests, true)
    // …and the approval rule still refuses, because it asks for admin.
    assert.equal(deriveAssetsAccessCapabilities('manager', perms(['delete'])).canReviewAssetRequests, false)
  })
})

describe('Access Register stays admin-only', () => {
  test('no combination of module grants reaches plaintext secrets', () => {
    const everything = deriveAssetsAccessCapabilities(
      'manager', perms(['view', 'create', 'assign', 'edit', 'delete', 'manage']),
    )
    assert.equal(everything.canManageAccess, false)
    assert.equal(deriveAssetsAccessCapabilities('member', perms(['manage'])).canManageAccess, false)
    assert.equal(deriveAssetsAccessCapabilities('admin', []).canManageAccess, true)
  })
})
