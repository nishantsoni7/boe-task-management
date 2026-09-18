/**
 * 20261218000000 — a verified payment is permanent, test data excepted.
 *
 * Owner decision (2026-09-18, go-live): once Finance has verified a payment,
 * nobody — not even an admin — may permanently delete it. Test data is the one
 * exception. Wrong verified payments will be corrected (Void / Refund /
 * Correction), never erased.
 *
 * The behaviour is EXECUTED by supabase/tests/run_verified_payment_permanent_suite.sh
 * (the old behaviour reproduces first, then 6 sections pass). This file pins the
 * UI rule and the migration source.
 *
 * Run:
 *   npx tsx --test src/lib/finance/verifiedPaymentPermanent.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { canDeletePayment } from './paymentDeletion'

const admin = { isAdmin: true }
const staff = { isAdmin: false }

describe('who is offered Delete', () => {
  test('a real verified payment: nobody, not even an admin', () => {
    for (const status of ['approved_unlinked', 'approved_linked']) {
      assert.equal(canDeletePayment({ status, is_test_data: false }, admin), false, status)
      assert.equal(canDeletePayment({ status }, admin), false, `${status}: unknown flag is treated as real`)
      assert.equal(canDeletePayment({ status, is_test_data: null }, admin), false)
    }
  })

  test('a verified TEST payment: an admin, as before', () => {
    assert.equal(canDeletePayment({ status: 'approved_linked', is_test_data: true }, admin), true)
    assert.equal(canDeletePayment({ status: 'approved_linked', is_test_data: true }, staff), false)
  })

  test('unverified payments: unchanged — admin only', () => {
    for (const status of ['pending_approval', 'needs_clarification', 'rejected']) {
      assert.equal(canDeletePayment({ status, is_test_data: false }, admin), true, status)
      assert.equal(canDeletePayment({ status }, staff), false, status)
    }
  })

  test('Confirmed Payments reads the flag with the base-table read it already makes', () => {
    const view = readFileSync(join('src', 'app', 'finance', 'received', 'ReceivedPaymentsView.tsx'), 'utf8')
    assert.ok(view.includes("${LEGACY_CUSTODY_COLUMNS.join(', ')}, is_test_data`"))
    assert.ok(view.includes('is_test_data:             row.is_test_data === true,'))
    assert.ok(/NO_LEGACY_CUSTODY[\s\S]{0,400}?is_test_data: false/.test(view), 'unknown defaults to real')
  })
})

describe('20261218000000 — the database refuses too', () => {
  const FILE = '20261218000000_finance_verified_payments_are_permanent.sql'
  const sql = readFileSync(join('supabase', 'migrations', FILE), 'utf8').replace(/\r\n/g, '\n')

  test('forward-only, after 20261217000000, unique version', () => {
    const files = readdirSync(join('supabase', 'migrations')).filter(f => /^\d{14}_/.test(f)).sort()
    const i = files.indexOf(FILE)
    assert.ok(i > 0)
    assert.equal(files.filter(f => f.startsWith(FILE.slice(0, 14))).length, 1)
    assert.equal(files[i - 1], '20261217000000_order_submission_schedule_terms_use_the_amendment_context.sql')
  })

  test('both layers carry the rule: the claim gate and the DELETE trigger', () => {
    assert.ok(sql.includes('and (not public.finance_payment_status_is_verified(f.status)\n           or coalesce(f.is_test_data, false))'))
    assert.ok(sql.includes("and coalesce(old.is_test_data, false)\n     and public.in_finance_payment_deletion_finalization(old.id)"))
    assert.ok(sql.includes('if public.in_test_data_cleanup() then'), 'the cleanup path is unchanged')
    assert.ok(sql.includes('PAYMENT_APPROVED_PERMANENT'))
  })

  test('it changes nothing else and proves itself at apply time', () => {
    const code = sql.replace(/--[^\n]*/g, '')
    assert.ok(!/\b(create|alter|drop)\s+(table|policy|trigger|index)\b/i.test(code))
    assert.ok(!/\b(grant|revoke)\b/i.test(code), 'no grant changes')
    assert.ok(!/\b(insert\s+into|update\s+public\.|delete\s+from)\b/i.test(code))
    for (const needle of ['ASSERTION FAILED: finance_payment_deletable_by lost a rule',
      'ASSERTION FAILED: the delete guard lost a rule',
      'the finalization exemption does not require test data', 'is not bound', 'DEPENDENCY MISSING']) {
      assert.ok(sql.includes(needle), needle)
    }
  })

  test('an executable suite proves it on a disposable database', () => {
    const runner = readFileSync(join('supabase', 'tests', 'run_verified_payment_permanent_suite.sh'), 'utf8')
    assert.ok(runner.includes('never talks to a linked project'))
    assert.ok(runner.includes('FAIL: the old behaviour did not reproduce'))
    const suite = readFileSync(join('supabase', 'tests', 'verified_payment_permanent_assertions.sql'), 'utf8')
    for (const needle of ['1. deletable_by: real verified NO', '2. finalizing a claim on a real verified payment: refused',
      '3. a direct DELETE', '4. a verified TEST payment is still removable', '5. the Test Data Cleanup context is unchanged',
      '6. pending and rejected payments: deletable as before']) {
      assert.ok(suite.includes(needle), needle)
    }
  })
})
