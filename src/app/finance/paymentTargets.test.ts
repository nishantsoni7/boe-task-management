import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_TARGET_STATE,
  ORDER_REQUEST_SELECTABLE_STATUSES,
  PAYMENT_TARGET_OPTIONS,
  PAYMENT_TARGET_TYPES,
  buildTargetPayload,
  confirmedOrderResultLabel,
  isPaymentTargetType,
  isSelectableOrderRequest,
  isTargetComplete,
  orderRequestResultLabel,
  paymentAgainstFor,
  paymentTargetErrorMessage,
  readTargetType,
  switchTarget,
  targetClientName,
  targetTypeOf,
  type ConfirmedOrderOption,
  type OrderRequestOption,
  type PaymentTargetState,
} from './paymentTargets'

const REQUEST: OrderRequestOption = {
  id: 'req-1',
  request_number: 'ORD-REQ-2026-0011',
  client_name: 'Raj Enterprises',
  status: 'submitted',
  total_value: 3300000,
}

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

// ── The three targets ─────────────────────────────────────────────────────────

test('there are exactly three targets, and Order Request is not folded into Confirmed Order', () => {
  assert.deepEqual([...PAYMENT_TARGET_TYPES], ['unallocated', 'order_request', 'confirmed_order'])
  assert.equal(PAYMENT_TARGET_OPTIONS.length, 3)
  assert.deepEqual(
    PAYMENT_TARGET_OPTIONS.map(o => o.label),
    ['New Order', 'Order Request', 'Confirmed Order'],
  )
  // Every option is a real target, and every target has an option.
  for (const o of PAYMENT_TARGET_OPTIONS) assert.equal(isPaymentTargetType(o.value), true)
  assert.equal(new Set(PAYMENT_TARGET_OPTIONS.map(o => o.value)).size, PAYMENT_TARGET_TYPES.length)
})

test('an unknown target string is rejected', () => {
  assert.equal(isPaymentTargetType('existing_order'), false)
  assert.equal(isPaymentTargetType(''), false)
})

// ── Origin flag derivation (must match the migration's trigger) ───────────────

test('both unlinked targets are new_order origin; only Confirmed Order is existing_order', () => {
  assert.equal(paymentAgainstFor('unallocated'), 'new_order')
  assert.equal(paymentAgainstFor('order_request'), 'new_order')
  assert.equal(paymentAgainstFor('confirmed_order'), 'existing_order')
})

test('reading a row back agrees with the origin flag it was written from', () => {
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
  // Same row without the column selected falls back to the derived value.
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

// ── 2. Order Request submission stores only request linkage ───────────────────

test('Order Request submits the request id only, and never a Confirmed Order', () => {
  const payload = buildTargetPayload(state({ target: 'order_request', selectedRequest: REQUEST }))
  assert.equal(payload.order_request_id, 'req-1')
  assert.equal(payload.order_id, null)
  assert.equal(payload.order_number, null)
  assert.equal(payload.payment_against, 'new_order')
})

// ── 9. Request number and client name are derived server-side ─────────────────

test('the Order Request number is NOT sent — the database derives it', () => {
  const payload = buildTargetPayload(state({ target: 'order_request', selectedRequest: REQUEST }))
  assert.equal(payload.order_request_number, null)
  // ...even though the client plainly knows it, which is the point.
  assert.equal(REQUEST.request_number, 'ORD-REQ-2026-0011')
})

test('client name for a linked target comes from the selected record, never the typed field', () => {
  const s = state({
    target: 'order_request',
    selectedRequest: REQUEST,
    manualClientName: 'Something Else Entirely',
  })
  assert.equal(targetClientName(s), 'Raj Enterprises')
  assert.equal(buildTargetPayload(s).client_name, 'Raj Enterprises')

  const o = state({
    target: 'confirmed_order',
    selectedOrder: ORDER,
    manualClientName: 'Something Else Entirely',
  })
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
  // Every combination of target and both selections being present — including
  // the states a stale render could produce.
  for (const target of PAYMENT_TARGET_TYPES) {
    const payload = buildTargetPayload(state({
      target,
      manualClientName: 'Typed Client',
      selectedRequest: REQUEST,
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
  for (const target of PAYMENT_TARGET_TYPES) {
    const payload = buildTargetPayload(state({ target, selectedRequest: REQUEST, selectedOrder: ORDER, manualClientName: 'X' }))
    for (const key of ['order_id', 'order_number', 'order_request_id', 'order_request_number']) {
      assert.equal(key in payload, true, `${target} payload is missing ${key}`)
    }
  }
})

// ── 5. Switching target type clears incompatible fields ───────────────────────

test('switching away from Order Request clears the selected request', () => {
  const before = state({ target: 'order_request', selectedRequest: REQUEST })
  const after  = switchTarget(before, 'confirmed_order')
  assert.equal(after.selectedRequest, null)
  assert.equal(after.selectedOrder, null)
  assert.equal(after.manualClientName, '')
  assert.equal(buildTargetPayload(after).order_request_id, null)
})

test('switching away from Confirmed Order clears the selected order and its number', () => {
  const before = state({ target: 'confirmed_order', selectedOrder: ORDER })
  const after  = switchTarget(before, 'order_request')
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

test('every switch between the three targets leaves at most one selection standing', () => {
  const populated = state({
    target: 'unallocated',
    manualClientName: 'Typed Client',
    selectedRequest: REQUEST,
    selectedOrder: ORDER,
  })
  for (const to of PAYMENT_TARGET_TYPES) {
    for (const from of PAYMENT_TARGET_TYPES) {
      if (from === to) continue
      const after = switchTarget({ ...populated, target: from }, to)
      assert.equal(after.target, to)
      assert.equal(after.selectedRequest, null)
      assert.equal(after.selectedOrder, null)
    }
  }
})

test('re-selecting the target already active never discards a selection', () => {
  const before = state({ target: 'order_request', selectedRequest: REQUEST })
  assert.equal(switchTarget(before, 'order_request'), before)
})

// ── Completeness gate ─────────────────────────────────────────────────────────

test('a linked target is incomplete until its record is selected', () => {
  assert.equal(isTargetComplete(state({ target: 'order_request' })), false)
  assert.equal(isTargetComplete(state({ target: 'order_request', selectedRequest: REQUEST })), true)
  assert.equal(isTargetComplete(state({ target: 'confirmed_order' })), false)
  assert.equal(isTargetComplete(state({ target: 'confirmed_order', selectedOrder: ORDER })), true)
})

test('New Order is incomplete until a client name is typed', () => {
  assert.equal(isTargetComplete(state({ target: 'unallocated' })), false)
  assert.equal(isTargetComplete(state({ target: 'unallocated', manualClientName: '   ' })), false)
  assert.equal(isTargetComplete(state({ target: 'unallocated', manualClientName: 'Raj' })), true)
})

test('a selected record with no client name on file is incomplete, not silently blank', () => {
  const nameless = { ...REQUEST, client_name: '   ' }
  assert.equal(isTargetComplete(state({ target: 'order_request', selectedRequest: nameless })), false)
  const namelessOrder = { ...ORDER, client_name: '' }
  assert.equal(isTargetComplete(state({ target: 'confirmed_order', selectedOrder: namelessOrder })), false)
})

// ── 8. Rejected or invalid Order Request selection is rejected ────────────────

test('only an active Order Request may be selected for a new payment', () => {
  assert.deepEqual([...ORDER_REQUEST_SELECTABLE_STATUSES], ['submitted', 'needs_clarification'])
  assert.equal(isSelectableOrderRequest({ status: 'submitted' }), true)
  assert.equal(isSelectableOrderRequest({ status: 'needs_clarification' }), true)
  assert.equal(isSelectableOrderRequest({ status: 'rejected' }), false)
  assert.equal(isSelectableOrderRequest({ status: 'converted' }), false)
})

// ── Result display ────────────────────────────────────────────────────────────

test('search results name the kind of record before its number', () => {
  assert.equal(orderRequestResultLabel(REQUEST), 'Order Request · ORD-REQ-2026-0011 · Raj Enterprises')
  assert.equal(confirmedOrderResultLabel(ORDER), 'Confirmed Order · 0020 · Mehta Textiles')
})

// ── Failure messages ──────────────────────────────────────────────────────────

test('each server-side target rule maps to its own sentence', () => {
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
