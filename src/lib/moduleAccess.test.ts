/**
 * canAccessModule — behavioural tests
 *
 * Pure data-in/data-out logic (no DB calls), covering the visibility rules
 * shared by /modules and the Attendance/Payroll/Finance route guards:
 * live / admin_only / department_only / hidden, plus the no-row fallback.
 *
 * Run:
 *   npx tsx --test src/lib/moduleAccess.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  canAccessModule,
  resolveModuleAccess,
  resolveManagementAccess,
  isSelfServiceModule,
} from './moduleAccess'

const admin  = { role: 'admin',  team: 'sales' }
const member = { role: 'member', team: 'sales' }
const other  = { role: 'member', team: 'operations' }

describe('canAccessModule', () => {
  test('no visibility row falls back to the caller-supplied default', () => {
    assert.equal(canAccessModule(undefined, null, member, true), true)
    assert.equal(canAccessModule(undefined, null, member, false), false)
  })

  test('no profile always denies, regardless of fallback', () => {
    assert.equal(canAccessModule('live', null, null, true), true)
  })

  test('live is open to everyone', () => {
    assert.equal(canAccessModule('live', null, member, false), true)
    assert.equal(canAccessModule('live', null, admin, false), true)
  })

  test('hidden blocks everyone, including admin', () => {
    assert.equal(canAccessModule('hidden', null, admin, true), false)
    assert.equal(canAccessModule('hidden', null, member, true), false)
  })

  test('admin_only allows only admin', () => {
    assert.equal(canAccessModule('admin_only', null, admin, false), true)
    assert.equal(canAccessModule('admin_only', null, member, false), false)
  })

  test('department_only allows admin and a matching department, case-insensitively', () => {
    assert.equal(canAccessModule('department_only', ['Sales'], admin, false), true)
    assert.equal(canAccessModule('department_only', ['Sales'], member, false), true)
    assert.equal(canAccessModule('department_only', ['Sales'], other, false), false)
  })

  test('department_only allows any department in a multi-department list', () => {
    assert.equal(canAccessModule('department_only', ['sales', 'showroom'], member, false), true)
    assert.equal(canAccessModule('department_only', ['showroom', 'operations'], other, false), true)
    assert.equal(canAccessModule('department_only', ['showroom'], other, false), false)
  })

  test('department_only denies when no departments are configured', () => {
    assert.equal(canAccessModule('department_only', null, member, false), false)
    assert.equal(canAccessModule('department_only', [], member, false), false)
  })

  test('custom admits admin only, because this entry point has no member list', () => {
    assert.equal(canAccessModule('custom', null, admin, false), true)
    assert.equal(canAccessModule('custom', null, member, true), false)
  })

  test('an unrecognised mode denies rather than reading as live', () => {
    assert.equal(canAccessModule('something_new', null, member, true), false)
    assert.equal(canAccessModule('something_new', null, admin, false), true)
  })
})

// ─── resolveModuleAccess ──────────────────────────────────────────────────────

const A = { id: 'user-a', role: 'member', team: 'sales' }
const B = { id: 'user-b', role: 'member', team: 'sales' }
const C = { id: 'user-c', role: 'member', team: 'operations' }
const ADMIN = { id: 'user-admin', role: 'admin', team: 'admin' }

describe('resolveModuleAccess — custom members', () => {
  const custom = (ids: string[] | null) => ({
    visibility_type: 'custom',
    allowed_department: null,
    allowed_user_ids: ids,
  })

  test('selected members are admitted, unselected members are not', () => {
    const row = custom(['user-a', 'user-b'])
    assert.equal(resolveModuleAccess('task_management', row, A, false), true)
    assert.equal(resolveModuleAccess('task_management', row, B, false), true)
    assert.equal(resolveModuleAccess('task_management', row, C, false), false)
  })

  test('adding a member grants, removing one revokes', () => {
    assert.equal(resolveModuleAccess('task_management', custom(['user-a']), C, false), false)
    assert.equal(resolveModuleAccess('task_management', custom(['user-a', 'user-c']), C, false), true)
    assert.equal(resolveModuleAccess('task_management', custom(['user-c']), A, false), false)
  })

  test('an empty or null custom list fails closed for everyone but admin', () => {
    assert.equal(resolveModuleAccess('task_management', custom([]), A, true), false)
    assert.equal(resolveModuleAccess('task_management', custom(null), A, true), false)
    assert.equal(resolveModuleAccess('task_management', custom([]), ADMIN, false), true)
  })

  test('custom never depends on department', () => {
    const row = { visibility_type: 'custom', allowed_department: ['sales'], allowed_user_ids: ['user-c'] }
    assert.equal(resolveModuleAccess('task_management', row, A, false), false)
    assert.equal(resolveModuleAccess('task_management', row, C, false), true)
  })

  test('a member with no id cannot match a custom list', () => {
    const row = custom(['user-a'])
    assert.equal(resolveModuleAccess('task_management', row, { role: 'member', team: 'sales' }, true), false)
  })
})

describe('resolveModuleAccess — existing modes are unchanged', () => {
  const row = (visibility_type: string, allowed_department: string[] | null = null) =>
    ({ visibility_type, allowed_department, allowed_user_ids: null })

  test('live, admin_only, department_only and hidden behave as before', () => {
    assert.equal(resolveModuleAccess('task_management', row('live'), A, false), true)
    assert.equal(resolveModuleAccess('task_management', row('admin_only'), A, false), false)
    assert.equal(resolveModuleAccess('task_management', row('admin_only'), ADMIN, false), true)
    assert.equal(resolveModuleAccess('task_management', row('department_only', ['sales']), A, false), true)
    assert.equal(resolveModuleAccess('task_management', row('department_only', ['sales']), C, false), false)
    assert.equal(resolveModuleAccess('task_management', row('hidden'), ADMIN, true), false)
  })

  test('no row at all falls back to the caller-supplied default', () => {
    assert.equal(resolveModuleAccess('task_management', null, A, true), true)
    assert.equal(resolveModuleAccess('task_management', undefined, A, false), false)
    assert.equal(resolveModuleAccess('task_management', {}, A, true), true)
  })

  test('no profile denies whatever the fallback says', () => {
    assert.equal(resolveModuleAccess('task_management', row('live'), null, true), false)
  })
})

describe('attendance and payroll are self-service modules', () => {
  test('attendance and payroll are the self-service modules', () => {
    assert.equal(isSelfServiceModule('attendance'), true)
    assert.equal(isSelfServiceModule('payroll'), true)
    assert.equal(isSelfServiceModule('task_management'), false)
  })

  // resolveModuleAccess answers "may this person open the card", and for these
  // two the card is the employee's OWN record. So the ordinary modes apply.
  for (const key of ['attendance', 'payroll']) {
    test(`${key}: live gives every employee their own record`, () => {
      const row = { visibility_type: 'live', allowed_department: null, allowed_user_ids: null }
      assert.equal(resolveModuleAccess(key, row, C, false), true)
      assert.equal(resolveModuleAccess(key, row, ADMIN, false), true)
    })

    test(`${key}: custom names the employees who get their own record`, () => {
      const row = { visibility_type: 'custom', allowed_department: null, allowed_user_ids: ['user-a'] }
      assert.equal(resolveModuleAccess(key, row, A, false), true)
      assert.equal(resolveModuleAccess(key, row, C, false), false)
    })

    test(`${key}: hidden still hides it from admin`, () => {
      const row = { visibility_type: 'hidden', allowed_department: null, allowed_user_ids: ['user-a'] }
      assert.equal(resolveModuleAccess(key, row, ADMIN, true), false)
      assert.equal(resolveModuleAccess(key, row, A, true), false)
    })
  }
})

// ─── The privacy boundary ─────────────────────────────────────────────────────
//
// The rule the product owner set: Custom is self-service visibility, never
// management access. If one describe block in this file is load-bearing, it is
// this one — an earlier build let a Custom member read every salary in the
// company, and these assertions are what stop that coming back.

describe('resolveManagementAccess — attendance and payroll management is admin-only', () => {
  for (const key of ['attendance', 'payroll']) {
    test(`${key}: NO visibility mode grants management to a non-admin`, () => {
      for (const vt of ['live', 'admin_only', 'department_only', 'custom']) {
        const row = { visibility_type: vt, allowed_department: ['sales'], allowed_user_ids: ['user-a', 'user-b', 'user-c'] }
        assert.equal(resolveManagementAccess(key, row, A, true), false, `${key}/${vt}/A`)
        assert.equal(resolveManagementAccess(key, row, B, true), false, `${key}/${vt}/B`)
        assert.equal(resolveManagementAccess(key, row, C, true), false, `${key}/${vt}/C`)
      }
    })

    test(`${key}: custom does not promote a named member`, () => {
      const row = { visibility_type: 'custom', allowed_department: null, allowed_user_ids: ['user-a'] }
      // Sees the card…
      assert.equal(resolveModuleAccess(key, row, A, false), true)
      // …and still cannot manage.
      assert.equal(resolveManagementAccess(key, row, A, false), false)
    })

    test(`${key}: admin manages under every mode except hidden`, () => {
      for (const vt of ['live', 'admin_only', 'department_only', 'custom']) {
        const row = { visibility_type: vt, allowed_department: ['sales'], allowed_user_ids: [] }
        assert.equal(resolveManagementAccess(key, row, ADMIN, false), true, `${key}/${vt}`)
      }
      const hidden = { visibility_type: 'hidden', allowed_department: null, allowed_user_ids: [] }
      assert.equal(resolveManagementAccess(key, hidden, ADMIN, true), false)
    })
  }

  test('a module outside the self-service set is unaffected', () => {
    const row = { visibility_type: 'custom', allowed_department: null, allowed_user_ids: ['user-a'] }
    assert.equal(resolveManagementAccess('finance', row, A, false), true)
    assert.equal(resolveManagementAccess('finance', row, C, false), false)
  })

  test('no row falls back, exactly as the card decision does', () => {
    assert.equal(resolveManagementAccess('payroll', null, ADMIN, false), false)
    assert.equal(resolveManagementAccess('payroll', null, ADMIN, true), true)
  })
})

// ─── Launcher routing ─────────────────────────────────────────────────────────
//
// The card's destination is the whole privacy model made visible: an admin is
// sent to the management module, everybody else to their own record.

describe('launcher destination follows management access, not card visibility', () => {
  const dest = (key: string, row: Parameters<typeof resolveManagementAccess>[1], p: Parameters<typeof resolveManagementAccess>[2]) =>
    resolveManagementAccess(key, row, p, false)
      ? (key === 'payroll' ? '/payroll' : '/attendance')
      : (key === 'payroll' ? '/my-payroll' : '/my-attendance')

  const custom = { visibility_type: 'custom', allowed_department: null, allowed_user_ids: ['user-a'] }
  const live   = { visibility_type: 'live',   allowed_department: null, allowed_user_ids: null }

  test('admin goes to the management routes', () => {
    assert.equal(dest('attendance', live, ADMIN), '/attendance')
    assert.equal(dest('payroll',    live, ADMIN), '/payroll')
  })

  test('a Custom-selected employee goes to self-service', () => {
    assert.equal(dest('attendance', custom, A), '/my-attendance')
    assert.equal(dest('payroll',    custom, A), '/my-payroll')
  })

  test('an ordinary employee under live goes to self-service', () => {
    assert.equal(dest('attendance', live, C), '/my-attendance')
    assert.equal(dest('payroll',    live, C), '/my-payroll')
  })
})

// ─── Finance / Showroom compatibility ─────────────────────────────────────────
//
// Custom is offered for every module in Control Center, so every module's guard
// has to understand it. These two are NOT explicit-grant modules: their broad
// modes keep working exactly as they always did, and each keeps its own
// admin-first clause and its own functional permissions outside this resolver.

describe('custom works for Finance and Showroom without changing their other modes', () => {
  for (const key of ['finance', 'showroom_qr']) {
    test(`${key}: live still admits everyone`, () => {
      const row = { visibility_type: 'live', allowed_department: null, allowed_user_ids: null }
      assert.equal(resolveModuleAccess(key, row, A, false), true)
      assert.equal(resolveModuleAccess(key, row, C, false), true)
    })

    test(`${key}: department_only still follows the department`, () => {
      const row = { visibility_type: 'department_only', allowed_department: ['sales'], allowed_user_ids: null }
      assert.equal(resolveModuleAccess(key, row, A, false), true)   // sales
      assert.equal(resolveModuleAccess(key, row, C, false), false)  // operations
    })

    test(`${key}: custom admits the named members only`, () => {
      const row = { visibility_type: 'custom', allowed_department: null, allowed_user_ids: ['user-a', 'user-b'] }
      assert.equal(resolveModuleAccess(key, row, A, false), true)
      assert.equal(resolveModuleAccess(key, row, B, false), true)
      assert.equal(resolveModuleAccess(key, row, C, false), false)
    })

    test(`${key}: the no-row fallback is preserved for callers that pass one`, () => {
      // Finance and the Showroom screens pass an "open" fallback of their own
      // (Finance: true; Showroom: a sales/showroom team check). That must keep
      // working when app_modules has nothing to say.
      assert.equal(resolveModuleAccess(key, null, C, true), true)
      assert.equal(resolveModuleAccess(key, null, C, false), false)
    })
  }
})
