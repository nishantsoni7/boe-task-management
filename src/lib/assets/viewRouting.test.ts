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

const admin    = deriveAssetsAccessCapabilities('admin', [])
const employee = NO_ASSETS_ACCESS_CAPABILITIES
const viewer   = deriveAssetsAccessCapabilities('employee', [
  { actionKey: 'view', allowed: true },
] as never)

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
  test('everyone can always reach their own records', () => {
    assert.equal(canOpenView('my-assets', employee), true)
    assert.equal(canOpenView('my-access', employee), true)
  })

  test('management views require the matching capability', () => {
    assert.equal(canOpenView('asset-inventory', employee), false)
    assert.equal(canOpenView('access-register', employee), false)
    assert.equal(canOpenView('asset-requests', employee), false)

    assert.equal(canOpenView('asset-inventory', admin), true)
    assert.equal(canOpenView('access-register', admin), true)
    assert.equal(canOpenView('asset-requests', admin), true)
  })

  test('Access Register stays admin-only even for someone who can see the inventory', () => {
    // access_records still holds plaintext secrets (20260721000000).
    assert.equal(canOpenView('asset-inventory', viewer), true)
    assert.equal(canOpenView('access-register', viewer), false)
  })
})

describe('resolveInitialView', () => {
  test('an unrecognised value falls back rather than rendering nothing', () => {
    assert.equal(resolveInitialView('nonsense', admin, false), 'asset-inventory')
    assert.equal(resolveInitialView(null, admin, false), 'asset-inventory')
    assert.equal(resolveInitialView(undefined, employee, false), 'my-assets')
  })

  test('a permitted request is honoured', () => {
    assert.equal(resolveInitialView('asset-requests', admin, false), 'asset-requests')
    assert.equal(resolveInitialView('my-access', employee, false), 'my-access')
  })

  test('an UNPERMITTED request is refused, not honoured', () => {
    // The URL asks; the capabilities decide.
    assert.equal(resolveInitialView('access-register', employee, false), 'my-assets')
    assert.equal(resolveInitialView('asset-inventory', employee, false), 'my-assets')
  })

  test('View As lands on the impersonated person’s own records', () => {
    assert.equal(resolveInitialView(null, admin, true), 'my-assets')
  })

  test('View As does not lend authority, but an explicit request still works for the signed-in user', () => {
    // caps here are ALWAYS the signed-in user's, resolved before this is called.
    assert.equal(resolveInitialView('asset-inventory', admin, true), 'asset-inventory')
    assert.equal(resolveInitialView('asset-inventory', employee, true), 'my-assets')
  })
})
