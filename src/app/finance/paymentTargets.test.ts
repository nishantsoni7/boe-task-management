import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_TARGET_STATE,
  PAYMENT_TARGET_LABEL,
  PAYMENT_TARGET_OPTIONS,
  PAYMENT_TARGET_TYPES,
  SELECTABLE_PAYMENT_TARGET_TYPES,
  buildTargetPayload,
  confirmedOrderResultLabel,
  isPaymentTargetType,
  isSelectablePaymentTarget,
  isTargetComplete,
  paymentAgainstFor,
  paymentTargetErrorMessage,
  readTargetType,
  switchTarget,
  targetClientName,
  targetTypeOf,
  type ConfirmedOrderOption,
  type PaymentTargetState,
} from './paymentTargets'

const ORDER: ConfirmedOrderOption = {
  id: 'order-1',
  display_number: '0020',
  client_name: 'Mehta Textiles',
  status: 'running',
  total_value: 900000,
}

const state = (over: Partial<PaymentTargetState> = {}): PaymentTargetState => ({
  ...EMPTY_TARGET_STATE,
  ...over,
})

// ── The vocabulary, and what a form may choose from it ────────────────────────

test('the stored vocabulary still has three values, so historical rows still name themselves', () => {
  // 'order_request' is RETIRED, not deleted. Payments submitted against an Order
  // Request before the retirement still carry it, and a screen that could not
  // name the value would print a blank where a historical fact belongs.
  assert.deepEqual([...PAYMENT_TARGET_TYPES], ['unallocated', 'order_request', 'confirmed_order'])
  assert.equal(PAYMENT_TARGET_LABEL.order_request, 'Order Request')
  assert.equal(isPaymentTargetType('order_request'), true)
})

test('a form may choose only two of them, and Order Request is not one', () => {
  assert.deepEqual([...SELECTABLE_PAYMENT_TARGET_TYPES], ['unallocated', 'confirmed_order'])
  assert.equal(isSelectablePaymentTarget('order_request'), false)
  assert.equal(PAYMENT_TARGET_OPTIONS.length, 2)
  assert.deepEqual(PAYMENT_TARGET_OPTIONS.map(o => o.label), ['New Order', 'Confirmed Order'])
  // Every option is a real stored target, and none of them is the retired one.
  for (const o of PAYMENT_TARGET_OPTIONS) {
    assert.equal(isPaymentTargetType(o.value), true)
    assert.notEqual(o.value, 'order_request')
  }
})

test('no card offers the retired workflow, in its label or its description', () => {
  const copy = JSON.stringify(PAYMENT_TARGET_OPTIONS).toLowerCase()
  assert.equal(copy.includes('order request'), false)
  assert.equal(copy.includes('order_request'), false)
})

test('an unknown target string is rejected', () => {
  assert.equal(isPaymentTargetType('existing_order'), false)
  assert.equal(isPaymentTargetType(''), false)
  assert.equal(isSelectablePaymentTarget(''), false)
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

// ── 1. New Order submission stores no linkage ─────────────────────────────────

test('New Order submits a manual client name and no linkage at all', () => {
  const payload = buildTargetPayload(state({ target: 'unallocated', manualClientName: '  Raj Enterprises  ' }))
  assert.equal(payload.client_name, 'Raj Enterprises')
  assert.equal(payload.payment_against, 'new_order')
  assert.equal(payload.order_id, null)
  assert.equal(payload.order_number, null)
  assert.equal(payload.order_request_id, null)
  assert.equal(payload.order_request_number, null)
})

// ── 2. No reachable form state can produce a request linkage ──────────────────

test('no payload this form can build ever names an Order Request', () => {
  for (const target of SELECTABLE_PAYMENT_TARGET_TYPES) {
    const payload = buildTargetPayload(state({
      target,
      manualClientName: 'Typed Client',
      selectedOrder: ORDER,
    }))
    assert.equal(payload.order_request_id, null, `${target} produced a retired linkage`)
    assert.equal(payload.order_request_number, null)
  }
})

test('client name for a linked target comes from the selected record, never the typed field', () => {
  const o = state({
    target: 'confirmed_order',
    selectedOrder: ORDER,
    manualClientName: 'Something Else Entirely',
  })
  assert.equal(targetClientName(o), 'Mehta Textiles')
  assert.equal(buildTargetPayload(o).client_name, 'Mehta Textiles')
})

// ── 3. Confirmed Order submission stores only confirmed-order linkage ─────────

test('Confirmed Order submits the order id and its number, and no request linkage', () => {
  const payload = buildTargetPayload(state({ target: 'confirmed_order', selectedOrder: ORDER }))
  assert.equal(payload.order_id, 'order-1')
  assert.equal(payload.order_number, '0020')
  assert.equal(payload.order_request_id, null)
  assert.equal(payload.order_request_number, null)
  assert.equal(payload.payment_against, 'existing_order')
})

// ── 4. Both link targets can never coexist ────────────────────────────────────

test('no reachable form state produces both an order_id and an order_request_id', () => {
  for (const target of SELECTABLE_PAYMENT_TARGET_TYPES) {
    const payload = buildTargetPayload(state({
      target,
      manualClientName: 'Typed Client',
      selectedOrder: ORDER,
    }))
    assert.equal(
      Number(payload.order_id !== null) + Number(payload.order_request_id !== null) <= 1,
      true,
      `${target} produced both link targets`,
    )
  }
})

test('every payload always carries both linkage keys, so an update clears the old target', () => {
  // THE RETIRED KEYS ARE STILL SENT, and must be. Spreading this over an UPDATE
  // is how a historical request-linked payment gets its retired linkage cleared
  // and becomes allocatable to a real Order or PI Draft. An omitted key would
  // leave it behind forever.
  for (const target of SELECTABLE_PAYMENT_TARGET_TYPES) {
    const payload = buildTargetPayload(state({ target, selectedOrder: ORDER, manualClientName: 'X' }))
    for (const key of ['order_id', 'order_number', 'order_request_id', 'order_request_number']) {
      assert.equal(key in payload, true, `${target} payload is missing ${key}`)
    }
  }
})

// ── 5. Switching target type clears incompatible fields ───────────────────────

test('switching away from Confirmed Order clears the selected order and its number', () => {
  const before = state({ target: 'confirmed_order', selectedOrder: ORDER })
  const after  = switchTarget(before, 'unallocated')
  assert.equal(after.selectedOrder, null)
  const payload = buildTargetPayload(after)
  assert.equal(payload.order_id, null)
  assert.equal(payload.order_number, null)
})

test('switching to New Order clears the typed client name too', () => {
  // The name belonged to the record that was selected, not to the person typing.
  const before = state({ target: 'confirmed_order', selectedOrder: ORDER })
  const after  = switchTarget(before, 'unallocated')
  assert.equal(after.manualClientName, '')
  assert.equal(targetClientName(after), '')
})

test('every switch leaves no selection standing', () => {
  const populated = state({
    target: 'unallocated',
    manualClientName: 'Typed Client',
    selectedOrder: ORDER,
  })
  for (const to of SELECTABLE_PAYMENT_TARGET_TYPES) {
    for (const from of SELECTABLE_PAYMENT_TARGET_TYPES) {
      if (from === to) continue
      const after = switchTarget({ ...populated, target: from }, to)
      assert.equal(after.target, to)
      assert.equal(after.selectedOrder, null)
    }
  }
})

test('re-selecting the target already active never discards a selection', () => {
  const before = state({ target: 'confirmed_order', selectedOrder: ORDER })
  assert.equal(switchTarget(before, 'confirmed_order'), before)
})

// ── Completeness gate ─────────────────────────────────────────────────────────

test('a linked target is incomplete until its record is selected', () => {
  assert.equal(isTargetComplete(state({ target: 'confirmed_order' })), false)
  assert.equal(isTargetComplete(state({ target: 'confirmed_order', selectedOrder: ORDER })), true)
})

test('New Order is incomplete until a client name is typed', () => {
  assert.equal(isTargetComplete(state({ target: 'unallocated' })), false)
  assert.equal(isTargetComplete(state({ target: 'unallocated', manualClientName: '   ' })), false)
  assert.equal(isTargetComplete(state({ target: 'unallocated', manualClientName: 'Raj' })), true)
})

test('a selected record with no client name on file is incomplete, not silently blank', () => {
  const namelessOrder = { ...ORDER, client_name: '' }
  assert.equal(isTargetComplete(state({ target: 'confirmed_order', selectedOrder: namelessOrder })), false)
})

// ── Result display ────────────────────────────────────────────────────────────

test('search results name the kind of record before its number', () => {
  assert.equal(confirmedOrderResultLabel(ORDER), 'Confirmed Order · 0020 · Mehta Textiles')
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
