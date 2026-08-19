/**
 * Finance capability derivation — behavioural tests.
 *
 * Pure data-in/data-out (no DB, no network). Same shape as
 * assetsAccess.test.ts. These assert the capability model only; the Finance
 * pages are not wired to it yet.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/finance.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { deriveFinanceCapabilities, NO_FINANCE_CAPABILITIES } from './finance'
import { presetAllowedActions } from './levels'
import type { EffectivePermission } from './types'

const FINANCE_ACTIONS = [
  'view', 'create', 'edit', 'delete', 'approve', 'export', 'manage',
  // Registered by 20260918000000. Both protected: no preset reaches either.
  'allocate', 'allocate_correct',
]

const perms = (allowedActions: string[]): EffectivePermission[] =>
  FINANCE_ACTIONS.map(actionKey => ({
    actionKey,
    allowed: allowedActions.includes(actionKey),
    source: 'employee_override' as const,
  }))

const fromPreset = (level: 'no_access' | 'viewer' | 'contributor' | 'manager') => {
  const map = presetAllowedActions(level, FINANCE_ACTIONS)
  return perms(FINANCE_ACTIONS.filter(a => map[a]))
}

describe('module entry', () => {
  test('no permissions at all means nothing', () => {
    assert.deepEqual(deriveFinanceCapabilities('member', []), NO_FINANCE_CAPABILITIES)
  })

  test('view opens the module and nothing else', () => {
    const caps = deriveFinanceCapabilities('member', perms(['view']))
    assert.equal(caps.canAccessFinanceModule, true)
    assert.equal(caps.canCreatePaymentRecord, false)
    assert.equal(caps.canApprovePayment, false)
    assert.equal(caps.canCorrectOrReversePayment, false)
    assert.equal(caps.canDeletePaymentRecord, false)
    assert.equal(caps.canManageFinance, false)
  })

  test('a stronger action without view grants nothing — not even itself', () => {
    for (const action of ['create', 'edit', 'approve', 'export', 'manage', 'delete']) {
      const caps = deriveFinanceCapabilities('member', perms([action]))
      assert.equal(caps.canAccessFinanceModule, false, `${action} must not open the module`)
      assert.deepEqual(caps, NO_FINANCE_CAPABILITIES, `${action} must not produce a button`)
    }
  })
})

describe('each capability maps to exactly one action', () => {
  const cases: [string, keyof ReturnType<typeof deriveFinanceCapabilities>][] = [
    ['create', 'canCreatePaymentRecord'],
    ['edit', 'canEditPaymentRecord'],
    ['approve', 'canApprovePayment'],
    ['export', 'canExportFinance'],
    ['delete', 'canDeletePaymentRecord'],
    ['manage', 'canManageFinance'],
  ]

  for (const [action, capability] of cases) {
    test(`${action} → ${capability}, and no other capability`, () => {
      const caps = deriveFinanceCapabilities('member', perms(['view', action]))
      assert.equal(caps[capability], true)
      for (const [otherAction, otherCap] of cases) {
        if (otherAction === action) continue
        // manage backs two named capabilities on purpose — see finance.ts
        if (action === 'manage' && otherCap === 'canManageFinance') continue
        assert.equal(caps[otherCap], false, `${action} leaked into ${otherCap}`)
      }
    })
  }

  test('correct/reverse and manage are both backed by the manage action', () => {
    const caps = deriveFinanceCapabilities('member', perms(['view', 'manage']))
    assert.equal(caps.canCorrectOrReversePayment, true)
    assert.equal(caps.canManageFinance, true)
    const without = deriveFinanceCapabilities('member', perms(['view', 'approve']))
    assert.equal(without.canCorrectOrReversePayment, false)
  })
})

describe('levels produce the expected Finance capabilities', () => {
  test('Viewer can only look', () => {
    const caps = deriveFinanceCapabilities('member', fromPreset('viewer'))
    assert.equal(caps.canAccessFinanceModule, true)
    assert.equal(caps.canCreatePaymentRecord, false)
  })

  test('Contributor can raise and edit, but not approve', () => {
    const caps = deriveFinanceCapabilities('member', fromPreset('contributor'))
    assert.equal(caps.canCreatePaymentRecord, true)
    assert.equal(caps.canEditPaymentRecord, true)
    assert.equal(caps.canApprovePayment, false)
  })

  test('Manager can approve and export, but cannot correct, reverse or delete', () => {
    const caps = deriveFinanceCapabilities('member', fromPreset('manager'))
    assert.equal(caps.canApprovePayment, true)
    assert.equal(caps.canExportFinance, true)
    assert.equal(caps.canCorrectOrReversePayment, false, 'correction is protected')
    assert.equal(caps.canManageFinance, false, 'manage is protected')
    assert.equal(caps.canDeletePaymentRecord, false, 'delete is protected')
  })

  test('No Access really is nothing', () => {
    assert.deepEqual(deriveFinanceCapabilities('member', fromPreset('no_access')), NO_FINANCE_CAPABILITIES)
  })
})

describe('admin compatibility', () => {
  test('an admin holds every Finance capability with no rows at all', () => {
    const caps = deriveFinanceCapabilities('admin', [])
    for (const [name, value] of Object.entries(caps)) {
      assert.equal(value, true, `admin missing ${name}`)
    }
  })

  test('an admin is not reduced by an explicit deny', () => {
    const caps = deriveFinanceCapabilities('admin', perms([]))
    assert.equal(caps.canApprovePayment, true)
    assert.equal(caps.canCorrectOrReversePayment, true)
  })
})

describe("Dhruv's real production grant", () => {
  // Captured read-only from production: every Finance action allowed via
  // employee_override. He is role = 'manager', and today the Finance pages
  // gate their controls on role === 'admin', so none of this reaches him.
  const dhruv = perms(['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage'])

  test('the capability model gives him the admin controls his grant describes', () => {
    const caps = deriveFinanceCapabilities('manager', dhruv)
    assert.equal(caps.canAccessFinanceModule, true)
    assert.equal(caps.canApprovePayment, true)
    assert.equal(caps.canCorrectOrReversePayment, true)
    assert.equal(caps.canDeletePaymentRecord, true)
  })

  test('a colleague on Contributor does not get those controls', () => {
    // Prerna / Saksham / Mohit / Shravi / Ashok all hold view+create+edit.
    const caps = deriveFinanceCapabilities('member', perms(['view', 'create', 'edit']))
    assert.equal(caps.canApprovePayment, false)
    assert.equal(caps.canCorrectOrReversePayment, false)
    assert.equal(caps.canDeletePaymentRecord, false)
  })
})

describe('payment allocation (20260918000000)', () => {
  test('no preset level reaches either allocation action', () => {
    // The database says the same thing twice — default_allowed = false on both
    // module_permission_actions rows, and no role_permissions row at all — and
    // the migration asserts it at apply time. This is the UI half of it.
    for (const level of ['no_access', 'viewer', 'contributor', 'manager'] as const) {
      const caps = deriveFinanceCapabilities('member', fromPreset(level))
      assert.equal(caps.canAllocatePayment, false, `${level} reached allocate`)
      assert.equal(caps.canCorrectPaymentAllocation, false, `${level} reached allocate_correct`)
    }
  })

  test('an explicit allocate grant gives allocation and nothing else', () => {
    const caps = deriveFinanceCapabilities('member', perms(['view', 'allocate']))
    assert.equal(caps.canAllocatePayment, true)
    // The whole point of a separate action: it confers no verification, no
    // correction, no company-wide sight and no delete.
    assert.equal(caps.canCorrectPaymentAllocation, false)
    assert.equal(caps.canApprovePayment, false)
    assert.equal(caps.canCorrectOrReversePayment, false)
    assert.equal(caps.canViewAllFinance, false)
    assert.equal(caps.canDeletePaymentRecord, false)
  })

  test('an explicit allocate_correct grant does not confer allocate', () => {
    const caps = deriveFinanceCapabilities('member', perms(['view', 'allocate_correct']))
    assert.equal(caps.canCorrectPaymentAllocation, true)
    assert.equal(caps.canAllocatePayment, false)
    assert.equal(caps.canApprovePayment, false)
  })

  test('the two are independent of approve in both directions', () => {
    // Verifying that money arrived, deciding which business it belongs to, and
    // undoing that decision are three separable jobs. approve must not drag the
    // other two along, and neither of them may confer approve.
    const approver = deriveFinanceCapabilities('member', perms(['view', 'approve']))
    assert.equal(approver.canApprovePayment, true)
    assert.equal(approver.canAllocatePayment, false)
    assert.equal(approver.canCorrectPaymentAllocation, false)

    const both = deriveFinanceCapabilities('member', perms(['view', 'allocate', 'allocate_correct']))
    assert.equal(both.canApprovePayment, false)
  })

  test('manage does not imply either allocation action', () => {
    // finance.manage is the post-approval correction authority and is already
    // wide. It must not silently pick up allocation as well, or splitting the
    // actions would have bought nothing.
    const caps = deriveFinanceCapabilities('member', perms(['view', 'manage']))
    assert.equal(caps.canCorrectOrReversePayment, true)
    assert.equal(caps.canAllocatePayment, false)
    assert.equal(caps.canCorrectPaymentAllocation, false)
  })

  test('an allocation grant without module entry produces nothing', () => {
    // Every capability is gated on entry as well as on its own action, so a row
    // left behind by a half-finished grant cannot produce a control on a module
    // the person cannot open.
    const caps = deriveFinanceCapabilities('member', perms(['allocate', 'allocate_correct']))
    assert.equal(caps.canAccessFinanceModule, false)
    assert.equal(caps.canAllocatePayment, false)
    assert.equal(caps.canCorrectPaymentAllocation, false)
  })

  test('an admin holds both, matching actor_has_module_permission', () => {
    const caps = deriveFinanceCapabilities('admin', [])
    assert.equal(caps.canAllocatePayment, true)
    assert.equal(caps.canCorrectPaymentAllocation, true)
  })

  test('No Access is still exactly nothing, with the two new fields included', () => {
    assert.deepEqual(deriveFinanceCapabilities('member', fromPreset('no_access')), NO_FINANCE_CAPABILITIES)
    assert.equal(NO_FINANCE_CAPABILITIES.canAllocatePayment, false)
    assert.equal(NO_FINANCE_CAPABILITIES.canCorrectPaymentAllocation, false)
  })
})
