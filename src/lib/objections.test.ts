/**
 * Objection rules — the parts that need no database.
 *
 * The validator mirrors the table's own CHECK constraints, so these tests are
 * also the statement of what the constraints mean: exactly one target, a reason
 * that survives trimming, and a snapshot the browser never gets to write.
 *
 * Run:
 *   npx tsx --test src/lib/objections.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateObjectionInput,
  attendanceSnapshot,
  payrollSnapshot,
  employeeStatusLabel,
  isObjectionStatus,
  isReviewableStatus,
  REASON_MAX_LENGTH,
} from './objections'

describe('validateObjectionInput — exactly one target', () => {
  test('an attendance date alone is valid', () => {
    const r = validateObjectionInput({ attendance_date: '2026-07-20', reason: 'I was present' })
    assert.equal(r.ok, true)
    assert.deepEqual(r.ok && r.target, { kind: 'attendance', attendanceDate: '2026-07-20' })
  })

  test('a payroll result alone is valid', () => {
    const r = validateObjectionInput({ payroll_result_id: 'res-1', reason: 'net looks low' })
    assert.equal(r.ok, true)
    assert.deepEqual(r.ok && r.target, { kind: 'payroll', payrollResultId: 'res-1' })
  })

  test('both targets is rejected — the table constraint would reject it too', () => {
    const r = validateObjectionInput({
      attendance_date: '2026-07-20', payroll_result_id: 'res-1', reason: 'x',
    })
    assert.equal(r.ok, false)
  })

  test('neither target is rejected', () => {
    assert.equal(validateObjectionInput({ reason: 'x' }).ok, false)
  })

  test('a malformed date is rejected before it reaches the database', () => {
    assert.equal(validateObjectionInput({ attendance_date: '20-07-2026', reason: 'x' }).ok, false)
    assert.equal(validateObjectionInput({ attendance_date: 'yesterday', reason: 'x' }).ok, false)
  })

  test('non-string targets cannot smuggle a value through', () => {
    assert.equal(validateObjectionInput({ attendance_date: { toString: () => '2026-07-20' }, reason: 'x' }).ok, false)
    assert.equal(validateObjectionInput({ payroll_result_id: 123, reason: 'x' }).ok, false)
  })
})

describe('validateObjectionInput — the reason', () => {
  test('an empty or whitespace reason is rejected', () => {
    for (const reason of ['', '   ', '\t\n', undefined, null, 42]) {
      assert.equal(
        validateObjectionInput({ attendance_date: '2026-07-20', reason }).ok, false,
        `reason ${JSON.stringify(reason)} must not pass`,
      )
    }
  })

  test('the reason is trimmed, so padding cannot fake content', () => {
    const r = validateObjectionInput({ attendance_date: '2026-07-20', reason: '  punch missing  ' })
    assert.equal(r.ok && r.reason, 'punch missing')
  })

  test('an over-long reason is rejected', () => {
    const r = validateObjectionInput({
      attendance_date: '2026-07-20', reason: 'a'.repeat(REASON_MAX_LENGTH + 1),
    })
    assert.equal(r.ok, false)
  })

  test('a reason exactly at the limit is accepted', () => {
    const r = validateObjectionInput({
      attendance_date: '2026-07-20', reason: 'a'.repeat(REASON_MAX_LENGTH),
    })
    assert.equal(r.ok, true)
  })
})

describe('status vocabulary', () => {
  test('only the three statuses are statuses', () => {
    for (const s of ['pending', 'approved', 'rejected']) assert.equal(isObjectionStatus(s), true)
    for (const s of ['resolved', 'PENDING', '', null, 1]) assert.equal(isObjectionStatus(s), false)
  })

  test('only approved and rejected are reviewable — an admin cannot set pending', () => {
    assert.equal(isReviewableStatus('approved'), true)
    assert.equal(isReviewableStatus('rejected'), true)
    assert.equal(isReviewableStatus('pending'), false)
  })

  test('approved reads as Resolved to the employee', () => {
    assert.equal(employeeStatusLabel('pending'),  'Issue Pending')
    assert.equal(employeeStatusLabel('approved'), 'Resolved')
    assert.equal(employeeStatusLabel('rejected'), 'Rejected')
  })
})

describe('snapshots describe, they do not compute', () => {
  const clock = (s: string) => s.slice(11, 16)

  test('an attendance snapshot names the punches as they stand', () => {
    const s = attendanceSnapshot({
      attendance_date: '2026-07-20',
      check_in_at:  '2026-07-20T20:50:00Z',
      check_out_at: null,
      effective_status: 'missing_punch',
      clock,
    })
    assert.match(s, /2026-07-20/)
    assert.match(s, /20:50/)
    assert.match(s, /no punch-out/)
    assert.match(s, /missing_punch/)
  })

  test('a day with no punches at all still describes itself', () => {
    const s = attendanceSnapshot({
      attendance_date: '2026-07-21',
      check_in_at: null, check_out_at: null,
      effective_status: 'absent', clock,
    })
    assert.match(s, /no punch-in/)
    assert.match(s, /no punch-out/)
  })

  test('a payroll snapshot carries the three figures the employee saw', () => {
    const s = payrollSnapshot({
      payroll_month: 7, payroll_year: 2026,
      gross_salary: 18000, total_deductions: 2036.2, net_salary: 15963.8,
    })
    assert.match(s, /07\/2026/)
    assert.match(s, /18,000\.00/)
    assert.match(s, /2,036\.20/)
    assert.match(s, /15,963\.80/)
  })

  test('missing figures render as a dash rather than a zero', () => {
    const s = payrollSnapshot({
      payroll_month: null, payroll_year: null,
      gross_salary: null, total_deductions: null, net_salary: null,
    })
    assert.match(s, /period unknown/)
    assert.match(s, /—/)
    assert.equal(/₹0\.00/.test(s), false, 'a missing amount must never read as zero')
  })
})
