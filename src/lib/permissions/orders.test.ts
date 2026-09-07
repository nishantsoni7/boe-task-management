/**
 * Order Management capability derivation — behavioural tests.
 *
 * Pure data-in/data-out (no DB, no network).
 *
 * TWO CAPABILITIES ARE DELIBERATELY ABSENT and are asserted absent below:
 * `canApproveOrder` (the `approve` action) meant "convert an Order Request into
 * an Order", and `canBeOrderAssignee` meant "may be named as an Order Request
 * assignee". The workflow is retired (20261007000000), the RPCs that read them
 * are revoked from every client role, and an Access Control option that grants
 * nothing is worse than no option: an administrator choosing it would believe
 * they had given somebody something.
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
  'view', 'create', 'edit', 'delete', 'export', 'manage', 'approve_order',
  'approve_advance_exception', 'align_production',
]

/** The two the module no longer registers. Never granted, never derived. */
const RETIRED_ACTIONS = ['approve', 'can_be_order_assignee']

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
    assert.equal(caps.canApproveOrderSubmission, false)
    assert.equal(caps.canDeleteOrder, false)
    assert.equal(caps.canManageOrders, false)
  })

  test('a stronger action without view grants no module control', () => {
    for (const action of ['create', 'edit', 'approve_order', 'export', 'manage', 'delete', 'align_production']) {
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
    ['approve_order', 'canApproveOrderSubmission'],
    // Deciding an advance exception (20260913000000). Its own action, its own
    // capability — independent of approve_order in both directions, which the
    // loop below proves the same way it proves every other pair: granting
    // this one must never leak into canApproveOrderSubmission, or into
    // canAlignProduction, or vice versa.
    ['approve_advance_exception', 'canApproveAdvanceException'],
    // The Head of Manufacturing's decision (20261119000000). Its own action,
    // its own capability, and neither approve_order nor manage implies it.
    ['align_production', 'canAlignProduction'],
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

describe('the retired Order Request authorities are gone, not merely unused', () => {
  test('neither action produces any capability, however it is granted', () => {
    // A GRANT THAT CONFERS NOTHING IS THE FAILURE MODE. Rows for these actions
    // may still exist in employee_permission_overrides — this change deletes no
    // data — and they must resolve to nothing rather than to an authority the
    // database will refuse.
    const caps = deriveOrdersCapabilities('member', perms(['view']).concat(
      RETIRED_ACTIONS.map(actionKey => ({ actionKey, allowed: true, source: 'employee_override' as const })),
    ))
    assert.deepEqual(caps, deriveOrdersCapabilities('member', perms(['view'])),
      'a retired grant must change nothing about what somebody can do')
  })

  test('the capability names themselves no longer exist', () => {
    const caps = deriveOrdersCapabilities('admin', [])
    for (const name of ['canApproveOrder', 'canBeOrderAssignee']) {
      assert.equal(name in caps, false, `${name} must not be derivable`)
    }
    assert.equal('canApproveOrder' in NO_ORDERS_CAPABILITIES, false)
    assert.equal('canBeOrderAssignee' in NO_ORDERS_CAPABILITIES, false)
  })

  test('PI review is untouched, and was deliberately never the `approve` action', () => {
    // That separation is exactly why the retirement takes nothing away from
    // anybody who reviews PIs today.
    const caps = deriveOrdersCapabilities('member', perms(['view', 'approve_order']))
    assert.equal(caps.canApproveOrderSubmission, true)
  })
})

describe('revocation removes exactly what was granted, and nothing else', () => {
  // getEffectivePermissionsForUser excludes any employee_permission_override
  // row with revoked_at set (resolve_permission, 20260660, line 233), so a
  // revoked grant and a grant that never existed produce the same
  // EffectivePermission[] here — there is no third state for this function to
  // get wrong. Naming the "before" and "after" explicitly, one action at a
  // time, is the same proof the per-action independence tests above already
  // give, made legible as revocation rather than inferred from it.
  const PROTECTED_ORDERS = [
    ['approve_order', 'canApproveOrderSubmission'],
    ['approve_advance_exception', 'canApproveAdvanceException'],
    ['align_production', 'canAlignProduction'],
  ] as const

  for (const [action, capability] of PROTECTED_ORDERS) {
    test(`revoking ${action} takes ${capability} away and leaves the rest of the grant untouched`, () => {
      const granted = deriveOrdersCapabilities('member', perms(['view', 'create', action]))
      assert.equal(granted[capability], true, 'the grant must be effective before revocation')
      assert.equal(granted.canCreateOrder, true, 'an unrelated grant made alongside it')

      const revoked = deriveOrdersCapabilities('member', perms(['view', 'create']))
      assert.equal(revoked[capability], false, 'revocation must remove exactly this authority')
      assert.equal(revoked.canCreateOrder, true, 'and must not touch an unrelated grant the employee still holds')
    })
  }

  test('an admin needs no grant, so revoking a non-admin employee override cannot touch admin authority', () => {
    // Revocation writes to employee_permission_overrides, which the admin
    // branch of actor_has_module_permission never consults.
    const caps = deriveOrdersCapabilities('admin', [])
    assert.equal(caps.canApproveOrderSubmission, true)
    assert.equal(caps.canApproveAdvanceException, true)
    assert.equal(caps.canAlignProduction, true)
  })
})

describe('levels produce the expected Orders capabilities', () => {
  test('Contributor can raise and edit, not review a PI', () => {
    const caps = deriveOrdersCapabilities('member', fromPreset('contributor'))
    assert.equal(caps.canCreateOrder, true)
    assert.equal(caps.canEditOrder, true)
    assert.equal(caps.canApproveOrderSubmission, false)
  })

  test('Manager can export, but cannot review a PI, delete or manage', () => {
    // `approve_order` is PROTECTED, so no preset reaches it — approving a PI is
    // what eventually brings an Order into existence and burns an order number.
    const caps = deriveOrdersCapabilities('member', fromPreset('manager'))
    assert.equal(caps.canExportOrders, true)
    assert.equal(caps.canApproveOrderSubmission, false, 'approve_order is protected')
    assert.equal(caps.canDeleteOrder, false, 'delete is protected')
    assert.equal(caps.canManageOrders, false, 'manage is protected')
  })
})

describe('admin compatibility', () => {
  test('an admin holds every module capability with no rows at all', () => {
    const caps = deriveOrdersCapabilities('admin', [])
    for (const [name, value] of Object.entries(caps)) {
      assert.equal(value, true, `admin missing ${name}`)
    }
  })
})

describe('real production grants', () => {
  test("Dhruv's full Orders grant yields the administrative controls", () => {
    const caps = deriveOrdersCapabilities(
      'manager',
      perms(['view', 'create', 'edit', 'delete', 'export', 'manage']),
    )
    assert.equal(caps.canManageOrders, true)
    assert.equal(caps.canDeleteOrder, true)
    assert.equal(caps.canEditOrder, true)
  })

  test("Aditya's view-only Orders grant stays view-only", () => {
    const caps = deriveOrdersCapabilities('member', perms(['view']))
    assert.equal(caps.canAccessOrdersModule, true)
    assert.equal(caps.canCreateOrder, false)
    assert.equal(caps.canManageOrders, false)
  })
})
