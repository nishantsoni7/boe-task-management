import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PAYMENT_TARGET_LABEL,
  PAYMENT_TARGET_TYPES,
  isPaymentTargetType,
  paymentAgainstFor,
  paymentTargetErrorMessage,
  readTargetType,
  targetTypeOf,
} from './paymentTargets'

// WHAT IS NO LONGER TESTED HERE, AND WHY. This module used to hold the FORM
// STATE for a two-card target selector — switchTarget, buildTargetPayload,
// isTargetComplete, targetClientName and the option list — with a test each.
// Since 20261013000000 no form chooses a target from here: both payment-entry
// forms ask one question from one list (src/lib/finance/paymentEntry.ts, tested
// in src/lib/finance/paymentEntry.test.ts) and a Payment Request's destination
// is recorded as an allocation intent. The selector and its state are deleted
// rather than left behind, so their tests go with them.
//
// WHAT REMAINS IS THE READING HALF: a stored value that historical rows still
// carry, and the sentences its server-side refusals become.

// ── The stored vocabulary ─────────────────────────────────────────────────────

test('the stored vocabulary still has three values, so historical rows still name themselves', () => {
  // 'order_request' is RETIRED, not deleted. Payments submitted against an Order
  // Request before the retirement still carry it, and a screen that could not
  // name the value would print a blank where a historical fact belongs.
  assert.deepEqual([...PAYMENT_TARGET_TYPES], ['unallocated', 'order_request', 'confirmed_order'])
  assert.equal(PAYMENT_TARGET_LABEL.order_request, 'Order Request')
  assert.equal(isPaymentTargetType('order_request'), true)
})

test('an unknown target string is rejected', () => {
  assert.equal(isPaymentTargetType('existing_order'), false)
  assert.equal(isPaymentTargetType(''), false)
})

// ── Origin flag derivation (must match the migration's trigger) ───────────────

test('anything that is not a Confirmed Order is new_order origin', () => {
  assert.equal(paymentAgainstFor('unallocated'), 'new_order')
  assert.equal(paymentAgainstFor('order_request'), 'new_order')
  assert.equal(paymentAgainstFor('confirmed_order'), 'existing_order')
})

test('reading a HISTORICAL row back agrees with the origin flag it was written from', () => {
  for (const target of PAYMENT_TARGET_TYPES) {
    const row = {
      payment_against: paymentAgainstFor(target),
      order_request_id: target === 'order_request' ? 'req-1' : null,
    }
    assert.equal(targetTypeOf(row), target, `round trip failed for ${target}`)
  }
})

test('the stored column wins over derivation, and derivation covers a row without it', () => {
  // A converted request-targeted payment: order_request_id has been cleared by
  // the transfer, so only the stored column still records where it came from.
  assert.equal(
    readTargetType({ payment_target_type: 'order_request', payment_against: 'new_order', order_request_id: null }),
    'order_request',
  )
  assert.equal(
    readTargetType({ payment_against: 'new_order', order_request_id: null }),
    'unallocated',
  )
  // A junk stored value is ignored rather than rendered.
  assert.equal(
    readTargetType({ payment_target_type: 'nonsense', payment_against: 'existing_order', order_request_id: null }),
    'confirmed_order',
  )
})

// ── Failure messages ──────────────────────────────────────────────────────────

test('the retirement refusal is explained, and says what to do instead', () => {
  const msg = paymentTargetErrorMessage(
    'ORDER_REQUESTS_RETIRED: a payment can no longer be attached to an Order Request.',
  ) as string
  assert.ok(msg)
  assert.match(msg, /retired/i)
  // The two things a caller can actually do next.
  assert.match(msg, /Confirmed Order/i)
  assert.match(msg, /PI Draft/i)
})

test('each server-side target rule maps to its own sentence', () => {
  // The pre-retirement rules stay mapped: derive_target still runs, still raises
  // them, and a caller reaching a retired record deserves the specific reason
  // rather than a generic failure.
  const cases: [string, RegExp][] = [
    ['ORDER_REQUEST_NOT_PERMITTED: You cannot attach…', /another salesperson/i],
    ['ORDER_REQUEST_CONVERTED: Order Request X has already…', /already been converted/i],
    ['ORDER_REQUEST_NOT_ACTIVE: Order Request X is rejected…', /no longer open/i],
    ['ORDER_REQUEST_NOT_AVAILABLE: …', /no longer available/i],
    ['ORDER_REQUEST_NO_CLIENT: …', /no client name/i],
    ['PAYMENT_TARGET_CHANGED: …', /re-targeted/i],
  ]
  const seen = new Set<string>()
  for (const [raw, pattern] of cases) {
    const msg = paymentTargetErrorMessage(raw)
    assert.ok(msg, `no message for ${raw}`)
    assert.match(msg as string, pattern)
    assert.equal(seen.has(msg as string), false, 'two rules share one sentence')
    seen.add(msg as string)
  }
})

test('the mutual-exclusivity constraint is explained in business terms', () => {
  const msg = paymentTargetErrorMessage(
    'new row for relation "finance_payment_requests" violates check constraint "finance_payment_requests_one_link_target"',
  )
  assert.match(msg as string, /never both/i)
})

test('an unrelated failure is not claimed as a target failure', () => {
  assert.equal(paymentTargetErrorMessage('duplicate key value violates unique constraint'), null)
  assert.equal(paymentTargetErrorMessage(''), null)
  assert.equal(paymentTargetErrorMessage(null), null)
  assert.equal(paymentTargetErrorMessage(undefined), null)
})

// ── No raw internals reach the reader ─────────────────────────────────────────

test('no target message leaks a SQLSTATE, a constraint name, or a column name', () => {
  const raws = [
    'ORDER_REQUESTS_RETIRED: x',
    'ORDER_REQUEST_NOT_PERMITTED: x', 'ORDER_REQUEST_CONVERTED: x', 'ORDER_REQUEST_NOT_ACTIVE: x',
    'ORDER_REQUEST_NOT_AVAILABLE: x', 'ORDER_REQUEST_NO_CLIENT: x', 'PAYMENT_TARGET_CHANGED: x',
    'violates check constraint "finance_payment_requests_one_link_target"',
    'violates check constraint "finance_payment_requests_request_link_invariant"',
  ]
  for (const raw of raws) {
    const msg = paymentTargetErrorMessage(raw) as string
    assert.doesNotMatch(msg, /order_request_id|payment_target_type|finance_payment_requests|42501|P0001|_/)
  }
})
