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
  return ['view', 'create', 'edit', 'delete', 'manage'].map(actionKey => ({
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
      canViewInventory: true,
      canCreateAsset: true,
      canEditAsset: true,
      canDeleteAsset: true,
      canManageAssignments: true,
      canManageAccess: true,
    })
  })

  test('admin keeps full capability even when the engine denies every action', () => {
    const caps = deriveAssetsAccessCapabilities('admin', perms([]))
    assert.equal(caps.canDeleteAsset, true)
    assert.equal(caps.canManageAccess, true)
  })

  test('manager defaults (view/create/edit/manage) — everything except delete', () => {
    const caps = deriveAssetsAccessCapabilities('manager', perms(['view', 'create', 'edit', 'manage']))
    assert.equal(caps.canViewInventory, true)
    assert.equal(caps.canCreateAsset, true)
    assert.equal(caps.canEditAsset, true)
    assert.equal(caps.canManageAssignments, true)
    assert.equal(caps.canDeleteAsset, false)
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
    assert.equal(caps.canManageAssignments, false)
    assert.equal(caps.canViewInventory, true)
  })

  test("'view' alone opens a read-only inventory — no write capability", () => {
    const caps = deriveAssetsAccessCapabilities('member', perms(['view']))
    assert.equal(caps.canViewInventory, true)
    assert.equal(caps.canCreateAsset, false)
    assert.equal(caps.canEditAsset, false)
    assert.equal(caps.canDeleteAsset, false)
    assert.equal(caps.canManageAssignments, false)
  })

  test("'manage' alone opens the inventory, since the write actions live there", () => {
    const caps = deriveAssetsAccessCapabilities('member', perms(['manage']))
    assert.equal(caps.canViewInventory, true)
    assert.equal(caps.canManageAssignments, true)
    assert.equal(caps.canCreateAsset, false)
  })

  test("'create' alone does not open the inventory on its own", () => {
    // Mirrors RLS: assets_insert allows the write, but nothing grants a read
    // of employee_assets, so the screen would be misleading. Grant view too.
    assert.equal(deriveAssetsAccessCapabilities('member', perms(['create'])).canViewInventory, false)
  })

  test('Access Register stays admin-only regardless of module grants', () => {
    const caps = deriveAssetsAccessCapabilities('manager', perms(['view', 'create', 'edit', 'delete', 'manage']))
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
