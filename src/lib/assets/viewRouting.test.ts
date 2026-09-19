/**
 * Assets & Access view routing — a URL is a request, not an authorization.
 *
 * Run:
 *   npx tsx --test src/lib/assets/viewRouting.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  areaForView, canOpenView, defaultViewForArea, isAssetsView, resolveInitialView,
} from './viewRouting'
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
/**
 * The delegated Access Register administrator (20261028000000): the new grant
 * and module entry, and NO asset authority of any kind.
 */
const accessAdmin = deriveAssetsAccessCapabilities('member', perms(['view', 'manage_access_records']))

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

  test('Access Register needs its OWN grant — no amount of asset authority opens it', () => {
    // access_records still holds plaintext secrets (20260640 security note), so
    // 20261028000000 delegated the screen by a dedicated key rather than by
    // widening any existing one.
    assert.equal(canOpenView('access-register', inventoryManager), false)
    assert.equal(canOpenView('access-register', employee), false)
    assert.equal(canOpenView('access-register', admin), true)

    const everyAssetAction = deriveAssetsAccessCapabilities(
      'manager', perms(['view', 'create', 'assign', 'edit', 'delete', 'manage']),
    )
    assert.equal(canOpenView('access-register', everyAssetAction), false)

    assert.equal(canOpenView('access-register', accessAdmin), true)
  })

  test('the Access Register grant opens that screen and nothing else', () => {
    assert.equal(canOpenView('asset-inventory', accessAdmin), false)
    // Own records, which everybody has — not a management screen.
    assert.equal(canOpenView('my-assets', accessAdmin), true)
    assert.equal(canOpenView('my-access', accessAdmin), true)
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

  test('?view=access-register is refused without the Access Register grant', () => {
    // Refused means "fall back to your NORMAL landing view", which for an
    // inventory manager is the inventory — not a demotion to my-assets.
    assert.equal(resolveInitialView('access-register', employee, false), 'my-assets')
    assert.equal(resolveInitialView('access-register', nobody, false), 'my-assets')
    assert.equal(resolveInitialView('access-register', managerNoGrant, false), 'my-assets')
    assert.equal(resolveInitialView('access-register', inventoryManager, false), 'asset-inventory')
    assert.equal(resolveInitialView('access-register', admin, false), 'access-register')
    assert.equal(resolveInitialView('access-register', accessAdmin, false), 'access-register')
  })

  test('the Access Register holder lands there, not on an asset screen they hold nothing on', () => {
    assert.equal(resolveInitialView(null, accessAdmin, false), 'access-register')
    // Somebody holding both is here to manage assets: the inventory wins.
    const both = deriveAssetsAccessCapabilities('manager', perms(['view', 'manage', 'manage_access_records']))
    assert.equal(resolveInitialView(null, both, false), 'asset-inventory')
  })
})

// ── The two top-level areas ─────────────────────────────────────────────────

describe('areaForView', () => {
  test('every view belongs to exactly one area, and the split is by subject', () => {
    assert.equal(areaForView('my-assets'), 'assets')
    assert.equal(areaForView('asset-inventory'), 'assets')
    assert.equal(areaForView('asset-requests'), 'assets')
    assert.equal(areaForView('my-access'), 'access-records')
    assert.equal(areaForView('access-register'), 'access-records')
  })
})

describe('defaultViewForArea', () => {
  test('the strongest screen the reader may open in that area', () => {
    assert.equal(defaultViewForArea('assets', admin), 'asset-inventory')
    assert.equal(defaultViewForArea('access-records', admin), 'access-register')
    assert.equal(defaultViewForArea('assets', inventoryManager), 'asset-inventory')
    assert.equal(defaultViewForArea('access-records', accessAdmin), 'access-register')
  })

  test('falls back to own records, which everybody may always see', () => {
    assert.equal(defaultViewForArea('assets', employee), 'my-assets')
    assert.equal(defaultViewForArea('access-records', employee), 'my-access')
    assert.equal(defaultViewForArea('assets', nobody), 'my-assets')
    assert.equal(defaultViewForArea('access-records', nobody), 'my-access')
    // An inventory manager has no Access Register grant, so switching area
    // must not offer them the register.
    assert.equal(defaultViewForArea('access-records', inventoryManager), 'my-access')
    // …and the Access Register holder gets no inventory.
    assert.equal(defaultViewForArea('assets', accessAdmin), 'my-assets')
  })

  test('it can never return a view canOpenView would refuse', () => {
    const everyone = [admin, employee, nobody, inventoryManager, managerNoGrant, accessAdmin]
    for (const caps of everyone) {
      for (const area of ['assets', 'access-records'] as const) {
        for (const inViewMode of [false, true]) {
          const view = defaultViewForArea(area, caps, inViewMode)
          assert.equal(canOpenView(view, caps), true, `${area} / ${inViewMode}`)
          assert.equal(areaForView(view), area, `${area} landed outside its own area`)
        }
      }
    }
  })

  test('View As lands on the impersonated person’s own records in either area', () => {
    assert.equal(defaultViewForArea('assets', admin, true), 'my-assets')
    assert.equal(defaultViewForArea('access-records', admin, true), 'my-access')
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
