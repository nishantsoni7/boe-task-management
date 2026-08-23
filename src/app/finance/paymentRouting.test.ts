import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONFIRMED_PAYMENT_STATUSES,
  LINKED_OR_PREDICATE,
  REQUEST_STAGE_STATUSES,
  RECEIVED_PAYMENTS_SOURCE,
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

// The linkage shapes, named once. `both` cannot occur while 20260698's CHECK
// stands, and is covered anyway so the rule survives it. ALLOCATED is Phase 3's
// shape: neither parent column is set — the payment record is deliberately left
// alone when a PI is approved — and the money is nonetheless on a numbered Order.
type LinkageShape = {
  order_id: string | null
  order_request_id: string | null
  is_order_allocated?: boolean | null
}

const ORDER_ONLY:   LinkageShape = { order_id: 'order-1', order_request_id: null }
const REQUEST_ONLY: LinkageShape = { order_id: null,      order_request_id: 'req-1' }
const BOTH:         LinkageShape = { order_id: 'order-1', order_request_id: 'req-1' }
const NEITHER:      LinkageShape = { order_id: null,      order_request_id: null }
const ALLOCATED:    LinkageShape = { order_id: null,      order_request_id: null, is_order_allocated: true }

const ALL_SHAPES: LinkageShape[] = [ORDER_ONLY, REQUEST_ONLY, BOTH, NEITHER, ALLOCATED]

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

test('Non-Linked Payments contains only rows with NO relationship at all', () => {
  const unlinked = ALL_SHAPES.filter(r => linkageModeFor(r) === 'unlinked')
  assert.deepEqual(unlinked, [NEITHER])
  for (const r of unlinked) {
    assert.equal(r.order_id, null)
    assert.equal(r.order_request_id, null)
    assert.ok(!r.is_order_allocated)
  }
})

test('every linkage shape belongs to exactly one subpage', () => {
  for (const r of ALL_SHAPES) {
    const mode = linkageModeFor(r)
    const onLinked   = mode === 'linked'
    const onUnlinked = mode === 'unlinked'
    assert.equal(
      Number(onLinked) + Number(onUnlinked), 1,
      `${JSON.stringify(r)} must appear on exactly one Received Payments page`,
    )
  }
})

test('the routing predicate is Boolean(allocated || order_id || order_request_id)', () => {
  // Stated directly, so a future edit that reintroduces a status check or drops
  // one of the three inputs fails here rather than in production.
  for (const r of ALL_SHAPES) {
    const expected = Boolean(r.is_order_allocated || r.order_id || r.order_request_id) ? 'linked' : 'unlinked'
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
    is(column: string, value: null | boolean) { calls.push(`is(${column},${value})`); return q },
  }
  return q
}

test('the linked scope asks the database for any of the three linkages', () => {
  assert.deepEqual(applyLinkageScope(fakeQuery(), 'linked').calls, [
    'or(is_order_allocated.is.true,order_id.not.is.null,order_request_id.not.is.null)',
  ])
  assert.equal(
    LINKED_OR_PREDICATE,
    'is_order_allocated.is.true,order_id.not.is.null,order_request_id.not.is.null',
  )
})

test('the non-linked scope requires ALL THREE to be absent', () => {
  assert.deepEqual(applyLinkageScope(fakeQuery(), 'unlinked').calls, [
    'is(is_order_allocated,false)',
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
  const matchesLinkedPredicate   = (r: LinkageShape) =>
    !!(r.is_order_allocated || r.order_id || r.order_request_id)
  const matchesUnlinkedPredicate = (r: LinkageShape) =>
    !r.is_order_allocated && !r.order_id && !r.order_request_id

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
  allocated_order_id: null, allocated_order_number: null,
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

  test('BOTH routes to this action are labelled the same way', () => {
    // The page reaches one RPC by two doors: the details modal's primary button
    // and the review modal's decision row. They used to be called "Verify
    // Payment" and "Mark Payment Received", which read as two different powers.
    const labelled = SOURCE.split('Verify Payment').length - 1
    assert.ok(labelled >= 2,
      `both the details panel and the review decision must say Verify Payment (found ${labelled})`)

    for (const retired of ['Mark Payment Received', 'Approve Payment']) {
      assert.ok(!SOURCE.includes(retired), `"${retired}" must not survive anywhere on this page`)
    }
  })

  test('the copy changed and the WIRING did not', () => {
    // The whole risk of a copy pass over a decision surface: renaming the thing
    // people read is safe, renaming what the code dispatches on is a workflow
    // change wearing a copy change's clothes. These are the identifiers the
    // wording must not have dragged along with it.
    assert.ok(SOURCE.includes("type AdminAction = 'approve' | 'needs_clarification' | 'reject'"),
      'the three decision keys are the workflow and must be untouched')
    assert.ok(SOURCE.includes("{ key: 'approve',"),
      "the verification decision must still dispatch on the 'approve' key")
    assert.ok(SOURCE.includes("action === 'approve'"),
      "the approve branch must still be selected by its key, not by its label")

    // Statuses, the RPC and the capability are database and permission facts,
    // not copy. A rename here would be exactly the unauthorised change this
    // guard exists to refuse.
    for (const wiring of ['approved_unlinked', 'approved_linked', 'pending_approval',
                          'approve_finance_payment_request', 'caps.canApprovePayment']) {
      assert.ok(SOURCE.includes(wiring), `${wiring} must survive the wording change`)
    }
  })

  test('verification is described as verification, start to finish', () => {
    // Confirmation, in-flight and outcome text for the SAME action. A person who
    // clicks Verify Payment should not be told the money was "approved".
    assert.ok(SOURCE.includes("'Verifying…'"),
      'the in-flight label must name the action being performed')
    assert.ok(/will be verified/.test(SOURCE),
      'the consequence text must describe verification')
    assert.ok(!/has already been approved|has been approved and is now managed/.test(SOURCE),
      'the stale-row messages must describe verification too')
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

// ── Phase 3: the allocation is what says where the money is ───────────────────
//
// THE INCONSISTENCY THESE COVER. Approving a PI moves its active allocations
// onto the new Order and deliberately leaves the payment record untouched — its
// proof, its verification, its Finance history and the reference the salesperson
// typed all stay where they are, so it keeps `order_id = NULL` and
// `approved_unlinked`. Classified from the parent columns alone, money on a
// numbered Order would sit in Non-Linked Payments, whose stated meaning is
// "nothing at all points at this", and the counter beside it would over-report.
//
// The ledger is not rewritten to fix that. The READ is corrected, from the
// allocation table that has been the source of truth for what money belongs to
// since Phase 1, through the finance_received_payments projection.
//
// Each case below is numbered against the acceptance list. Cases 11–15 are
// database-visibility and cross-module facts with no pure-function surface; they
// are proved in supabase/tests/pi_verified_payment_gate_assertions.sql §13–§15.

describe('the fifteen compatibility cases', () => {
  const shape = (o: Partial<LinkageShape>): LinkageShape => ({
    order_id: null, order_request_id: null, is_order_allocated: false, ...o,
  })

  test('1. a legacy approved_linked payment with a parent order_id stays Linked', () => {
    const r = shape({ order_id: 'order-1' })
    assert.equal(linkageModeFor(r), 'linked')
    // And it is still labelled from the PARENT column, not the allocation.
    assert.equal(
      resolveLinkedAgainst(row({ order_id: 'order-1', order_number: 'ORD-2026-0007' })).label,
      'Order ORD-2026-0007',
    )
  })

  test('2. a legacy approved_unlinked payment with no allocation stays Non-Linked', () => {
    assert.equal(linkageModeFor(shape({})), 'unlinked')
  })

  test('3. a verified PI payment is Non-Linked BEFORE conversion', () => {
    // An active allocation onto the PI is not a Confirmed-Order allocation, so
    // the projection reports is_order_allocated = false. The money is real and
    // attached to a PI — but no Order exists yet, and the Finance queue is about
    // Orders.
    assert.equal(linkageModeFor(shape({ is_order_allocated: false })), 'unlinked')
  })

  test('4. the SAME payment becomes Linked the moment its allocation moves', () => {
    const before = shape({})
    const after  = shape({ is_order_allocated: true })
    assert.equal(linkageModeFor(before), 'unlinked')
    assert.equal(linkageModeFor(after),  'linked')
  })

  test('5. nothing about the payment record itself changes across that move', () => {
    // The only difference between the two shapes above is the DERIVED column.
    // Both parent linkage columns — and by extension the row's id, its status
    // and the salesperson's reference in order_number — are identical.
    const before = shape({})
    const after  = shape({ is_order_allocated: true })
    assert.equal(before.order_id, after.order_id)
    assert.equal(before.order_request_id, after.order_request_id)
    assert.deepEqual(
      Object.keys(before).filter(k => (before as never)[k] !== (after as never)[k]),
      ['is_order_allocated'],
    )
  })

  test('6. a REVERSED Order allocation does not make a payment Linked', () => {
    // Enforced in the projection's LATERAL (`a.status = 'active'`), asserted
    // here on the view text so it cannot be dropped, and functionally in the SQL
    // suite. A reversed allocation is a claim that was withdrawn.
    assert.match(VIEW_SQL, /and a\.status = 'active'/)
    assert.equal(linkageModeFor(shape({ is_order_allocated: false })), 'unlinked')
  })

  test('7. an active PI allocation plus a reversed Order allocation stays Non-Linked', () => {
    // Both conditions in the LATERAL must hold together: active AND naming an
    // Order. Either alone is not a Confirmed-Order allocation.
    assert.match(VIEW_SQL, /and a\.status = 'active'\s*\n\s*and a\.order_id is not null/)
    assert.equal(linkageModeFor(shape({ is_order_allocated: false })), 'unlinked')
  })

  test('8. an Order Request payment is classified exactly as it is today', () => {
    // Unchanged from before Phase 3: an Order-Request linkage is a linkage. The
    // payment has been allocated to a piece of business, and conversion moves it
    // onto the Order without anyone touching it again.
    assert.equal(linkageModeFor(shape({ order_request_id: 'req-1' })), 'linked')
    assert.equal(
      resolveLinkedAgainst(row({ order_request_id: 'req-1', order_request_number: 'REQ-2026-0024' })).label,
      'Order Request REQ-2026-0024',
    )
  })

  test('9. pending / clarification / rejected screens are untouched', () => {
    // The classification never reads status, and the Payment Requests page never
    // reads the projection — it stays on the base table, with its own scope.
    for (const status of REQUEST_STAGE_STATUSES) {
      assert.equal(isConfirmedPayment(status), false)
    }
    const requestsPage = readFileSync(join(process.cwd(), 'src/app/finance/page.tsx'), 'utf8')
    assert.ok(!requestsPage.includes(RECEIVED_PAYMENTS_SOURCE),
      'the Payment Requests page must keep reading finance_payment_requests')
  })

  test('10. the counters match their lists, shape for shape', () => {
    // Same assertion as the count-scope test above, restated against the
    // acceptance list: each shape is matched by exactly one of the two database
    // predicates, and by the same one linkageModeFor sends it to.
    const linkedPredicate   = (r: LinkageShape) => !!(r.is_order_allocated || r.order_id || r.order_request_id)
    const unlinkedPredicate = (r: LinkageShape) => !r.is_order_allocated && !r.order_id && !r.order_request_id
    for (const r of ALL_SHAPES) {
      assert.equal(Number(linkedPredicate(r)) + Number(unlinkedPredicate(r)), 1, JSON.stringify(r))
      assert.equal(linkedPredicate(r), linkageModeFor(r) === 'linked', JSON.stringify(r))
    }
  })

  test('11–15 are proved in SQL, and the file says so', () => {
    // Visibility, RLS isolation, Order detail and PI detail are database facts.
    const suite = readFileSync(
      join(process.cwd(), 'supabase/tests/pi_verified_payment_gate_assertions.sql'), 'utf8')
    for (const marker of [
      'participant-only PI visibility',
      'finance.view_all',
      'sales visibility',
      'Order detail still shows the moved payment',
      'PI detail no longer includes the moved allocation',
    ]) {
      assert.ok(suite.includes(marker), `the SQL suite must prove: ${marker}`)
    }
  })
})

// ── The read model, and the shape of it ───────────────────────────────────────

const VIEW_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260921000000_order_submission_verified_payment_gate.sql'),
  'utf8',
).split('create view public.finance_received_payments')[1]?.split('§9.')[0] ?? ''

describe('the projection both pages read', () => {
  test('there is exactly one source, named once', () => {
    assert.equal(RECEIVED_PAYMENTS_SOURCE, 'finance_received_payments')
    for (const file of [
      'src/app/finance/received/ReceivedPaymentsView.tsx',
      'src/hooks/queries/useReceivedPaymentsCounts.ts',
      'src/app/finance/received/page.tsx',
      'src/app/admin/control-center/action-queue/page.tsx',
    ]) {
      const src = readFileSync(join(process.cwd(), file), 'utf8')
      assert.ok(src.includes('RECEIVED_PAYMENTS_SOURCE'),
        `${file} must read the shared projection constant, not a table name of its own`)
      assert.ok(!src.includes(`.from('finance_received_payments')`),
        `${file} must not hard-code the projection's name`)
    }
  })

  test('it is a security_invoker VIEW, never a definer function', () => {
    assert.match(VIEW_SQL, /with \(security_invoker = true\)/)
    assert.ok(!VIEW_SQL.includes('security definer'),
      'a Finance-wide read projection must never be SECURITY DEFINER')
  })

  test('EVERY client role is revoked before authenticated is granted SELECT', () => {
    // THE DEPLOYMENT FAILURE THIS EXISTS TO PREVENT RECURRING. Supabase's
    // bootstrap runs `alter default privileges in schema public grant all on
    // tables to postgres, anon, authenticated, service_role`, so a new VIEW is
    // born with arwdDxt for all three client-facing roles. A revoke naming only
    // `public, anon` left `authenticated` holding INSERT/UPDATE/DELETE on a read
    // projection, and the migration's own assertion refused the apply.
    assert.match(
      VIEW_SQL,
      /revoke all privileges on public\.finance_received_payments\s*\n\s*from public, anon, authenticated;/,
      'the revoke must name authenticated — the platform granted it everything at CREATE VIEW',
    )
    assert.match(VIEW_SQL, /grant select on public\.finance_received_payments to authenticated;/)
    // Executable lines only: the comment above the statements QUOTES the
    // platform's own `grant all on tables …` bootstrap, which is the thing being
    // undone rather than something this file does.
    const statements = VIEW_SQL.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    assert.ok(!/grant (insert|update|delete|all)/i.test(statements),
      'the projection carries no write privilege')
  })

  test('the revoke comes BEFORE the grant, or the grant is erased', () => {
    const revoke = VIEW_SQL.indexOf('revoke all privileges on public.finance_received_payments')
    const grant  = VIEW_SQL.indexOf('grant select on public.finance_received_payments')
    assert.ok(revoke > -1 && grant > -1)
    assert.ok(revoke < grant, 'REVOKE ALL after GRANT SELECT would take the grant away again')
  })

  test('nothing is granted to service_role, and nothing is granted to anon', () => {
    const statements = VIEW_SQL.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    assert.ok(!/grant[^;]*finance_received_payments[^;]*to[^;]*service_role/i.test(statements),
      'this file grants service_role nothing on the projection')
    assert.ok(!/grant[^;]*finance_received_payments[^;]*to[^;]*anon/i.test(statements),
      'anon must never be granted anything on the projection')
  })

  test('every table it reads is schema-qualified', () => {
    // The statement only, with its comment lines removed — otherwise the prose
    // around it ("from the allocation table…") reads as a relation reference.
    const ddl = VIEW_SQL.split('alloc on true;')[0]
      .split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    const unqualified = [...ddl.matchAll(/\b(?:from|join)\s+(?!lateral\b)([a-z_]\w*)/gi)]
      .map(m => m[1])
      .filter(t => t !== 'public')
    assert.deepEqual(unqualified, [], `unqualified relation(s): ${unqualified.join(', ')}`)
  })

  test('search_path cannot decide what it reads', () => {
    // Every relation is written public.<name>, so no session's search_path can
    // point the projection at a different table of the same name.
    const ddl = VIEW_SQL.split('alloc on true;')[0]
    for (const relation of [
      'public.finance_payment_requests', 'public.finance_payment_allocations',
      'public.users', 'public.orders',
    ]) {
      assert.ok(ddl.includes(relation), `${relation} must be read schema-qualified`)
    }
  })

  test('it exposes no allocation id, no amount and no split', () => {
    for (const forbidden of ['a.id as', 'a.amount', 'allocation_id', 'allocated_amount']) {
      assert.ok(!VIEW_SQL.includes(forbidden), `the projection must not expose ${forbidden}`)
    }
  })

  test('one row per payment, whatever the allocations', () => {
    // A LATERAL with LIMIT 1 cannot multiply the left side, and the two name
    // joins are on users.id — a primary key.
    assert.match(VIEW_SQL, /left join lateral/)
    assert.match(VIEW_SQL, /limit 1/)
    assert.match(VIEW_SQL, /left join public\.users eb on eb\.id = f\.submitted_by/)
    assert.match(VIEW_SQL, /left join public\.users ab on ab\.id = f\.approved_by/)
  })

  test('a split payment is labelled by its OLDEST active Order allocation', () => {
    // Deterministic, so the same row cannot be labelled one way by the list and
    // another by a refresh: (created_at, id) is a total order.
    assert.match(VIEW_SQL, /order by a\.created_at, a\.id/)
  })

  test('the lists ask for no allocation join of their own — no N+1', () => {
    const view = readFileSync(
      join(process.cwd(), 'src/app/finance/received/ReceivedPaymentsView.tsx'), 'utf8')

    // THE CLASSIFICATION still comes from the projection and never from a
    // per-row query: is_order_allocated is what decides which of the two pages
    // holds a payment, and that has not moved.
    assert.ok(view.includes('is_order_allocated'),
      'the linkage flag is the projection\'s, not a join the list performs')

    // The page does now read finance_payment_allocations — the projection
    // exposes no allocated amount and no split by design (20260921000000 §8a),
    // and Finance has to be able to see how much of a payment is still free.
    // The invariant this test protects was never "never touch that table"; it
    // was NO N+1. So the shape is pinned instead of the absence:
    //
    //   * exactly ONE read of the table on the whole page, and
    //   * keyed on the ids of the page already loaded, in one .in() —
    //     which is bounded twice over, since the list itself is paged.
    const reads = view.split(".from('finance_payment_allocations')").length - 1
    assert.equal(reads, 1, 'exactly one allocation read, for the whole page')
    assert.ok(view.includes(".in('payment_request_id', rows.map(r => r.id))"),
      'the allocation read is batched across the page, never issued per row')

    // And it is not inside anything that iterates rows.
    const perRow = /rows\.map\([\s\S]{0,400}?\.from\('finance_payment_allocations'\)/
    assert.ok(!perRow.test(view), 'the allocation read must not sit inside a row loop')
  })

  test('the list still orders by created_at, newest first', () => {
    const view = readFileSync(
      join(process.cwd(), 'src/app/finance/received/ReceivedPaymentsView.tsx'), 'utf8')
    assert.ok(view.includes(`.order('created_at', { ascending: false })`),
      'ordering must be unchanged by the data-source swap')
  })

  test('every mutation still writes to the base table by the payment id', () => {
    const view = readFileSync(
      join(process.cwd(), 'src/app/finance/received/ReceivedPaymentsView.tsx'), 'utf8')
    // The projection is read-only; each .update() names finance_payment_requests.
    const writes = view.split('.update(').length - 1
    assert.ok(writes > 0, 'the page still performs updates')
    assert.ok(view.includes(`.from('finance_payment_requests')`),
      'writes must target the authoritative base table')
  })

  test('the filters the page applies in the browser still have their columns', () => {
    // Date, customer, mode, search and status all read columns the projection
    // carries through verbatim, so no filter loses its input.
    for (const column of [
      'client_name', 'payment_date', 'payment_mode', 'request_number',
      'status', 'order_number', 'order_request_number', 'received_in',
    ]) {
      assert.ok(VIEW_SQL.includes(`f.${column}`), `the projection must carry ${column}`)
    }
  })
})

// ── A future payment split across several Orders ──────────────────────────────

describe('multi-allocation behaviour', () => {
  test('one active Order allocation among several is enough to be Linked', () => {
    assert.equal(linkageModeFor({ order_id: null, order_request_id: null, is_order_allocated: true }), 'linked')
  })

  test('it appears once, labelled by the first Order', () => {
    // The projection returns a single allocation row (LIMIT 1), so the page has
    // exactly one order to name and exactly one row to draw.
    const t = resolveLinkedAgainst(row({
      allocated_order_id: 'order-a', allocated_order_number: 'ORD-2026-0007',
    }))
    assert.equal(t.kind, 'order')
    assert.equal(t.label, 'Order ORD-2026-0007')
  })

  test('no allocated amount reaches the Finance list', () => {
    const t = resolveLinkedAgainst(row({ allocated_order_id: 'order-a' }))
    assert.equal('amount' in t, false)
  })

  test('the allocated Order is named only when the parent has none', () => {
    // Priority is unchanged: the parent order_id still wins, so no legacy row
    // changes its label.
    const t = resolveLinkedAgainst(row({
      order_id: 'order-legacy', order_number: 'ORD-2026-0001',
      allocated_order_id: 'order-a', allocated_order_number: 'ORD-2026-0007',
    }))
    assert.equal(t.label, 'Order ORD-2026-0001')
  })

  test('an allocated Order the reader cannot open still reads as linked', () => {
    // is_order_allocated comes from the ALLOCATION, and the number from the
    // Order. A caller whose RLS hides the Order loses the number, not the fact.
    const t = resolveLinkedAgainst(row({ allocated_order_id: 'order-a', allocated_order_number: null }))
    assert.equal(t.kind, 'order')
    assert.equal(t.label, 'Order order-a')
  })
})
