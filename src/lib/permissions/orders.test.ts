/**
 * Order Management capability derivation — behavioural tests.
 *
 * Pure data-in/data-out (no DB, no network). These assert the capability model
 * only; the Orders pages are not wired to it yet — module ENTRY already honours
 * the engine, everything inside still reads users.role.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/orders.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { deriveOrdersCapabilities, NO_ORDERS_CAPABILITIES } from './orders'
import { presetAllowedActions } from './levels'
import type { EffectivePermission } from './types'

const ORDERS_ACTIONS = [
  'view', 'create', 'edit', 'delete', 'approve', 'export', 'manage', 'can_be_order_assignee',
]

const perms = (allowedActions: string[]): EffectivePermission[] =>
  ORDERS_ACTIONS.map(actionKey => ({
    actionKey,
    allowed: allowedActions.includes(actionKey),
    source: 'employee_override' as const,
  }))

const fromPreset = (level: 'no_access' | 'viewer' | 'contributor' | 'manager') => {
  const map = presetAllowedActions(level, ORDERS_ACTIONS)
  return perms(ORDERS_ACTIONS.filter(a => map[a]))
}

describe('module entry', () => {
  test('no permissions at all means nothing', () => {
    assert.deepEqual(deriveOrdersCapabilities('member', []), NO_ORDERS_CAPABILITIES)
  })

  test('view opens the module and nothing else', () => {
    const caps = deriveOrdersCapabilities('member', perms(['view']))
    assert.equal(caps.canAccessOrdersModule, true)
    assert.equal(caps.canCreateOrder, false)
    assert.equal(caps.canApproveOrder, false)
    assert.equal(caps.canDeleteOrder, false)
    assert.equal(caps.canManageOrders, false)
    assert.equal(caps.canBeOrderAssignee, false)
  })

  test('a stronger action without view grants no module control', () => {
    for (const action of ['create', 'edit', 'approve', 'export', 'manage', 'delete']) {
      const caps = deriveOrdersCapabilities('member', perms([action]))
      assert.equal(caps.canAccessOrdersModule, false, `${action} must not open the module`)
      assert.deepEqual(caps, NO_ORDERS_CAPABILITIES, `${action} must not produce a button`)
    }
  })
})

describe('each capability maps to exactly one action', () => {
  const cases: [string, keyof ReturnType<typeof deriveOrdersCapabilities>][] = [
    ['create', 'canCreateOrder'],
    ['edit', 'canEditOrder'],
    ['approve', 'canApproveOrder'],
    ['export', 'canExportOrders'],
    ['delete', 'canDeleteOrder'],
    ['manage', 'canManageOrders'],
  ]

  for (const [action, capability] of cases) {
    test(`${action} → ${capability}, and no other capability`, () => {
      const caps = deriveOrdersCapabilities('member', perms(['view', action]))
      assert.equal(caps[capability], true)
      for (const [otherAction, otherCap] of cases) {
        if (otherAction === action) continue
        assert.equal(caps[otherCap], false, `${action} leaked into ${otherCap}`)
      }
    })
  }
})

describe('order-assignee authority is separate from everything else', () => {
  test('it is not implied by manage, edit, or any other action', () => {
    const caps = deriveOrdersCapabilities('member', perms(['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage']))
    assert.equal(caps.canManageOrders, true)
    assert.equal(caps.canBeOrderAssignee, false, 'assignee eligibility must be granted explicitly')
  })

  test('it survives without module entry — it is read by other people’s forms', () => {
    const caps = deriveOrdersCapabilities('member', perms(['can_be_order_assignee']))
    assert.equal(caps.canAccessOrdersModule, false)
    assert.equal(caps.canBeOrderAssignee, true)
  })

  test('no access level ever grants it', () => {
    for (const level of ['no_access', 'viewer', 'contributor', 'manager'] as const) {
      assert.equal(
        deriveOrdersCapabilities('member', fromPreset(level)).canBeOrderAssignee,
        false,
        `${level} granted assignee authority`,
      )
    }
  })

  test('not even an admin holds it without the grant', () => {
    assert.equal(deriveOrdersCapabilities('admin', []).canBeOrderAssignee, false)
    assert.equal(deriveOrdersCapabilities('admin', perms(['can_be_order_assignee'])).canBeOrderAssignee, true)
  })
})

describe('levels produce the expected Orders capabilities', () => {
  test('Contributor can raise and edit, not approve', () => {
    const caps = deriveOrdersCapabilities('member', fromPreset('contributor'))
    assert.equal(caps.canCreateOrder, true)
    assert.equal(caps.canEditOrder, true)
    assert.equal(caps.canApproveOrder, false)
  })

  test('Manager can approve and export, but cannot delete or manage', () => {
    const caps = deriveOrdersCapabilities('member', fromPreset('manager'))
    assert.equal(caps.canApproveOrder, true)
    assert.equal(caps.canExportOrders, true)
    assert.equal(caps.canDeleteOrder, false, 'delete is protected')
    assert.equal(caps.canManageOrders, false, 'manage is protected')
  })
})

describe('admin compatibility', () => {
  test('an admin holds every module capability with no rows at all', () => {
    const caps = deriveOrdersCapabilities('admin', [])
    for (const [name, value] of Object.entries(caps)) {
      if (name === 'canBeOrderAssignee') continue // deliberately grant-driven
      assert.equal(value, true, `admin missing ${name}`)
    }
  })
})

describe('real production grants', () => {
  test("Dhruv's full Orders grant yields the administrative controls", () => {
    const caps = deriveOrdersCapabilities(
      'manager',
      perms(['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage', 'can_be_order_assignee']),
    )
    assert.equal(caps.canApproveOrder, true)
    assert.equal(caps.canManageOrders, true)
    assert.equal(caps.canDeleteOrder, true)
    assert.equal(caps.canBeOrderAssignee, true)
  })

  test("Aditya's view-only Orders grant stays view-only", () => {
    const caps = deriveOrdersCapabilities('member', perms(['view']))
    assert.equal(caps.canAccessOrdersModule, true)
    assert.equal(caps.canCreateOrder, false)
    assert.equal(caps.canManageOrders, false)
  })
})
