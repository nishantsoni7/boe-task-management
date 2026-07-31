/**
 * deriveAssetsAccessCapabilities — behavioural tests.
 *
 * These lock down the UI half of the Assets & Access authorization cutover.
 * The RLS half (the policies in 20260721000000) is verified against a live
 * Supabase project, not here — but the two must express the same rules, so
 * every case below names the policy it mirrors.
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

describe('deriveAssetsAccessCapabilities', () => {
  test('admin bypasses the engine and gets everything', () => {
    // Empty permission set on purpose: admins must not depend on seeded rows.
    const caps = deriveAssetsAccessCapabilities('admin', [])
    assert.deepEqual(caps, {
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
    assert.equal(caps.canDeleteAsset, true)
    assert.equal(caps.canManageAccess, true)
  })

  test('the one non-admin who may add assets: view + create, nothing else', () => {
    // Aditya's intended grant. Create is his only write capability — editing
    // and removal go through the request workflow instead.
    const caps = deriveAssetsAccessCapabilities('member', perms(['view', 'create']))
    assert.equal(caps.canViewAssetInventory, true)
    assert.equal(caps.canCreateAsset, true)
    assert.equal(caps.canEditAsset, false)
    assert.equal(caps.canDeleteAsset, false)
    assert.equal(caps.canManageAssetCustody, false)
    assert.equal(caps.canRequestAssetChanges, true)
    assert.equal(caps.canReviewAssetRequests, false)
  })

  test('a manager gains nothing from the role name alone', () => {
    // The manager role seed was removed from 20260721000000 before it was
    // applied: being a manager is not a source of asset authority. With only
    // the baseline view default, Dhruv is a viewer like everyone else.
    const caps = deriveAssetsAccessCapabilities('manager', perms(['view']))
    assert.equal(caps.canViewAssetInventory, true)
    assert.equal(caps.canCreateAsset, false)
    assert.equal(caps.canEditAsset, false)
    assert.equal(caps.canDeleteAsset, false)
    assert.equal(caps.canManageAssetCustody, false)
  })

  test('an ordinary employee resolves view only, and may still raise requests', () => {
    const caps = deriveAssetsAccessCapabilities('member', perms(['view']))
    assert.equal(caps.canViewAssetInventory, true)
    assert.equal(caps.canCreateAsset, false)
    assert.equal(caps.canEditAsset, false)
    assert.equal(caps.canDeleteAsset, false)
    assert.equal(caps.canManageAssetCustody, false)
    assert.equal(caps.canManageAccess, false)
    assert.equal(caps.canRequestAssetChanges, true)
    assert.equal(caps.canReviewAssetRequests, false)
  })

  test('no non-admin can review requests, whatever they are granted', () => {
    const caps = deriveAssetsAccessCapabilities('manager', perms(['view', 'create', 'assign', 'edit', 'delete', 'manage']))
    assert.equal(caps.canReviewAssetRequests, false)
  })

  test('no configurable module permission can confer approval rights', () => {
    // Approval is authorized by users.role = 'admin' alone, in
    // assert_asset_request_reviewer(). Every grantable action is checked here
    // so a future Control Center toggle cannot quietly become a review right.
    for (const action of ['view', 'create', 'assign', 'edit', 'delete', 'manage']) {
      for (const role of ['member', 'manager', 'bdm']) {
        const caps = deriveAssetsAccessCapabilities(role, perms([action]))
        assert.equal(caps.canReviewAssetRequests, false, `${role} + ${action}`)
      }
    }
  })

  test('manage alone is enough for custody work — it never implies needing edit', () => {
    // The UI shows Assign / Return / Mark Lost off canManageAssetCustody only.
    // The database side matches: assign_asset / return_asset /
    // mark_asset_lost authorize on admin OR 'manage', never 'edit'.
    const caps = deriveAssetsAccessCapabilities('member', perms(['view', 'manage']))
    assert.equal(caps.canManageAssetCustody, true)
    assert.equal(caps.canEditAsset, false)
  })

  // ── 'assign', split out of 'manage' by 20260725000000 ────────────────────

  test('assign defaults to false — no grant, no assign', () => {
    assert.equal(deriveAssetsAccessCapabilities('member', perms([])).canAssignAsset, false)
    assert.equal(NO_ASSETS_ACCESS_CAPABILITIES.canAssignAsset, false)
  })

  test('admin holds assign through the admin bypass, with no rows at all', () => {
    assert.equal(deriveAssetsAccessCapabilities('admin', []).canAssignAsset, true)
  })

  test('create does not imply assign', () => {
    assert.equal(deriveAssetsAccessCapabilities('member', perms(['create'])).canAssignAsset, false)
  })

  test('assign does not imply create', () => {
    assert.equal(deriveAssetsAccessCapabilities('member', perms(['assign'])).canCreateAsset, false)
  })

  test('assign does not imply edit', () => {
    assert.equal(deriveAssetsAccessCapabilities('member', perms(['assign'])).canEditAsset, false)
  })

  test('assign does not imply manage — no Return, no Mark Lost', () => {
    const caps = deriveAssetsAccessCapabilities('member', perms(['assign']))
    assert.equal(caps.canAssignAsset, true)
    assert.equal(caps.canManageAssetCustody, false)
  })

  test('manage does not imply assign — the split runs both ways', () => {
    const caps = deriveAssetsAccessCapabilities('member', perms(['manage']))
    assert.equal(caps.canManageAssetCustody, true)
    assert.equal(caps.canAssignAsset, false)
  })

  test('assign alone opens the inventory, since that is where assigning happens', () => {
    assert.equal(deriveAssetsAccessCapabilities('member', perms(['assign'])).canViewAssetInventory, true)
  })

  test('an employee override can grant assign', () => {
    const caps = deriveAssetsAccessCapabilities('member', [
      { actionKey: 'view', allowed: true, source: 'system_default' },
      { actionKey: 'create', allowed: true, source: 'employee_override' },
      { actionKey: 'assign', allowed: true, source: 'employee_override' },
    ])
    assert.equal(caps.canAssignAsset, true)
    assert.equal(caps.canCreateAsset, true)
    // …and nothing else came with it.
    assert.equal(caps.canEditAsset, false)
    assert.equal(caps.canDeleteAsset, false)
    assert.equal(caps.canManageAssetCustody, false)
  })

  test('an employee override can revoke assign', () => {
    const caps = deriveAssetsAccessCapabilities('member', [
      { actionKey: 'view', allowed: true, source: 'system_default' },
      { actionKey: 'assign', allowed: false, source: 'employee_override' },
    ])
    assert.equal(caps.canAssignAsset, false)
  })

  test('the manager role does not receive assign automatically', () => {
    // Only the view baseline resolves for a manager; assign has no role seed.
    assert.equal(deriveAssetsAccessCapabilities('manager', perms(['view'])).canAssignAsset, false)
  })

  test('someone who cannot see the inventory cannot raise requests either', () => {
    assert.equal(deriveAssetsAccessCapabilities('member', perms([])).canRequestAssetChanges, false)
  })

  test('member with no grants gets nothing', () => {
    assert.deepEqual(deriveAssetsAccessCapabilities('member', perms([])), NO_ASSETS_ACCESS_CAPABILITIES)
  })

  test('member with no permission rows at all gets nothing', () => {
    assert.deepEqual(deriveAssetsAccessCapabilities('member', []), NO_ASSETS_ACCESS_CAPABILITIES)
  })

  test('missing/unknown role is treated as unprivileged, not as admin', () => {
    assert.deepEqual(deriveAssetsAccessCapabilities(null, perms([])), NO_ASSETS_ACCESS_CAPABILITIES)
    assert.deepEqual(deriveAssetsAccessCapabilities(undefined, perms([])), NO_ASSETS_ACCESS_CAPABILITIES)
    assert.equal(deriveAssetsAccessCapabilities('bdm', perms([])).canDeleteAsset, false)
  })

  test('explicit allowed:false denies even when the action row is present', () => {
    // An employee override set to deny must not read as a grant.
    const caps = deriveAssetsAccessCapabilities('manager', [
      { actionKey: 'manage', allowed: false, source: 'employee_override' },
      { actionKey: 'view', allowed: true, source: 'role' },
    ])
    assert.equal(caps.canManageAssetCustody, false)
    assert.equal(caps.canViewAssetInventory, true)
  })

  test("'view' alone opens a read-only inventory — no write capability", () => {
    const caps = deriveAssetsAccessCapabilities('member', perms(['view']))
    assert.equal(caps.canViewAssetInventory, true)
    assert.equal(caps.canCreateAsset, false)
    assert.equal(caps.canEditAsset, false)
    assert.equal(caps.canDeleteAsset, false)
    assert.equal(caps.canManageAssetCustody, false)
  })

  test("'manage' alone opens the inventory, since the write actions live there", () => {
    const caps = deriveAssetsAccessCapabilities('member', perms(['manage']))
    assert.equal(caps.canViewAssetInventory, true)
    assert.equal(caps.canManageAssetCustody, true)
    assert.equal(caps.canCreateAsset, false)
  })

  test("'create' alone does not open the inventory on its own", () => {
    // Mirrors RLS: assets_insert allows the write, but nothing grants a read
    // of employee_assets, so the screen would be misleading. Grant view too.
    assert.equal(deriveAssetsAccessCapabilities('member', perms(['create'])).canViewAssetInventory, false)
  })

  test('Access Register stays admin-only regardless of module grants', () => {
    const caps = deriveAssetsAccessCapabilities('manager', perms(['view', 'create', 'assign', 'edit', 'delete', 'manage']))
    assert.equal(caps.canManageAccess, false)
    // …and a full grant still cannot reach plaintext secrets via the UI.
    assert.equal(deriveAssetsAccessCapabilities('member', perms(['manage'])).canManageAccess, false)
  })

  test('delete is grantable to a non-admin when an override says so', () => {
    const caps = deriveAssetsAccessCapabilities('manager', [
      { actionKey: 'delete', allowed: true, source: 'employee_override' },
    ])
    assert.equal(caps.canDeleteAsset, true)
  })
})
