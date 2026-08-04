/**
 * Payroll unlock guards — who may reopen a finalised month, when, and with what
 * stated reason.
 *
 * Pure logic, so no database and no HTTP. The route wires these three answers
 * to status codes; these tests fix the answers themselves.
 *
 * Run:
 *   npx tsx --test src/lib/payroll/unlockRules.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  canUnlockPayroll,
  validateUnlockReason,
  UNLOCK_TARGET_STATUS,
  UNLOCK_REASON_MAX_LENGTH,
} from './unlockRules'

describe('canUnlockPayroll', () => {
  test('an admin may unlock a locked period, and it reopens as generated', () => {
    const decision = canUnlockPayroll('admin', 'locked')
    assert.equal(decision.allowed, true)
    if (!decision.allowed) return
    assert.equal(decision.targetStatus, 'generated')
    assert.equal(decision.targetStatus, UNLOCK_TARGET_STATUS)
  })

  test('a non-admin cannot unlock, whatever the period status', () => {
    for (const role of ['manager', 'employee', '', null, undefined]) {
      const decision = canUnlockPayroll(role, 'locked')
      assert.equal(decision.allowed, false, `role ${String(role)} must be refused`)
      if (decision.allowed) return
      assert.equal(decision.reason, 'not_authorised')
      assert.match(decision.message, /administrator/i)
    }
  })

  test('the role is refused before the status is considered', () => {
    // A manager asking about a draft period is refused as not authorised, not
    // as "nothing to unlock" — the reason returned drives the status code, and
    // a 422 there would tell a non-admin the period exists and is not locked.
    const decision = canUnlockPayroll('manager', 'draft')
    assert.equal(decision.allowed, false)
    if (decision.allowed) return
    assert.equal(decision.reason, 'not_authorised')
  })

  test('a period that is not locked cannot be unlocked, even by an admin', () => {
    for (const status of ['draft', 'generated'] as const) {
      const decision = canUnlockPayroll('admin', status)
      assert.equal(decision.allowed, false, `${status} must be refused`)
      if (decision.allowed) return
      assert.equal(decision.reason, 'not_locked')
      assert.match(decision.message, /not locked/i)
    }
  })

  test('a missing period status is refused rather than treated as locked', () => {
    const decision = canUnlockPayroll('admin', null)
    assert.equal(decision.allowed, false)
    if (decision.allowed) return
    assert.equal(decision.reason, 'not_locked')
  })
})

describe('validateUnlockReason', () => {
  test('a stated reason is accepted and trimmed', () => {
    const result = validateUnlockReason('  Attendance correction approved.  ')
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value, 'Attendance correction approved.')
  })

  test('an empty reason is rejected', () => {
    const result = validateUnlockReason('')
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.error, /reason/i)
  })

  test('whitespace alone is not a reason — spaces, tabs and newlines', () => {
    for (const blank of ['   ', '\t', '\n', ' \t\n ']) {
      const result = validateUnlockReason(blank)
      assert.equal(result.ok, false, `${JSON.stringify(blank)} must be rejected`)
    }
  })

  test('a missing or non-string reason is rejected, not coerced', () => {
    for (const value of [undefined, null, 42, {}, ['a reason']]) {
      const result = validateUnlockReason(value)
      assert.equal(result.ok, false, `${JSON.stringify(value)} must be rejected`)
    }
  })

  test('a reason longer than the column allows is rejected', () => {
    const result = validateUnlockReason('x'.repeat(UNLOCK_REASON_MAX_LENGTH + 1))
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.error, new RegExp(String(UNLOCK_REASON_MAX_LENGTH)))
  })

  test('a reason of exactly the maximum length is accepted', () => {
    const result = validateUnlockReason('x'.repeat(UNLOCK_REASON_MAX_LENGTH))
    assert.equal(result.ok, true)
  })

  test('length is measured after trimming, so padding never fails a valid reason', () => {
    const result = validateUnlockReason(`   ${'x'.repeat(UNLOCK_REASON_MAX_LENGTH)}   `)
    assert.equal(result.ok, true)
  })
})
