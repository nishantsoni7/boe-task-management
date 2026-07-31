/**
 * Asset detail — query shape and current-custodian tests.
 *
 * Run:
 *   npx tsx --test src/lib/assets/detail.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASSET_ACTIVITY_COLUMNS,
  ASSET_COLUMNS,
  EMPLOYEE_ASSET_COLUMNS,
  isOpenAssignment,
  resolveAssetCustodian,
} from './detail'

describe('query shapes', () => {
  test('asset_code and location are read by every asset query', () => {
    // Both the inventory and the detail page select through this constant, so
    // this is also what guarantees the code appears in both.
    for (const column of ['id', 'asset_code', 'asset_name', 'asset_type', 'serial_no', 'location', 'status']) {
      assert.ok(ASSET_COLUMNS.split(', ').includes(column), `ASSET_COLUMNS is missing ${column}`)
    }
  })

  test('the activity query reads the snapshots, not just the live asset link', () => {
    for (const column of ['asset_code_snapshot', 'asset_name_snapshot', 'event_at', 'created_at', 'summary', 'details']) {
      assert.ok(ASSET_ACTIVITY_COLUMNS.split(', ').includes(column), `ASSET_ACTIVITY_COLUMNS is missing ${column}`)
    }
  })

  test('no asset query reaches for access credentials', () => {
    // access_records still stores secret_value in plain text (20260640), and
    // the detail page must never be the thing that exposes it.
    for (const columns of [ASSET_COLUMNS, EMPLOYEE_ASSET_COLUMNS, ASSET_ACTIVITY_COLUMNS]) {
      for (const forbidden of ['secret_value', 'access_records', 'username', 'access_type']) {
        assert.ok(!columns.includes(forbidden), `${forbidden} must not appear in an asset query`)
      }
    }
  })
})

describe('isOpenAssignment', () => {
  test('custody that has not ended', () => {
    assert.equal(isOpenAssignment('pending_acceptance'), true)
    assert.equal(isOpenAssignment('accepted'), true)
  })

  test('custody that has ended, or none at all', () => {
    assert.equal(isOpenAssignment('returned'), false)
    assert.equal(isOpenAssignment('lost'), false)
    assert.equal(isOpenAssignment(null), false)
    assert.equal(isOpenAssignment(undefined), false)
  })
})

describe('resolveAssetCustodian', () => {
  test('an employee holding the asset outranks the location field', () => {
    const custodian = resolveAssetCustodian({
      hasOpenAssignment: true,
      employeeName: 'Priya Sharma',
      location: 'Store Room',
    })
    assert.deepEqual(custodian, { kind: 'employee', label: 'Priya Sharma' })
  })

  test('a pending, not-yet-accepted assignment is still custody by a person', () => {
    const custodian = resolveAssetCustodian({ hasOpenAssignment: true, employeeName: 'Priya Sharma' })
    assert.equal(custodian.kind, 'employee')
  })

  test('an asset nobody holds shows where it is kept', () => {
    const custodian = resolveAssetCustodian({ hasOpenAssignment: false, location: 'Design Department' })
    assert.deepEqual(custodian, { kind: 'location', label: 'Design Department' })
  })

  test('an open assignment with an unresolvable name never falls back to a location', () => {
    // The module's standing rule: an asset must never read as held while
    // naming nobody. Saying "Assigned employee" is honest; naming a room the
    // asset is not in would not be.
    const custodian = resolveAssetCustodian({
      hasOpenAssignment: true,
      employeeName: null,
      location: 'Store Room',
    })
    assert.deepEqual(custodian, { kind: 'employee', label: 'Assigned employee' })
  })

  test('whitespace is not a location', () => {
    const custodian = resolveAssetCustodian({ hasOpenAssignment: false, location: '   ' })
    assert.deepEqual(custodian, { kind: 'unknown', label: 'No location set' })
  })

  test('no custodian and no location says so plainly', () => {
    const custodian = resolveAssetCustodian({ hasOpenAssignment: false, location: null })
    assert.deepEqual(custodian, { kind: 'unknown', label: 'No location set' })
  })
})
