import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isPaymentCashLockMissing,
  paymentCashLockErrorMessage,
  paymentCashLockMessage,
  readPaymentCashLocks,
} from './paymentCashLock'
import { paymentEntryErrorMessage } from './paymentEntry'
import { describeOwnDeleteFailure } from './ownPaymentRequestDeletion'

const MIGRATION = readFileSync(
  join(process.cwd(), 'supabase/migrations/20270415000000_finance_payment_cash_handover_lock.sql'), 'utf8',
).replace(/\r/g, '')

describe('reading finance_payment_cash_locks', () => {
  test('keeps well-formed rows and drops the rest', () => {
    const locks = readPaymentCashLocks([
      { payment_id: 'a', reason: 'accepted_transfer', handover: 'H-0001' },
      { payment_id: 'b', reason: 'open_handover', handover: 'H-0002' },
      { payment_id: 'c', reason: 'accepted_transfer', handover: null },
      { payment_id: 'd', reason: 'something_else' },
      { reason: 'open_handover' },
      null,
    ])
    assert.deepEqual([...locks.keys()], ['a', 'b', 'c'])
    assert.deepEqual(locks.get('c'), { paymentId: 'c', reason: 'accepted_transfer', handover: null })
  })

  test('anything that is not an array is "nothing locked"', () => {
    assert.equal(readPaymentCashLocks(null).size, 0)
    assert.equal(readPaymentCashLocks({}).size, 0)
  })

  test('a missing function (migration not applied) is recognised', () => {
    assert.equal(isPaymentCashLockMissing({ code: 'PGRST202', message: 'Could not find the function' }), true)
    assert.equal(isPaymentCashLockMissing({ code: '42883', message: 'function does not exist' }), true)
    assert.equal(isPaymentCashLockMissing({ code: '42501', message: 'permission denied' }), false)
    assert.equal(isPaymentCashLockMissing(null), false)
  })
})

describe('the words', () => {
  test('an accepted transfer says it is permanent and names the audited way out', () => {
    const m = paymentCashLockMessage({ reason: 'accepted_transfer', handover: 'H-0001' })
    assert.match(m, /handed over and accepted \(H-0001\)/)
    assert.match(m, /can no longer be edited or deleted/)
    assert.match(m, /administrator can delete it with a reason/)
    assert.doesNotMatch(paymentCashLockMessage({ reason: 'accepted_transfer', handover: null }), /\(\)/)
  })

  test('an open handover names it and says how to release it', () => {
    const m = paymentCashLockMessage({ reason: 'open_handover', handover: 'H-0007' })
    assert.match(m, /cash handover H-0007, which has not been accepted yet/)
    assert.match(m, /cancel the handover first/)
    assert.doesNotMatch(paymentCashLockMessage({ reason: 'open_handover', handover: null }), / {2}|handover ,/)
  })

  test('the database refusal is turned into its own sentence, and nothing else is', () => {
    const raw = 'PAYMENT_LOCKED_BY_CASH_HANDOVER: payment P-AA-0044 was handed over and accepted (H-0001), so it can no longer be edited or deleted.'
    assert.equal(paymentCashLockErrorMessage(raw), 'Payment P-AA-0044 was handed over and accepted (H-0001), so it can no longer be edited or deleted.')
    assert.equal(paymentCashLockErrorMessage('PAYMENT_APPROVED: nope'), null)
    assert.equal(paymentCashLockErrorMessage(undefined), null)
    assert.match(paymentEntryErrorMessage(raw), /^Payment P-AA-0044 was handed over/)
    assert.match(describeOwnDeleteFailure({ message: raw }), /cash handover/)
  })
})

describe('20270415000000 — the lock the screens only describe', () => {
  const trigger = MIGRATION.slice(
    MIGRATION.indexOf('create or replace function public.finance_payment_requests_lock_cash_custody()'),
    MIGRATION.indexOf('revoke all on function public.finance_payment_requests_lock_cash_custody()'),
  )

  test('one trigger meets every UPDATE and DELETE of a payment', () => {
    assert.match(MIGRATION, /create trigger finance_payment_requests_lock_cash_custody\n\s+before update or delete on public\.finance_payment_requests/)
  })

  test('nobody is exempt by role: no admin, permission or service-role pass', () => {
    assert.doesNotMatch(trigger, /actor_has_module_permission|role = 'admin'|auth\.uid\(\)/)
  })

  test('only the audited deletion, Test Data Cleanup and verification markers are honoured', () => {
    assert.match(trigger, /in_finance_payment_deletion_finalization\(old\.id\)/)
    assert.match(trigger, /in_test_data_cleanup\(\)/)
    assert.match(trigger, /in_finance_payment_verification\(old\.id\)/)
    assert.doesNotMatch(trigger, /set_config/)
  })

  test('the whole record is compared, minus the decision and system columns', () => {
    assert.match(trigger, /\(to_jsonb\(new\) - v_allowed\) is not distinct from \(to_jsonb\(old\) - v_allowed\)/)
    for (const editable of ['amount', 'payment_mode', 'payment_date', 'client_name', 'proof_note', 'sales_note', 'deleted_at']) {
      assert.doesNotMatch(trigger.slice(trigger.indexOf('v_allowed text[]'), trigger.indexOf('];')), new RegExp(`'${editable}'`),
        `${editable} must never be in the allowed list`)
    }
  })

  test('open = pending or disputed; accepted = an accepted handover or a direct receipt', () => {
    assert.match(MIGRATION, /h\.status = 'accepted'/)
    assert.match(MIGRATION, /e\.idempotency_key like 'receive:%'/)
    assert.match(MIGRATION, /h\.status in \('pending', 'disputed'\)/)
  })

  test('the lock check is internal; the read door is for signed-in users', () => {
    assert.match(MIGRATION, /revoke all on function public\.finance_payment_cash_lock\(uuid\) from public, anon, authenticated;/)
    assert.match(MIGRATION, /grant execute on function public\.finance_payment_cash_locks\(uuid\[\]\) to authenticated;/)
    assert.match(MIGRATION, /finance_cash_payment_readable\(ids\.x, v_actor\)/)
  })
})
