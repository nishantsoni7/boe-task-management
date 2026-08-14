/**
 * Management-module visibility — behavioural tests.
 *
 * Pure data-in/data-out (no DB, no network). The rule under test is the one
 * that makes a launcher card and a route guard agree: entry needs effective
 * `view`, admins bypass, and Attendance/Payroll management can never be opened
 * by a grant.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/moduleVisibility.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  canAccessManagementModule,
  visibleManagementModules,
  isAdminRole,
} from './moduleVisibility'
import type { EffectivePermission } from './types'

const perms = (allowedActions: string[], deniedActions: string[] = []): EffectivePermission[] => [
  ...allowedActions.map(actionKey => ({ actionKey, allowed: true, source: 'employee_override' as const })),
  ...deniedActions.map(actionKey => ({ actionKey, allowed: false, source: 'system_default' as const })),
]

const check = (
  role: string | null,
  moduleKey: string,
  permissions: EffectivePermission[],
  isModuleActive = true,
) => canAccessManagementModule({ role, moduleKey, isModuleActive, permissions })

describe('view is what makes a module visible', () => {
  test('a member with view may enter', () => {
    assert.equal(check('member', 'finance', perms(['view'])), true)
  })

  test('a member with no view is denied', () => {
    assert.equal(check('member', 'finance', perms([], ['view'])), false)
    assert.equal(check('member', 'finance', []), false)
  })

  test('an explicit view = false denies, whatever else is held', () => {
    assert.equal(check('member', 'finance', perms(['create', 'edit'], ['view'])), false)
  })

  test('create/edit/approve/export/manage without view do NOT open the module', () => {
    for (const action of ['create', 'edit', 'approve', 'export', 'manage', 'delete']) {
      assert.equal(
        check('member', 'orders', perms([action])),
        false,
        `"${action}" alone must not expose the module`,
      )
    }
  })

  test('a manager is not special — the role name grants nothing here', () => {
    assert.equal(check('manager', 'finance', []), false)
    assert.equal(check('manager', 'finance', perms(['manage'])), false)
    assert.equal(check('manager', 'finance', perms(['view'])), true)
  })
})

describe('admin compatibility', () => {
  test('an admin may open an active module with no permission rows at all', () => {
    assert.equal(check('admin', 'finance', []), true)
    assert.equal(check('admin', 'orders', []), true)
  })

  test('an admin is not blocked by an explicit deny', () => {
    assert.equal(check('admin', 'finance', perms([], ['view'])), true)
  })

  test('an inactive module is off for everyone, admin included', () => {
    assert.equal(check('admin', 'finance', perms(['view']), false), false)
    assert.equal(check('member', 'finance', perms(['view']), false), false)
  })

  test('isAdminRole recognises only the exact admin role', () => {
    assert.equal(isAdminRole('admin'), true)
    assert.equal(isAdminRole('manager'), false)
    assert.equal(isAdminRole('member'), false)
    assert.equal(isAdminRole(null), false)
    assert.equal(isAdminRole(undefined), false)
    assert.equal(isAdminRole('Admin'), false)
  })

  test('a missing role never admits', () => {
    assert.equal(check(null, 'finance', perms(['view'])), false)
  })
})

describe('Attendance and Payroll self-service stays out of this helper', () => {
  test('a payroll view grant does NOT open management Payroll', () => {
    assert.equal(check('member', 'payroll', perms(['view'])), false)
    assert.equal(check('manager', 'payroll', perms(['view', 'manage', 'admin'])), false)
  })

  test('an attendance view grant does NOT open management Attendance', () => {
    assert.equal(check('member', 'attendance', perms(['view'])), false)
    assert.equal(check('manager', 'attendance', perms(['view', 'edit', 'manage'])), false)
  })

  test('management Attendance and Payroll remain open to admins', () => {
    assert.equal(check('admin', 'attendance', []), true)
    assert.equal(check('admin', 'payroll', []), true)
  })

  test('every other module is decided by the grant, not by the module key', () => {
    for (const moduleKey of ['finance', 'orders', 'meetings', 'assets_access', 'sample_tracking', 'performance']) {
      assert.equal(check('member', moduleKey, perms(['view'])), true, moduleKey)
    }
  })
})

describe('visibleManagementModules', () => {
  const modules = [
    { moduleKey: 'finance', isActive: true },
    { moduleKey: 'orders', isActive: true },
    { moduleKey: 'payroll', isActive: true },
    { moduleKey: 'meetings', isActive: false },
  ]

  test('returns only the modules the grants actually open', () => {
    const byModule = new Map<string, EffectivePermission[]>([
      ['finance', perms(['view', 'create'])],
      ['orders', perms(['create'])],
      ['payroll', perms(['view', 'manage'])],
      ['meetings', perms(['view'])],
    ])
    assert.deepEqual(visibleManagementModules('member', modules, byModule), ['finance'])
  })

  test('an admin gets every ACTIVE module, and no inactive one', () => {
    assert.deepEqual(
      visibleManagementModules('admin', modules, new Map()),
      ['finance', 'orders', 'payroll'],
    )
  })

  test('a module with no entry in the map is simply not visible', () => {
    assert.deepEqual(visibleManagementModules('member', modules, new Map()), [])
  })
})
