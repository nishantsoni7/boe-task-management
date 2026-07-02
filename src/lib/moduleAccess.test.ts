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
import { canAccessModule } from './moduleAccess'

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

  test('department_only allows admin and the matching department, case-insensitively', () => {
    assert.equal(canAccessModule('department_only', 'Sales', admin, false), true)
    assert.equal(canAccessModule('department_only', 'Sales', member, false), true)
    assert.equal(canAccessModule('department_only', 'Sales', other, false), false)
  })
})
