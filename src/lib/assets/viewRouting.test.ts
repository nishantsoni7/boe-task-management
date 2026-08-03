/**
 * Assets & Access view routing — a URL is a request, not an authorization.
 *
 * Run:
 *   npx tsx --test src/lib/assets/viewRouting.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { canOpenView, isAssetsView, resolveInitialView } from './viewRouting'
import {
  NO_ASSETS_ACCESS_CAPABILITIES,
  deriveAssetsAccessCapabilities,
} from '@/lib/permissions/assetsAccess'
import type { EffectivePermission } from '@/lib/permissions/types'

const perms = (actions: string[]): EffectivePermission[] =>
  actions.map(actionKey => ({ actionKey, allowed: true, source: 'role' as const }))

const admin    = deriveAssetsAccessCapabilities('admin', [])
const nobody   = NO_ASSETS_ACCESS_CAPABILITIES
/** The ordinary case: system-default 'view', which every active employee has. */
const employee = deriveAssetsAccessCapabilities('member', perms(['view']))
/** A manager whose authority comes from a grant, not from the role name. */
const inventoryManager = deriveAssetsAccessCapabilities('manager', perms(['view', 'manage']))
/** The manager role with nothing but the same default the employee has. */
const managerNoGrant   = deriveAssetsAccessCapabilities('manager', perms(['view']))

describe('isAssetsView', () => {
  test('accepts the five real views and nothing else', () => {
    for (const v of ['my-assets', 'my-access', 'asset-inventory', 'access-register', 'asset-requests']) {
      assert.equal(isAssetsView(v), true, v)
    }
    assert.equal(isAssetsView('notifications'), false)
    assert.equal(isAssetsView(''), false)
    assert.equal(isAssetsView(null), false)
    assert.equal(isAssetsView(undefined), false)
    assert.equal(isAssetsView({ view: 'my-assets' }), false)
  })
})

describe('canOpenView', () => {
  test('own-record views are always openable — they show only your own rows', () => {
    assert.equal(canOpenView('my-assets', nobody), true)
    assert.equal(canOpenView('my-access', nobody), true)
    assert.equal(canOpenView('my-assets', employee), true)
    assert.equal(canOpenView('my-access', employee), true)
  })

  test('an employee with only view cannot open the inventory', () => {
    assert.equal(canOpenView('asset-inventory', employee), false)
    assert.equal(canOpenView('access-register', employee), false)
  })

  test('the manager ROLE alone changes nothing', () => {
    assert.equal(canOpenView('asset-inventory', managerNoGrant), false)
    assert.equal(canOpenView('access-register', managerNoGrant), false)
  })

  test('a manager with a management GRANT can open the inventory', () => {
    assert.equal(canOpenView('asset-inventory', inventoryManager), true)
  })

  test('management views require the matching capability', () => {
    assert.equal(canOpenView('asset-inventory', nobody), false)
    assert.equal(canOpenView('access-register', nobody), false)
    assert.equal(canOpenView('asset-requests', nobody), false)

    assert.equal(canOpenView('asset-inventory', admin), true)
    assert.equal(canOpenView('access-register', admin), true)
    assert.equal(canOpenView('asset-requests', admin), true)
  })

  test('Access Register is admin-only, whatever else is granted', () => {
    // access_records still holds plaintext secrets (20260640 security note).
    assert.equal(canOpenView('access-register', inventoryManager), false)
    assert.equal(canOpenView('access-register', employee), false)
    assert.equal(canOpenView('access-register', admin), true)
  })

  test('the requests screen opens for a requester as well as a reviewer', () => {
    assert.equal(canOpenView('asset-requests', employee), true)         // their own
    assert.equal(canOpenView('asset-requests', inventoryManager), true) // the queue
    assert.equal(canOpenView('asset-requests', nobody), false)
  })
})

describe('resolveInitialView', () => {
  test('an unrecognised value falls back rather than rendering nothing', () => {
    assert.equal(resolveInitialView('nonsense', admin, false), 'asset-inventory')
    assert.equal(resolveInitialView(null, admin, false), 'asset-inventory')
    assert.equal(resolveInitialView(undefined, employee, false), 'my-assets')
  })

  test('landing view: inventory for a manager, own assets for everyone else', () => {
    assert.equal(resolveInitialView(null, admin, false), 'asset-inventory')
    assert.equal(resolveInitialView(null, inventoryManager, false), 'asset-inventory')
    assert.equal(resolveInitialView(null, employee, false), 'my-assets')
    assert.equal(resolveInitialView(null, managerNoGrant, false), 'my-assets')
    assert.equal(resolveInitialView(null, nobody, false), 'my-assets')
  })

  test('a permitted request is honoured', () => {
    assert.equal(resolveInitialView('asset-requests', admin, false), 'asset-requests')
    assert.equal(resolveInitialView('my-access', employee, false), 'my-access')
    assert.equal(resolveInitialView('asset-inventory', inventoryManager, false), 'asset-inventory')
  })

  test('?view=asset-inventory is refused for an employee with only view', () => {
    // The URL asks; the capabilities decide. This is the query-string half of
    // the fix — the page must not render an inventory for someone whose
    // queries would be empty anyway.
    assert.equal(resolveInitialView('asset-inventory', employee, false), 'my-assets')
    assert.equal(resolveInitialView('asset-inventory', managerNoGrant, false), 'my-assets')
    assert.equal(resolveInitialView('asset-inventory', nobody, false), 'my-assets')
  })

  test('?view=access-register is refused for everyone but an admin', () => {
    // Refused means "fall back to your NORMAL landing view", which for an
    // inventory manager is the inventory — not a demotion to my-assets.
    assert.equal(resolveInitialView('access-register', employee, false), 'my-assets')
    assert.equal(resolveInitialView('access-register', nobody, false), 'my-assets')
    assert.equal(resolveInitialView('access-register', managerNoGrant, false), 'my-assets')
    assert.equal(resolveInitialView('access-register', inventoryManager, false), 'asset-inventory')
    assert.equal(resolveInitialView('access-register', admin, false), 'access-register')
  })

  test('View As lands on the impersonated person’s own records', () => {
    assert.equal(resolveInitialView(null, admin, true), 'my-assets')
    assert.equal(resolveInitialView(null, inventoryManager, true), 'my-assets')
  })

  test('View As does not lend authority', () => {
    // caps here are ALWAYS the signed-in user's, resolved before this is
    // called — impersonating an admin cannot produce an admin's caps.
    assert.equal(resolveInitialView('asset-inventory', admin, true), 'asset-inventory')
    assert.equal(resolveInitialView('asset-inventory', employee, true), 'my-assets')
    assert.equal(resolveInitialView('access-register', employee, true), 'my-assets')
  })
})
