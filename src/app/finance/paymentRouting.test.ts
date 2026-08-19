import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONFIRMED_PAYMENT_STATUSES,
  LINKED_OR_PREDICATE,
  REQUEST_STAGE_STATUSES,
  applyLinkageScope,
  isConfirmedPayment,
  isRequestStageStatus,
  linkageModeFor,
  resolveLinkedAgainst,
  canVerifyPayment,
} from './paymentRouting'

// Every status finance_payment_requests allows (20260628000200 + the two
// approved states added by 20260688/20260690). Named here so the exhaustiveness
// checks below fail loudly if a sixth is introduced without deciding which page
// owns it.
const ALL_STATUSES = [
  'pending_approval',
  'needs_clarification',
  'rejected',
  'approved_unlinked',
  'approved_linked',
]

// ── Payment Requests scope ────────────────────────────────────────────────────

test('confirmed payments are excluded from the Payment Requests page', () => {
  // The whole point of the correction: once approved, a record is not a request.
  assert.equal(isRequestStageStatus('approved_unlinked'), false)
  assert.equal(isRequestStageStatus('approved_linked'), false)
})

test('request-stage statuses are exactly the three pre-approval states', () => {
  assert.deepEqual([...REQUEST_STAGE_STATUSES], ['pending_approval', 'needs_clarification', 'rejected'])
  for (const s of REQUEST_STAGE_STATUSES) assert.equal(isRequestStageStatus(s), true)
})

test('approved_unlinked is a confirmed payment, not an outstanding request', () => {
  // It used to sit on the Payment Requests page under an "Order No. Pending"
  // tab. That tab is gone; this asserts which side of the boundary it is on.
  assert.equal(isConfirmedPayment('approved_unlinked'), true)
  assert.equal(isConfirmedPayment('approved_linked'), true)
  assert.equal(isConfirmedPayment('pending_approval'), false)
})

test('every status belongs to exactly one page — no record can fall through', () => {
  for (const status of ALL_STATUSES) {
    const request  = isRequestStageStatus(status)
    const confirmed = isConfirmedPayment(status)
    assert.equal(
      Number(request) + Number(confirmed), 1,
      `${status} must belong to exactly one of Payment Requests / Received Payments`,
    )
  }
  assert.equal(REQUEST_STAGE_STATUSES.length + CONFIRMED_PAYMENT_STATUSES.length, ALL_STATUSES.length)
})

test('an unknown status is claimed by neither page', () => {
  assert.equal(isRequestStageStatus('cancelled'), false)
  assert.equal(isConfirmedPayment('cancelled'), false)
})

// ── Received Payments routing ─────────────────────────────────────────────────
// A payment is LINKED when it is attached to either kind of business record. The
// Non-Linked page is the genuinely unallocated queue and nothing else.

// The four possible linkage shapes, named once. `both` cannot occur while
// 20260698's CHECK stands, and is covered anyway so the rule survives it.
type LinkageShape = { order_id: string | null; order_request_id: string | null }

const ORDER_ONLY:   LinkageShape = { order_id: 'order-1', order_request_id: null }
const REQUEST_ONLY: LinkageShape = { order_id: null,      order_request_id: 'req-1' }
const BOTH:         LinkageShape = { order_id: 'order-1', order_request_id: 'req-1' }
const NEITHER:      LinkageShape = { order_id: null,      order_request_id: null }

const ALL_SHAPES: LinkageShape[] = [ORDER_ONLY, REQUEST_ONLY, BOTH, NEITHER]

test('order_id only routes to Linked Payments', () => {
  assert.equal(linkageModeFor(ORDER_ONLY), 'linked')
})

test('order_request_id only routes to Linked Payments', () => {
  // An Order Request linkage IS an allocation — this is the corrected rule.
  assert.equal(linkageModeFor(REQUEST_ONLY), 'linked')
})

test('both ids route to Linked Payments, and Order wins the display', () => {
  assert.equal(linkageModeFor(BOTH), 'linked')
  const t = resolveLinkedAgainst({
    ...BOTH, order_number: 'ORD-2026-0007', order_request_number: 'REQ-2026-0024',
  })
  assert.equal(t.kind, 'order')
  assert.equal(t.label, 'Order ORD-2026-0007')
})

test('neither id routes to Non-Linked Payments', () => {
  assert.equal(linkageModeFor(NEITHER), 'unlinked')
})

test('an Order Request-linked payment never appears under Non-Linked Payments', () => {
  assert.notEqual(linkageModeFor(REQUEST_ONLY), 'unlinked')
  assert.notEqual(linkageModeFor(BOTH), 'unlinked')
})

test('Non-Linked Payments contains only rows with both relationships absent', () => {
  const all = [ORDER_ONLY, REQUEST_ONLY, BOTH, NEITHER]
  const unlinked = all.filter(r => linkageModeFor(r) === 'unlinked')
  assert.deepEqual(unlinked, [NEITHER])
  for (const r of unlinked) {
    assert.equal(r.order_id, null)
    assert.equal(r.order_request_id, null)
  }
})

test('every linkage shape belongs to exactly one subpage', () => {
  for (const r of [ORDER_ONLY, REQUEST_ONLY, BOTH, NEITHER]) {
    const mode = linkageModeFor(r)
    const onLinked   = mode === 'linked'
    const onUnlinked = mode === 'unlinked'
    assert.equal(
      Number(onLinked) + Number(onUnlinked), 1,
      `${JSON.stringify(r)} must appear on exactly one Received Payments page`,
    )
  }
})

test('the routing predicate is Boolean(order_id || order_request_id)', () => {
  // Stated directly, so a future edit that reintroduces a status check or drops
  // one of the two columns fails here rather than in production.
  for (const r of [ORDER_ONLY, REQUEST_ONLY, BOTH, NEITHER]) {
    const expected = Boolean(r.order_id || r.order_request_id) ? 'linked' : 'unlinked'
    assert.equal(linkageModeFor(r), expected)
  }
})

// ── Sidebar count predicates ──────────────────────────────────────────────────
// The counts cannot classify rows in the browser — they are head:true queries
// that never receive one. What CAN be checked is that the database predicate the
// counts send is the same one linkageModeFor applies in memory, on every shape.

// Minimal stand-in for a PostgREST filter builder: records the calls instead of
// making them, so the predicate can be asserted without a database.
function fakeQuery() {
  const calls: string[] = []
  const q = {
    calls,
    or(filters: string) { calls.push(`or(${filters})`); return q },
    is(column: string, value: null) { calls.push(`is(${column},${value})`); return q },
  }
  return q
}

test('the linked scope asks the database for either linkage', () => {
  assert.deepEqual(applyLinkageScope(fakeQuery(), 'linked').calls, [
    'or(order_id.not.is.null,order_request_id.not.is.null)',
  ])
  assert.equal(LINKED_OR_PREDICATE, 'order_id.not.is.null,order_request_id.not.is.null')
})

test('the non-linked scope requires BOTH columns to be null', () => {
  assert.deepEqual(applyLinkageScope(fakeQuery(), 'unlinked').calls, [
    'is(order_id,null)',
    'is(order_request_id,null)',
  ])
})

test('the count predicate never narrows to order_id alone', () => {
  // The bug this guards: counting (or listing) on order_id only would drop every
  // Order-Request-linked payment out of Linked Payments.
  const linked = applyLinkageScope(fakeQuery(), 'linked').calls.join(' ')
  assert.match(linked, /order_request_id/)
  const unlinked = applyLinkageScope(fakeQuery(), 'unlinked').calls.join(' ')
  assert.match(unlinked, /order_request_id/)
})

test('the count scope and linkageModeFor agree on every linkage shape', () => {
  // Simulates each predicate against the four shapes, and asserts the row would
  // be counted by exactly the page linkageModeFor sends it to.
  const matchesLinkedPredicate   = (r: LinkageShape) => !!(r.order_id || r.order_request_id)
  const matchesUnlinkedPredicate = (r: LinkageShape) => !r.order_id && !r.order_request_id

  for (const r of ALL_SHAPES) {
    const mode = linkageModeFor(r)
    assert.equal(matchesLinkedPredicate(r),   mode === 'linked',   `linked count vs routing: ${JSON.stringify(r)}`)
    assert.equal(matchesUnlinkedPredicate(r), mode === 'unlinked', `non-linked count vs routing: ${JSON.stringify(r)}`)
    // Counted once in total, never zero times and never twice.
    assert.equal(Number(matchesLinkedPredicate(r)) + Number(matchesUnlinkedPredicate(r)), 1)
  }
})

test('the counts are scoped to received payments only', () => {
  // Request-stage records must not be counted as money received.
  for (const s of REQUEST_STAGE_STATUSES) {
    assert.equal((CONFIRMED_PAYMENT_STATUSES as readonly string[]).includes(s), false)
  }
  assert.deepEqual([...CONFIRMED_PAYMENT_STATUSES], ['approved_unlinked', 'approved_linked'])
})

// ── Linked Against resolution ─────────────────────────────────────────────────

const row = (o: Partial<Parameters<typeof resolveLinkedAgainst>[0]>) => ({
  order_id: null, order_number: null,
  order_request_id: null, order_request_number: null,
  ...o,
})

test('a confirmed Order is displayed as "Order <order_number>"', () => {
  const t = resolveLinkedAgainst(row({ order_id: 'o1', order_number: 'ORD-2026-0007' }))
  assert.equal(t.kind, 'order')
  assert.equal(t.label, 'Order ORD-2026-0007')
})

test('the Order Request number is displayed when no confirmed Order exists', () => {
  const t = resolveLinkedAgainst(row({ order_request_id: 'r1', order_request_number: 'REQ-2026-0024' }))
  assert.equal(t.kind, 'request')
  assert.equal(t.label, 'Order Request REQ-2026-0024')
})

test('a confirmed Order is preferred over an Order Request', () => {
  // What conversion produces in transit: the display prefers the Order without
  // anything having to migrate the row.
  const t = resolveLinkedAgainst(row({
    order_id: 'o1', order_number: 'ORD-2026-0007',
    order_request_id: 'r1', order_request_number: 'REQ-2026-0024',
  }))
  assert.equal(t.kind, 'order')
  assert.equal(t.label, 'Order ORD-2026-0007')
})

test('"Not linked" is displayed only when neither relation exists', () => {
  assert.equal(resolveLinkedAgainst(row({})).label, 'Not linked')
  // ...and never when a request number is available.
  assert.notEqual(
    resolveLinkedAgainst(row({ order_request_id: 'r1', order_request_number: 'REQ-1' })).label,
    'Not linked',
  )
})

test('the cell is never blank and never a vague pending label', () => {
  const rows = [
    row({ order_id: 'o1', order_number: 'ORD-1' }),
    row({ order_request_id: 'r1', order_request_number: 'REQ-1' }),
    row({}),
  ]
  for (const r of rows) {
    const label = resolveLinkedAgainst(r).label
    assert.ok(label.trim().length > 0, 'label must not be blank')
    assert.doesNotMatch(label, /Order No\. Pending|awaiting order/i)
  }
})

test('a missing denormalised number falls back to the id rather than a bare prefix', () => {
  assert.equal(resolveLinkedAgainst(row({ order_id: 'o1' })).label, 'Order o1')
  assert.equal(resolveLinkedAgainst(row({ order_request_id: 'r1' })).label, 'Order Request r1')
})

test('the Payment Request number is never overwritten by the linkage label', () => {
  // resolveLinkedAgainst reads only the linkage columns — request_number is not
  // one of its inputs, so no linkage state can shadow it.
  const t = resolveLinkedAgainst(row({ order_id: 'o1', order_number: 'ORD-1' }))
  assert.equal('request_number' in t, false)
})

// ── Verification must be reachable, and only by the right people ─────────────
//
// THE PRODUCTION DEFECT THIS COVERS. Verification was reachable from exactly one
// place: clicking a table row, which opened the review modal only for a viewer
// holding the approval capability. The row's explicit "View" button opened the
// DETAILS modal instead — and that modal had no verification control at all. An
// administrator taking the obvious route saw Pending Review / Needs
// Clarification / Rejected and Delete / Edit, and could not confirm the payment.
// Reported against PAY-REQ-2026-0038, a payment recorded from a PI.
//
// It was never PI-specific: any pending payment opened through View was stuck.
// PI payments simply made it the common case.

describe('a pending payment can be verified', () => {
  test('the approval capability plus a pending status is the whole rule', () => {
    assert.equal(canVerifyPayment('pending_approval', true), true)
  })

  test('no approval capability, no control — whatever the status', () => {
    for (const status of ['pending_approval', 'needs_clarification', 'rejected',
                          'approved_unlinked', 'approved_linked']) {
      assert.equal(canVerifyPayment(status, false), false, status)
      assert.equal(canVerifyPayment(status, null), false, status)
      assert.equal(canVerifyPayment(status, undefined), false, status)
    }
  })

  test('only a PENDING payment is verifiable', () => {
    // needs_clarification and rejected must travel back through the existing
    // correction and reapply route first; the RPC refuses anything else and this
    // agrees with it rather than offering a control that would fail.
    for (const status of ['needs_clarification', 'rejected',
                          'approved_unlinked', 'approved_linked']) {
      assert.equal(canVerifyPayment(status, true), false, status)
    }
    assert.equal(canVerifyPayment(null, true), false)
    assert.equal(canVerifyPayment(undefined, true), false)
  })

  test('an already-verified payment is never offered verification again', () => {
    for (const status of CONFIRMED_PAYMENT_STATUSES) {
      assert.equal(canVerifyPayment(status, true), false, status)
    }
  })

  test('every request-stage status is answered, so none can fall through', () => {
    for (const status of REQUEST_STAGE_STATUSES) {
      assert.equal(typeof canVerifyPayment(status, true), 'boolean', status)
    }
  })
})

describe('the details modal actually offers verification', () => {
  const SOURCE = readFileSync(join(process.cwd(), 'src/app/finance/page.tsx'), 'utf8')

  test('it draws the control from the shared rule, not a local condition', () => {
    assert.ok(SOURCE.includes('canVerifyPayment(r.status, mayApprovePayments)'),
      'the details modal must decide from the shared rule')
    assert.ok(SOURCE.includes('mayApprovePayments={caps.canApprovePayment}'),
      'the capability passed in must be finance.approve, not another one')
  })

  test('the control is labelled Verify Payment, not Approve', () => {
    // The action confirms Finance checked the money; "Approve" reads as
    // approving the order.
    assert.ok(SOURCE.includes('Verify Payment'), 'the primary control must say Verify Payment')
  })

  test('it calls the EXISTING RPC and builds no second approval flow', () => {
    const calls = [...SOURCE.matchAll(/\.rpc\('([^']+)'/g)].map(m => m[1])
    assert.ok(calls.includes('approve_finance_payment_request'),
      'verification must go through the existing RPC')
    for (const name of calls) {
      assert.ok(!/verify_payment|approve_payment_v2|confirm_payment/.test(name),
        `${name} looks like a second approval flow`)
    }
  })

  test('verified statuses are still absent from the correction dropdown', () => {
    // 20260692000000 removed both approved statuses from the correction options
    // precisely because moving into them needs the RPC's locking and
    // bookkeeping. Adding a primary button must not have put them back.
    const block = SOURCE.slice(SOURCE.indexOf('const STATUS_CORRECTION_OPTIONS'))
      .slice(0, SOURCE.slice(SOURCE.indexOf('const STATUS_CORRECTION_OPTIONS')).indexOf(']'))
    assert.ok(!block.includes('approved_unlinked') && !block.includes('approved_linked'),
      'no approved status may be selectable in the correction dropdown')
  })

  test('a double click cannot submit verification twice', () => {
    // A ref set BEFORE the await, not a state update that only lands on the next
    // render. Verification is not idempotent from the caller's side.
    assert.ok(SOURCE.includes('verifyingRef'),
      'verification must be guarded by a ref, not by state alone')
    assert.ok(/if \(verifyingRef\.current\) return/.test(SOURCE),
      'the guard must return early on a second call')
    assert.ok(SOURCE.includes('disabled={verifying}'),
      'the confirm button must be disabled while the call is in flight')
  })

  test('Needs Clarification and Rejected remain separate decisions', () => {
    assert.ok(SOURCE.includes("'needs_clarification'") && SOURCE.includes("'reject'"),
      'the other two decisions must still exist independently')
  })
})
