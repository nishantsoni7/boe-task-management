/**
 * 20270331000000 — an admin may delete a Confirmed Payment entered by mistake.
 *
 * Owner decision 2026-10-21, lifting the permanence rule of 20261218000000 for
 * active admins only. A payment actively linked to a bank statement line is
 * refused until it is unlinked in Bank Statements; links already undone are
 * cleared with the payment.
 *
 * The behaviour is EXECUTED by supabase/tests/run_admin_delete_confirmed_payment_suite.sh
 * (the old behaviour reproduces first, then 8 sections pass). This file pins the
 * migration source, the error mapping and the dialog copy.
 *
 * Run:
 *   npx tsx --test src/lib/finance/adminDeleteConfirmedPayment.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  PAYMENT_DELETE_CONFIRMED_WARNING,
  canDeletePayment,
} from './paymentDeletion'
import {
  classifyPaymentDeletionError,
  describePaymentDeletionFailure,
} from './paymentDeletionProtocol'

const FILE = '20270331000000_finance_admin_may_delete_confirmed_payment.sql'
const sql = readFileSync(join('supabase', 'migrations', FILE), 'utf8').replace(/\r\n/g, '\n')
const code = sql.replace(/--[^\n]*/g, '')

describe('who is offered Delete', () => {
  test('an admin, on every status and whatever the test-data flag; nobody else', () => {
    for (const status of ['pending_approval', 'needs_clarification', 'rejected', 'approved_unlinked', 'approved_linked']) {
      for (const is_test_data of [true, false, null, undefined]) {
        assert.equal(canDeletePayment({ status, is_test_data }, { isAdmin: true }), true, `${status}/${is_test_data}`)
        assert.equal(canDeletePayment({ status, is_test_data }, { isAdmin: false }), false, `${status}/${is_test_data}`)
      }
    }
  })
})

describe('a bank-linked payment is refused, in words', () => {
  test('the database marker maps to BANK_LINKED and is not retryable', () => {
    const code = classifyPaymentDeletionError({ message: 'PAYMENT_DELETION_BANK_LINKED: payment P-AA-0040 is linked' })
    assert.equal(code, 'BANK_LINKED')
    const failure = describePaymentDeletionFailure(code)
    assert.equal(failure.retryable, false)
    assert.ok(failure.message.includes('Bank Statements'))
  })

  test('the route answers 409 for it', () => {
    const route = readFileSync(join('src', 'app', 'api', 'finance', 'payments', 'delete', 'route.ts'), 'utf8')
    assert.ok(route.includes('BANK_LINKED: 409'))
  })
})

describe('the dialog tells an admin what deleting a Confirmed Payment means', () => {
  test('the warning is shown for a Confirmed Payment', () => {
    const modal = readFileSync(join('src', 'components', 'finance', 'DeletePaymentModal.tsx'), 'utf8')
    assert.ok(/isConfirmed && \([\s\S]{0,600}PAYMENT_DELETE_CONFIRMED_WARNING/.test(modal))
    assert.ok(PAYMENT_DELETE_CONFIRMED_WARNING.includes('mistake'))
    assert.ok(PAYMENT_DELETE_CONFIRMED_WARNING.includes('advance rule'))
  })
})

describe('20270331000000 — the database', () => {
  test('forward-only, a unique version, after 20270330000000', () => {
    const files = readdirSync(join('supabase', 'migrations')).filter(f => /^\d{14}_/.test(f)).sort()
    const i = files.indexOf(FILE)
    assert.ok(i > 0)
    assert.equal(files.filter(f => f.startsWith(FILE.slice(0, 14))).length, 1)
    assert.ok(files[i - 1] < FILE)
    assert.ok(files[i - 1] >= '20270330000000')
  })

  test('the claim gate and the DELETE trigger no longer ask for test data, and stay admin / protocol only', () => {
    const deletable = sql.slice(sql.indexOf('function public.finance_payment_deletable_by('), sql.indexOf('function public.finance_payment_requests_guard_approved_delete('))
    const guard = sql.slice(sql.indexOf('function public.finance_payment_requests_guard_approved_delete('), sql.indexOf('function public.begin_finance_payment_deletion('))
    assert.ok(!/is_test_data/.test(deletable.replace(/--[^\n]*/g, '')))
    assert.ok(deletable.includes("u.role = 'admin'") && deletable.includes('u.is_active'))
    assert.ok(!/finance_payment_status_is_verified\(f\.status\)/.test(deletable.replace(/--[^\n]*/g, '')))
    assert.ok(guard.includes('in_test_data_cleanup()'))
    assert.ok(guard.includes("old.status in ('approved_unlinked', 'approved_linked')\n     and public.in_finance_payment_deletion_finalization(old.id)"))
    assert.ok(guard.includes('PAYMENT_APPROVED_PERMANENT'), 'every other caller is still refused')
    assert.ok(!/u\.role = 'admin'/.test(guard), 'no blanket admin exemption in the trigger')
  })

  test('begin and finalize both refuse an active bank link; finalize clears only the undone notes', () => {
    const begin = sql.slice(sql.indexOf('function public.begin_finance_payment_deletion('), sql.indexOf('function public.finalize_finance_payment_deletion('))
    const fin = sql.slice(sql.indexOf('function public.finalize_finance_payment_deletion('))
    for (const body of [begin, fin]) {
      assert.ok(body.includes('PAYMENT_DELETION_BANK_LINKED'))
      assert.ok(/l\.payment_id = p_payment_id and l\.unlinked_at is null/.test(body))
    }
    assert.ok(/delete from public\.bank_line_payment_links\n\s+where payment_id = p_payment_id and unlinked_at is not null;/.test(fin))
    assert.ok(begin.indexOf('PAYMENT_DELETION_BANK_LINKED') < begin.indexOf('insert into public.finance_payment_deletion_claims'),
      'refused before any claim is taken')
    assert.ok(begin.includes('PAYMENT_DELETION_REASON_REQUIRED') && begin.includes('PAYMENT_DELETION_ID_MISMATCH'))
    assert.ok(fin.includes('PAYMENT_DELETION_PROOF_PENDING') && fin.includes("set_config('boe.payment_deletion_finalize'"))
  })

  test('it changes nothing else, and proves itself at apply time', () => {
    assert.ok(!/\b(create|alter|drop)\s+(table|policy|trigger|index)\b/i.test(code))
    assert.ok(!/\binsert\s+into\s+public\.(?!finance_payment_deletion_claims)/i.test(code))
    for (const needle of ['DEPENDENCY MISSING', 'ASSERTION FAILED: finance_payment_deletable_by is not admin-only-any-status',
      'ASSERTION FAILED: the delete guard lost a rule or kept the test-data condition',
      'ASSERTION FAILED: begin_finance_payment_deletion lost a rule',
      'ASSERTION FAILED: finalize_finance_payment_deletion lost a rule',
      'ASSERTION FAILED: anon may execute a deletion function', 'is not bound']) {
      assert.ok(sql.includes(needle), needle)
    }
    assert.ok(/revoke execute on function public\.begin_finance_payment_deletion\(uuid, text, text\) from public, anon;/.test(sql))
    assert.ok(/revoke execute on function public\.finalize_finance_payment_deletion\(uuid, uuid\) from public, anon;/.test(sql))
  })

  test('both functions keep a fixed search_path and stay SECURITY DEFINER', () => {
    for (const name of ['begin_finance_payment_deletion', 'finalize_finance_payment_deletion',
      'finance_payment_deletable_by', 'finance_payment_requests_guard_approved_delete']) {
      const from = sql.indexOf(`function public.${name}(`)
      const body = sql.slice(from, sql.indexOf('\n$$;', from))
      assert.ok(body.includes('security definer') && body.includes('set search_path = public, pg_temp'), name)
    }
  })

  test('an executable suite proves it on a disposable database', () => {
    const runner = readFileSync(join('supabase', 'tests', 'run_admin_delete_confirmed_payment_suite.sh'), 'utf8')
    assert.ok(runner.includes('never talks to a linked project'))
    assert.ok(runner.includes('FAIL: the old behaviour did not reproduce'))
    const suite = readFileSync(join('supabase', 'tests', 'admin_delete_confirmed_payment_assertions.sql'), 'utf8')
    for (const needle of ['1. deletable_by', '2. a real verified payment is deleted', '3. non-admin, blank reason',
      '4. actively bank-linked', '5. a link made after begin', '6. a direct DELETE', '7. an already-unlinked',
      '8. a pending payment']) {
      assert.ok(suite.includes(needle), needle)
    }
  })
})
