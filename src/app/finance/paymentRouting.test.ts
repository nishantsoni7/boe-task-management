import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONFIRMED_PAYMENT_STATUSES,
  REQUEST_STAGE_STATUSES,
  RECEIVED_PAYMENTS_SOURCE,
  isConfirmedPayment,
  isRequestStageStatus,
  canVerifyPayment,
} from './paymentRouting'
import {
  CLASSIFIED_PAYMENT_STATUSES,
  PAYMENT_VIEWS,
  classifyPayment,
  paymentViewClauses,
} from '@/lib/finance/paymentClassification'
import { directOrderOf, paymentLinks, linkCounts } from '@/lib/finance/paymentLinks'
import type { PaymentAllocationSummary } from '@/lib/finance/paymentAllocations'

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

// ── Where a payment's money actually goes ─────────────────────────────────────
//
// WHAT THIS SECTION REPLACED. `linkageModeFor` and `applyLinkageScope` split
// every received payment across two sibling pages, counting three things as a
// linkage: an active Order allocation, the payment's own order_id, and an
// order_request_id. The third is retired (20261007000000) and has never
// attributed a rupee under the canonical rule; and the pair could not express a
// payment SPLIT between an Order and a PI Draft, which belongs in both linked
// views at once.
//
// What replaced it is one classification, tested in
// src/lib/finance/paymentClassification.test.ts, plus the DESTINATIONS a row
// draws — which is what these tests cover: every place the money went, a door to
// each the reader may open, and nothing at all about the ones they may not.

function summary(targets: PaymentAllocationSummary['targets']): PaymentAllocationSummary {
  return { paymentId: 'p1', state: 'partial', allocated: null, unallocated: null, targets }
}

const ORDER_TARGET = {
  allocationId: 'a1', kind: 'order' as const, targetId: 'order-1', label: null, amount: '400000.00',
}
const PI_TARGET = {
  allocationId: 'a2', kind: 'submission' as const, targetId: 'sub-1', label: null, amount: '250000.00',
}

const LABELS = new Map([['order-1', 'ORD-2026-0007'], ['sub-1', 'PI-0042']])

test('a payment allocated to an Order points at that Order, and offers a door', () => {
  const links = paymentLinks({
    summary: summary([ORDER_TARGET]), directOrder: null, labels: LABELS, canOpenOrders: true,
  })
  assert.equal(links.length, 1)
  assert.equal(links[0].kind, 'order')
  assert.equal(links[0].label, 'ORD-2026-0007')
  assert.equal(links[0].href, '/orders/order-1')
})

test('a payment split between an Order and a PI points at BOTH', () => {
  // The case a two-page partition could not express at all.
  const links = paymentLinks({
    summary: summary([ORDER_TARGET, PI_TARGET]), directOrder: null, labels: LABELS, canOpenOrders: true,
  })
  assert.deepEqual(links.map(l => l.kind), ['order', 'submission'])
  assert.deepEqual(links.map(l => l.href), ['/orders/order-1', '/orders/drafts/sub-1'])
})

test('the direct linkage is a destination ONLY when nothing is allocated', () => {
  // Rule 2 of the canonical attribution rule, and not a separate decision. A
  // payment linked to X and allocated to Y points at Y — naming X as well would
  // show a destination its own figures attribute nothing to.
  const withAllocation = paymentLinks({
    summary: summary([ORDER_TARGET]),
    directOrder: { id: 'order-legacy', number: 'ORD-2026-0001' },
    labels: LABELS, canOpenOrders: true,
  })
  assert.deepEqual(withAllocation.map(l => l.label), ['ORD-2026-0007'])

  const withoutAllocation = paymentLinks({
    summary: summary([]),
    directOrder: { id: 'order-legacy', number: 'ORD-2026-0001' },
    labels: LABELS, canOpenOrders: true,
  })
  assert.deepEqual(withoutAllocation.map(l => l.label), ['ORD-2026-0001'])
  assert.equal(withoutAllocation[0].href, '/orders/order-legacy')
})

test('directOrderOf drops the link the moment anything is allocated', () => {
  assert.deepEqual(
    directOrderOf({ order_id: 'o1', order_number: 'ORD-1', allocated_total: '0' }),
    { id: 'o1', number: 'ORD-1' },
  )
  assert.equal(directOrderOf({ order_id: 'o1', order_number: 'ORD-1', allocated_total: '400000' }), null)
  assert.equal(directOrderOf({ order_id: null, order_number: null, allocated_total: '0' }), null)
})

test('a payment with nothing pointing at it has no destinations at all', () => {
  const links = paymentLinks({
    summary: summary([]), directOrder: null, labels: new Map(), canOpenOrders: true,
  })
  assert.deepEqual(links, [])
})

test('A DESTINATION THE READER MAY NOT OPEN IS NAMED BY ITS KIND AND NOTHING ELSE', () => {
  // No number, no id, no client, no link. That the money is split is the
  // reader's own business; whose business the other share is, is not.
  const links = paymentLinks({
    summary: summary([ORDER_TARGET, PI_TARGET]),
    directOrder: null,
    // RLS returned neither record.
    labels: new Map(),
    canOpenOrders: true,
  })
  assert.deepEqual(links.map(l => l.label), ['An Order', 'A PI Draft'])
  assert.deepEqual(links.map(l => l.href), [null, null])
  assert.deepEqual(links.map(l => l.named), [false, false])
  for (const link of links) {
    assert.equal(link.label.includes(link.kind === 'order' ? 'order-1' : 'sub-1'), false,
      'an id must never leak through the placeholder')
  }
})

test('a reader who cannot open Order Management is offered no doors at all', () => {
  const links = paymentLinks({
    summary: summary([ORDER_TARGET]), directOrder: null, labels: LABELS, canOpenOrders: false,
  })
  // The linkage is still stated — it is their payment — but there is nowhere
  // to send them.
  assert.equal(links[0].label, 'ORD-2026-0007')
  assert.equal(links[0].href, null)
})

test('the counts say how many are hidden, never which', () => {
  const links = paymentLinks({
    summary: summary([ORDER_TARGET, PI_TARGET]),
    directOrder: null,
    labels: new Map([['order-1', 'ORD-2026-0007']]),
    canOpenOrders: true,
  })
  // The per-kind counts are part of the shape: the Confirmed Payments table
  // draws "×2" beside a money column from them rather than listing names.
  assert.deepEqual(linkCounts(links),
    { total: 2, openable: 1, hidden: 1, orders: 1, submissions: 1 })
})

// ── The narrowing the two surfaces share ─────────────────────────────────────

test('the classified scope is every status except rejected', () => {
  assert.deepEqual([...CLASSIFIED_PAYMENT_STATUSES],
    ['approved_unlinked', 'approved_linked', 'pending_approval', 'needs_clarification'])
  assert.equal((CLASSIFIED_PAYMENT_STATUSES as readonly string[]).includes('rejected'), false)
  // Every status the table allows is either classified or rejected — nothing
  // falls through into no scope at all.
  for (const status of ALL_STATUSES) {
    const classified = (CLASSIFIED_PAYMENT_STATUSES as readonly string[]).includes(status)
    assert.equal(classified, status !== 'rejected', status)
  }
})

test('the four views each narrow on a column the projection computes', () => {
  const columns = PAYMENT_VIEWS.flatMap(view =>
    paymentViewClauses(view).map(clause => clause.kind === 'eq' ? clause.column : ''))
  assert.deepEqual(columns.filter(Boolean),
    ['is_linked_to_order', 'is_linked_to_pi', 'is_available_to_allocate'])
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
  // Restated against the canonical classification. The acceptance list asked
  // "which of the two pages holds this row"; there are no longer two pages, so
  // each case is now "which of the four views, and what does the row say".
  //
  // Cases 11–15 are database-visibility and cross-module facts with no pure-
  // function surface; they are proved in
  // supabase/tests/pi_verified_payment_gate_assertions.sql §13–§15.

  const classify = (row: Partial<Parameters<typeof classifyPayment>[0]>) => classifyPayment({
    id: 'p', amount: '1000000.00', status: 'approved_unlinked', order_id: null,
    allocated_total: '0', order_allocated_total: '0', pi_allocated_total: '0',
    active_allocation_count: 0, attribution_complete: true, ...row,
  })

  test('1. a legacy approved_linked payment with a parent order_id is AVAILABLE money', () => {
    // THE RULE THAT CHANGED. This used to be Order money, attributed in full by
    // the direct-link fallback. Link and Unlink are gone and allocation rows are
    // the only source of attribution, so a payment with none is money nobody
    // has claimed — and the honest place for it is Available, where somebody
    // can allocate it.
    const c = classify({ order_id: 'order-1', status: 'approved_linked' })
    assert.deepEqual(c.views.sort(), ['all', 'available'])
    assert.equal(Number(c.orderLinked), 0, 'a dormant order_id attributes nothing')
    assert.equal(Number(c.available), 1000000, 'the whole payment is free to allocate')
  })

  test('1b. and it becomes Order money as soon as an allocation names the Order', () => {
    // The same row, once the allocation the product actually creates exists.
    const c = classify({
      order_id: 'order-1', status: 'approved_linked',
      allocated_total: '1000000.00', order_allocated_total: '1000000.00',
      active_allocation_count: 1,
    })
    assert.deepEqual(c.views.sort(), ['all', 'orders'])
    assert.equal(Number(c.orderLinked), 1000000)
    assert.equal(Number(c.available), 0)
  })

  test('2. a legacy approved_unlinked payment with no allocation is Available', () => {
    const c = classify({})
    assert.deepEqual(c.views.sort(), ['all', 'available'])
  })

  test('3. a verified PI payment is PI money BEFORE conversion, not Order money', () => {
    const c = classify({ allocated_total: '1000000.00', pi_allocated_total: '1000000.00', active_allocation_count: 1 })
    assert.deepEqual(c.views.sort(), ['all', 'pi_drafts'])
    assert.equal(Number(c.orderLinked), 0)
  })

  test('4. the SAME payment becomes Order money the moment its allocation moves', () => {
    const before = classify({ allocated_total: '1000000.00', pi_allocated_total: '1000000.00', active_allocation_count: 1 })
    const after  = classify({ allocated_total: '1000000.00', order_allocated_total: '1000000.00', active_allocation_count: 1 })
    assert.equal(before.views.includes('pi_drafts'), true)
    assert.equal(after.views.includes('orders'), true)
    assert.equal(after.views.includes('pi_drafts'), false)
  })

  test('5. nothing about the payment record itself changes across that move', () => {
    // The allocation moves; the payment row does not (20260921000000 §7). Both
    // classifications read the same order_id — null — and the same amount.
    const before = classify({ allocated_total: '1000000.00', pi_allocated_total: '1000000.00', active_allocation_count: 1 })
    const after  = classify({ allocated_total: '1000000.00', order_allocated_total: '1000000.00', active_allocation_count: 1 })
    assert.equal(before.attributed, after.attributed)
    assert.equal(before.available, after.available)
    assert.equal(before.allocationCount, after.allocationCount)
  })

  test('6. a REVERSED Order allocation attributes nothing', () => {
    // Enforced in the projection's aggregates (`a.status = 'active'`), asserted
    // here on the view text so it cannot be dropped, and functionally in the SQL
    // suite. A reversed allocation is a claim that was withdrawn.
    assert.match(VIEW_SQL, /and a\.status = 'active'/)
    // A payment whose only allocation was reversed sums to zero and falls back
    // to rule 2 — which, with no direct link, is nothing.
    const c = classify({ allocated_total: '0', active_allocation_count: 0 })
    assert.equal(Number(c.orderLinked), 0)
    assert.deepEqual(c.views.sort(), ['all', 'available'])
  })

  test('7. an active PI allocation plus a reversed Order allocation is PI money only', () => {
    const c = classify({
      allocated_total: '250000.00', pi_allocated_total: '250000.00',
      order_allocated_total: '0', active_allocation_count: 1,
    })
    assert.equal(c.views.includes('pi_drafts'), true)
    assert.equal(c.views.includes('orders'), false)
    assert.equal(Number(c.available), 750000)
  })

  test('8. A RETIRED ORDER REQUEST ATTRIBUTES NOTHING, so its money is Available', () => {
    // CHANGED, deliberately, and it is the canonical rule rather than a new
    // decision: rule 2 names order_id and only order_id. A request-linked
    // payment used to read as "linked" on the reasoning that conversion would
    // move it onto an Order by itself. Nothing will convert now, so calling it
    // spoken for would hide money that genuinely needs a person.
    const c = classify({ order_id: null })
    assert.deepEqual(c.views.sort(), ['all', 'available'])
    assert.equal(Number(c.available), 1000000)
  })

  test('9. pending / clarification / rejected screens are untouched', () => {
    // The Payment Requests page never reads the projection — it stays on the
    // base table, with its own scope.
    for (const status of REQUEST_STAGE_STATUSES) {
      assert.equal(isConfirmedPayment(status), false)
    }
    const requestsPage = readFileSync(join(process.cwd(), 'src/app/finance/page.tsx'), 'utf8')
    assert.ok(!requestsPage.includes(RECEIVED_PAYMENTS_SOURCE),
      'the Payment Requests page must keep reading finance_payment_requests')
  })

  test('10. the counters match their lists, view for view', () => {
    // Structural rather than restated: the sidebar counts and the list build
    // their predicates from the SAME paymentViewClauses, so they cannot narrow
    // differently.
    const counts = readFileSync(join(process.cwd(), 'src/hooks/queries/useReceivedPaymentsCounts.ts'), 'utf8')
    const view = readFileSync(join(process.cwd(), 'src/app/finance/received/ReceivedPaymentsView.tsx'), 'utf8')
    assert.ok(counts.includes('paymentViewClauses('), 'the counts must use the shared predicate')
    // REVISED (Requirement 1): the LIST no longer applies the four-view
    // classification at all — that mechanism is retired from Confirmed
    // Payments in favour of a real predicate over confirmed_allocation_status.
    // The sidebar badge hook (above) still counts the four views internally,
    // but nothing in the list narrows by them any more.
    assert.ok(!view.includes('paymentViewFilterClauses'),
      'the retired four-view mechanism must not survive in the list')
    assert.ok(view.includes("scoped.eq('confirmed_allocation_status', filters.confirmedFilter)"),
      'the list narrows Confirmed Payments by the pure allocation-ledger status instead')
    // AND THE SAME STATUS SCOPE, which is now the CONFIRMED half rather than
    // "everything except rejected". The four views classify money by where it
    // has been attributed, and a payment nobody has verified has been attributed
    // nowhere — so both the list and the badge beside it ask for the two
    // confirmed statuses, and Payments to Verify carries its own count.
    assert.ok(counts.includes('CONFIRMED_PAYMENT_STATUSES'), 'and the shared status scope')
    assert.ok(view.includes('PAYMENT_SURFACE_STATUSES[surface]'))
  })

  test('11–15 are proved in SQL, and the file says so', () => {
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
    // TWO READS NOW, BOTH BOUNDED, NEITHER PER-ROW. The second is
    // refreshOneRow's — Requirement 3's narrow post-allocation refresh, which
    // re-reads exactly the ONE payment a multi-target allocation just changed,
    // never the whole page. It is triggered by a user action, not by the
    // initial page load, and is keyed to a single id — the same bounded shape
    // as the page-load read, just for a set of exactly one.
    const reads = view.split(".from('finance_payment_allocations')").length - 1
    assert.equal(reads, 2, 'the page-load read, and refreshOneRow\'s single-payment read — nothing per-row')
    assert.ok(view.includes(".in('payment_request_id', rows.map(r => r.id))"),
      'the page-load allocation read is batched across the page, never issued per row')
    assert.ok(view.includes(".eq('payment_request_id', id)"),
      'the narrow refresh is keyed to exactly the one payment id it is refreshing')

    // And neither is inside anything that iterates rows.
    const perRow = /rows\.map\([\s\S]{0,400}?\.from\('finance_payment_allocations'\)/
    assert.ok(!perRow.test(view), 'no allocation read may sit inside a row loop')
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
  const many = summary([
    { allocationId: 'a1', kind: 'order', targetId: 'order-a', label: null, amount: '300000.00' },
    { allocationId: 'a2', kind: 'order', targetId: 'order-b', label: null, amount: '200000.00' },
    { allocationId: 'a3', kind: 'submission', targetId: 'sub-a', label: null, amount: '100000.00' },
  ])

  test('EVERY destination is shown, not just the first', () => {
    // The projection's LIMIT 1 lateral names ONE Order for its own label column;
    // the row's destinations come from the allocation table, which has them all.
    // A list that showed only the first would tell a reader their ₹6L payment
    // went to one Order.
    const links = paymentLinks({
      summary: many,
      directOrder: null,
      labels: new Map([['order-a', 'ORD-A'], ['order-b', 'ORD-B'], ['sub-a', 'PI-A']]),
      canOpenOrders: true,
    })
    assert.deepEqual(links.map(l => l.label), ['ORD-A', 'ORD-B', 'PI-A'])
  })

  test('Orders are listed before PI Drafts, in allocation order', () => {
    const links = paymentLinks({
      summary: many, directOrder: null, labels: new Map(), canOpenOrders: true,
    })
    assert.deepEqual(links.map(l => l.kind), ['order', 'order', 'submission'])
  })

  test('each destination carries its OWN share, never the payment total', () => {
    const links = paymentLinks({
      summary: many, directOrder: null, labels: new Map(), canOpenOrders: true,
    })
    assert.deepEqual(links.map(l => l.amount), ['300000.00', '200000.00', '100000.00'])
  })

  test('a viewer who may open only one of three sees one door and two placeholders', () => {
    const links = paymentLinks({
      summary: many,
      directOrder: null,
      labels: new Map([['order-b', 'ORD-B']]),
      canOpenOrders: true,
    })
    assert.deepEqual(links.map(l => l.href), [null, '/orders/order-b', null])
    assert.deepEqual(links.map(l => l.label), ['An Order', 'ORD-B', 'A PI Draft'])
    assert.deepEqual(linkCounts(links),
      { total: 3, openable: 1, hidden: 2, orders: 2, submissions: 1 })
  })
})

// ══ Every Order search on this page is race-guarded ═══════════════════════════

describe('a slow search never repaints a newer one', () => {
  const view = readFileSync(join(process.cwd(), 'src/app/finance/received/ReceivedPaymentsView.tsx'), 'utf8')

  test('the Link Order search is gone, along with the modal that held it', () => {
    // THE DEFECT this used to guard: LinkOrderModal's Order search wrote
    // whatever came back, with no token, so a slow query for "ORD" landing
    // after a fast one for "ORD-2026" replaced the narrower list under a
    // reader who had already typed past it — and that was the list an Order
    // was picked from to attach money to.
    //
    // The modal is now removed outright: linking a payment to ONE Order could
    // not express a partial attachment, a split across records, or a remaining
    // balance, so allocation replaced it. The race cannot occur because the
    // search does not exist.
    assert.equal(view.includes('function LinkOrderModal'), false,
      'the Link Order modal must not come back')
    assert.equal(view.includes(".rpc('link_finance_payment_to_order"), false,
      'and neither must the RPC call that was its submit')
  })

  test('the four surviving Order searches still carry the guard', () => {
    // Removing a call site must not quietly relax the others. The Payment
    // Request form's own selector was deleted with the four-target model
    // (20261013000000); the shared destination block that replaced it is the
    // fourth entry here and carries the same guard.
    for (const path of [
      'src/app/finance/components/PaymentEntryFields.tsx',
      'src/app/finance/received/AllocatePaymentModal.tsx',
      'src/app/finance/received/AllocateFundsModal.tsx',
      'src/app/finance/received/RecordSplitPaymentModal.tsx',
    ]) {
      const body = readFileSync(join(process.cwd(), path), 'utf8')
      assert.ok(body.includes('if (token !== searchToken.current) return'),
        `${path} must still discard a superseded search`)
      const claimed = body.indexOf('const token = ++searchToken.current')
      const checked = body.indexOf('if (token !== searchToken.current) return')
      assert.ok(claimed > -1 && claimed < checked,
        `${path} must claim the token before it re-reads it`)
    }
  })
})
