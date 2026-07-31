/**
 * assetRowActions — the inventory button matrix.
 *
 * This is the guard against the defect that prompted the work: one capability
 * ('manage') drove Assign, Return and Mark Lost, so granting someone the
 * ability to hand out a laptop also let them write one off. Each button now
 * maps to exactly one permission, and every case below states which RPC would
 * receive the click.
 *
 * Run:
 *   npx tsx --test src/lib/assets/actionVisibility.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { assetRowActions } from './actionVisibility'
import {
  deriveAssetsAccessCapabilities,
  NO_ASSETS_ACCESS_CAPABILITIES,
} from '@/lib/permissions/assetsAccess'
import type { EffectivePermission } from '@/lib/permissions/types'

function perms(allowedActions: string[]): EffectivePermission[] {
  return ['view', 'create', 'assign', 'edit', 'delete', 'manage'].map(actionKey => ({
    actionKey,
    allowed: allowedActions.includes(actionKey),
    source: 'employee_override',
  }))
}

const admin      = deriveAssetsAccessCapabilities('admin', [])
const createOnly = deriveAssetsAccessCapabilities('member', perms(['view', 'create']))
const createAssign = deriveAssetsAccessCapabilities('member', perms(['view', 'create', 'assign']))
const viewOnly   = deriveAssetsAccessCapabilities('member', perms(['view']))
const custodian  = deriveAssetsAccessCapabilities('member', perms(['view', 'manage']))

describe('admin', () => {
  test('sees every action on an available asset except Return', () => {
    const a = assetRowActions(admin, 'available')
    assert.deepEqual(a, { assign: true, markReturned: false, markLost: true, edit: true, remove: true })
  })

  test('sees Return and Mark Lost on an assigned asset, but not Assign', () => {
    const a = assetRowActions(admin, 'assigned')
    assert.equal(a.assign, false)
    assert.equal(a.markReturned, true)
    assert.equal(a.markLost, true)
  })

  test('sees no custody actions on a lost asset', () => {
    const a = assetRowActions(admin, 'lost')
    assert.equal(a.assign, false)
    assert.equal(a.markReturned, false)
    assert.equal(a.markLost, false)
    assert.equal(a.edit, true)
  })
})

describe('create-only user', () => {
  test('sees no Assign — create does not carry assign', () => {
    assert.equal(assetRowActions(createOnly, 'available').assign, false)
  })

  test('sees no Edit, Delete, Return or Mark Lost in any state', () => {
    for (const status of ['available', 'assigned', 'lost']) {
      const a = assetRowActions(createOnly, status)
      assert.deepEqual(a, { assign: false, markReturned: false, markLost: false, edit: false, remove: false }, status)
    }
  })
})

describe('create + assign user', () => {
  test('sees Assign on an available asset', () => {
    assert.equal(assetRowActions(createAssign, 'available').assign, true)
  })

  test('does not see Assign on an asset someone already holds', () => {
    assert.equal(assetRowActions(createAssign, 'assigned').assign, false)
    assert.equal(assetRowActions(createAssign, 'lost').assign, false)
  })

  test('does not see Edit', () => {
    assert.equal(assetRowActions(createAssign, 'available').edit, false)
  })

  test('does not see Mark Lost — that is a manage decision', () => {
    assert.equal(assetRowActions(createAssign, 'available').markLost, false)
    assert.equal(assetRowActions(createAssign, 'assigned').markLost, false)
  })

  test('does not see Return', () => {
    assert.equal(assetRowActions(createAssign, 'assigned').markReturned, false)
  })

  test('does not see Delete', () => {
    assert.equal(assetRowActions(createAssign, 'available').remove, false)
  })
})

describe('manage-only custodian', () => {
  test('sees Return and Mark Lost but never Assign — the split runs both ways', () => {
    assert.equal(assetRowActions(custodian, 'assigned').markReturned, true)
    assert.equal(assetRowActions(custodian, 'available').markLost, true)
    assert.equal(assetRowActions(custodian, 'available').assign, false)
  })
})

describe('view-only employee', () => {
  test('sees no row actions at all, in any state', () => {
    for (const status of ['available', 'assigned', 'lost']) {
      const a = assetRowActions(viewOnly, status)
      assert.ok(!a.assign && !a.markReturned && !a.markLost && !a.edit && !a.remove, status)
    }
  })

  test('still counts as someone who may raise requests', () => {
    assert.equal(viewOnly.canRequestAssetChanges, true)
  })
})

describe('no capabilities at all', () => {
  test('renders nothing', () => {
    const a = assetRowActions(NO_ASSETS_ACCESS_CAPABILITIES, 'available')
    assert.deepEqual(a, { assign: false, markReturned: false, markLost: false, edit: false, remove: false })
  })
})
