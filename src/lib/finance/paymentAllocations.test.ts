/**
 * How much of a payment has been given a home.
 *
 * WHAT THIS FILE PROVES
 * ---------------------
 * Mostly one thing, and it is a permission rule dressed as a label: Finance is
 * NEVER told "Unallocated" on the strength of an empty allocation list it was
 * not entitled to read in full. A payment and its allocations sit behind
 * different RLS policies, so a reader holding finance.view without
 * finance.view_all can be entitled to the money and not to the record of where
 * it went — and calling that "unallocated" would drop verified money into a
 * suspense queue it does not belong in.
 *
 * Also: the split arithmetic is exact, a reversed allocation is not money that
 * is spoken for, and the database's own capacity rule being violated is shown
 * rather than rounded away.
 *
 * Run:
 *   npx tsx --test src/lib/finance/paymentAllocations.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  ALLOCATION_STATE_LABEL,
  PENDING_ALLOCATION_SUMMARY,
  summarizePaymentAllocations,
  type PaymentAllocationRow,
} from './paymentAllocations'

const payment = (id: string, amount: string | number | null) => ({ id, amount })

const alloc = (over: Partial<PaymentAllocationRow> = {}): PaymentAllocationRow => ({
  id: 'alloc-1',
  payment_request_id: 'pay-1',
  allocated_amount: '250000.00',
  status: 'active',
  order_id: 'order-1',
  order_submission_id: null,
  ...over,
})

/** The one summary a call about a single payment produces. */
const only = (
  payments: Parameters<typeof summarizePaymentAllocations>[0],
  allocations: readonly PaymentAllocationRow[],
  options?: Parameters<typeof summarizePaymentAllocations>[2],
) => summarizePaymentAllocations(payments, allocations, options).get(payments[0].id)!

// ── The permission rule ───────────────────────────────────────────────────────

describe('an empty allocation list is only conclusive for a reader who sees them all', () => {
  test('a limited reader is told they cannot see, NOT that money is unallocated', () => {
    // finance.view without finance.view_all: the payment read succeeds, the
    // allocation read comes back empty, and the money may be fully allocated.
    const summary = only([payment('pay-1', '250000.00')], [], { emptyIsConclusive: false })
    assert.equal(summary.state, 'unknown')
    assert.equal(summary.allocated, null)
    assert.equal(summary.unallocated, null)
    assert.deepEqual(summary.targets, [])
  })

  test('and that is the DEFAULT — a caller must opt in to the confident answer', () => {
    // A future call site that forgets the flag gets the safe answer, not the
    // one that could put verified money into a suspense queue.
    assert.equal(only([payment('pay-1', '250000.00')], []).state, 'unknown')
  })

  test('a reader who sees every allocation IS told when money is unallocated', () => {
    // Admin or finance.view_all. This is the queue that needs somebody to act,
    // so it has to be nameable.
    const summary = only([payment('pay-1', '250000.00')], [], { emptyIsConclusive: true })
    assert.equal(summary.state, 'unallocated')
    assert.equal(summary.allocated, '0')
    assert.equal(summary.unallocated, '250000.00')
  })

  test('a failed read is unknown even for a reader who sees everything', () => {
    // A refusal or a network failure is not evidence about the money.
    const summary = only(
      [payment('pay-1', '250000.00')],
      [alloc()],
      { readable: false, emptyIsConclusive: true })
    assert.equal(summary.state, 'unknown')
    assert.deepEqual(summary.targets, [])
  })

  test('the label says whose limit it is', () => {
    // "Not visible to you" is a fact about the reader; "unknown" would read as
    // a defect in the data.
    assert.equal(ALLOCATION_STATE_LABEL.unknown, 'Not visible to you')
  })

  test('the pending placeholder is unknown, never unallocated', () => {
    // A list that painted "Unallocated" on every row while the read was in
    // flight would be telling Finance something untrue about every payment on
    // the screen, briefly.
    assert.equal(PENDING_ALLOCATION_SUMMARY('pay-1').state, 'unknown')
  })
})

// ── The arithmetic ────────────────────────────────────────────────────────────

describe('the split is exact', () => {
  test('partly allocated reports what is left', () => {
    const summary = only([payment('pay-1', '1000000.00')], [
      alloc({ id: 'a1', allocated_amount: '250000.00' }),
    ], { emptyIsConclusive: true })
    assert.equal(summary.state, 'partial')
    assert.equal(summary.allocated, '250000.00')
    assert.equal(summary.unallocated, '750000.00')
  })

  test('several allocations sum without float drift', () => {
    const summary = only([payment('pay-1', '0.60')], [
      alloc({ id: 'a1', allocated_amount: '0.10' }),
      alloc({ id: 'a2', allocated_amount: '0.20' }),
      alloc({ id: 'a3', allocated_amount: '0.30' }),
    ], { emptyIsConclusive: true })
    assert.equal(summary.allocated, '0.60')
    assert.equal(summary.state, 'full')
    assert.equal(summary.unallocated, '0')
  })

  test('fully allocated leaves nothing over', () => {
    const summary = only([payment('pay-1', '250000.00')], [
      alloc({ allocated_amount: '250000.00' }),
    ], { emptyIsConclusive: true })
    assert.equal(summary.state, 'full')
    assert.equal(summary.unallocated, '0')
  })

  test('a reversed allocation is not money that is spoken for', () => {
    // The claim was withdrawn. It stays in the Finance trail, where its reason
    // is, and the money is available again.
    const summary = only([payment('pay-1', '250000.00')], [
      alloc({ id: 'a-dead', allocated_amount: '250000.00', status: 'reversed' }),
    ], { emptyIsConclusive: true })
    assert.equal(summary.state, 'unallocated')
    assert.equal(summary.allocated, '0')
    assert.deepEqual(summary.targets, [])
  })

  test('over-allocation is SHOWN, not rounded into "fully"', () => {
    // The database's capacity trigger refuses this, so seeing it means
    // something is wrong and hiding it would be the worse failure.
    const summary = only([payment('pay-1', '100.00')], [
      alloc({ allocated_amount: '150.00' }),
    ], { emptyIsConclusive: true })
    assert.equal(summary.state, 'over')
    assert.equal(summary.allocated, '150.00')
    assert.equal(summary.unallocated, '0')
  })

  test('an unreadable payment amount yields no comparison but still lists targets', () => {
    const summary = only([payment('pay-1', null)], [
      alloc({ allocated_amount: '250000.00' }),
    ], { emptyIsConclusive: true })
    assert.equal(summary.state, 'unknown')
    assert.equal(summary.allocated, '250000.00')
    assert.equal(summary.unallocated, null)
    assert.equal(summary.targets.length, 1)
  })
})

// ── The targets ───────────────────────────────────────────────────────────────

describe('where the money went', () => {
  test('an Order allocation and a PI allocation are told apart', () => {
    const summary = only([payment('pay-1', '500.00')], [
      alloc({ id: 'a1', allocated_amount: '200.00', order_id: 'order-1', order_submission_id: null }),
      alloc({ id: 'a2', allocated_amount: '300.00', order_id: null, order_submission_id: 'sub-1' }),
    ], { emptyIsConclusive: true })

    assert.equal(summary.targets.length, 2)
    assert.equal(summary.targets[0].kind, 'order')
    assert.equal(summary.targets[0].targetId, 'order-1')
    assert.equal(summary.targets[1].kind, 'submission')
    assert.equal(summary.targets[1].targetId, 'sub-1')
  })

  test('a target the reader cannot name still shows that the money is spoken for', () => {
    // Whether money is allocated is derived from the ALLOCATION, so a reader who
    // may not open the Order loses only its number — the same choice the
    // finance_received_payments projection makes.
    const summary = only([payment('pay-1', '500.00')], [alloc({ allocated_amount: '500.00' })],
      { emptyIsConclusive: true })
    assert.equal(summary.targets[0].label, null)
    assert.equal(summary.state, 'full')
  })

  test('a readable target is named', () => {
    const summary = only([payment('pay-1', '500.00')], [alloc({ allocated_amount: '500.00' })], {
      emptyIsConclusive: true,
      labels: new Map([['order-1', 'ORD-2026-0007']]),
    })
    assert.equal(summary.targets[0].label, 'ORD-2026-0007')
  })

  test('an allocation naming nothing is skipped rather than shown pointing nowhere', () => {
    // The one-target CHECK makes this impossible; a corrupt row must not render
    // a dead link.
    const summary = only([payment('pay-1', '500.00')], [
      alloc({ allocated_amount: '500.00', order_id: null, order_submission_id: null }),
    ], { emptyIsConclusive: true })
    assert.deepEqual(summary.targets, [])
    // The money is still counted — it is allocated, whatever the row names.
    assert.equal(summary.allocated, '500.00')
  })
})

// ── Grouping ──────────────────────────────────────────────────────────────────

describe('one bounded read, many payments', () => {
  test('every payment asked about gets an answer, including one with no rows', () => {
    // A payment missing from the map would render as a blank cell, which reads
    // as a bug rather than as an answer.
    const summaries = summarizePaymentAllocations(
      [payment('pay-1', '100.00'), payment('pay-2', '200.00'), payment('pay-3', '300.00')],
      [
        alloc({ id: 'a1', payment_request_id: 'pay-1', allocated_amount: '100.00' }),
        alloc({ id: 'a2', payment_request_id: 'pay-3', allocated_amount: '150.00' }),
      ],
      { emptyIsConclusive: true })

    assert.equal(summaries.size, 3)
    assert.equal(summaries.get('pay-1')!.state, 'full')
    assert.equal(summaries.get('pay-2')!.state, 'unallocated')
    assert.equal(summaries.get('pay-3')!.state, 'partial')
  })

  test('an allocation for a payment nobody asked about is ignored', () => {
    const summaries = summarizePaymentAllocations(
      [payment('pay-1', '100.00')],
      [alloc({ id: 'a-other', payment_request_id: 'pay-999', allocated_amount: '100.00' })],
      { emptyIsConclusive: true })

    assert.equal(summaries.size, 1)
    assert.equal(summaries.get('pay-1')!.state, 'unallocated')
  })

  test('no payments asked about is an empty map, not a throw', () => {
    assert.equal(summarizePaymentAllocations([], [alloc()]).size, 0)
  })
})

// ── The direct-link fallback, so Finance and the Orders agree ────────────────

describe('a linked payment with no allocations is not free money', () => {
  test('it reads FULLY allocated, not Unallocated', () => {
    // Worked example A. The Order counts this payment in full through the
    // canonical fallback, so calling it "Unallocated" here would have the same
    // rupees committed to an Order AND sitting in Finance's suspense queue —
    // the conservation law broken across two modules.
    const summary = only(
      [{ id: 'pay-1', amount: '1000000.00', hasDirectLink: true }], [],
      { emptyIsConclusive: true })
    assert.equal(summary.state, 'full')
    assert.equal(summary.unallocated, '0')
  })

  test('without a direct link it is genuinely unallocated', () => {
    const summary = only(
      [{ id: 'pay-1', amount: '1000000.00', hasDirectLink: false }], [],
      { emptyIsConclusive: true })
    assert.equal(summary.state, 'unallocated')
    assert.equal(summary.unallocated, '1000000.00')
  })

  test('once an allocation exists the link stops mattering', () => {
    // Worked example B: allocations are authoritative the moment any exists,
    // even when the link names the same Order. ₹5L of ₹10L allocated leaves ₹5L
    // free — the legacy ₹10L is not counted.
    const summary = only(
      [{ id: 'pay-1', amount: '1000000.00', hasDirectLink: true }],
      [alloc({ payment_request_id: 'pay-1', allocated_amount: '500000.00' })],
      { emptyIsConclusive: true })
    assert.equal(summary.state, 'partial')
    assert.equal(summary.allocated, '500000.00')
    assert.equal(summary.unallocated, '500000.00')
  })

  test('a reversed-only allocation falls back to the link', () => {
    // Worked example E: a withdrawn claim does not suppress the direct linkage.
    const summary = only(
      [{ id: 'pay-1', amount: '1000000.00', hasDirectLink: true }],
      [alloc({ payment_request_id: 'pay-1', allocated_amount: '400000.00', status: 'reversed' })],
      { emptyIsConclusive: true })
    assert.equal(summary.state, 'full')
    assert.equal(summary.unallocated, '0')
  })

  test('and a reader who cannot see allocations is still told so', () => {
    // The fallback must not override the safety rule: an empty list that is not
    // conclusive stays "unknown", link or no link.
    const summary = only(
      [{ id: 'pay-1', amount: '1000000.00', hasDirectLink: true }], [],
      { emptyIsConclusive: false })
    assert.equal(summary.state, 'unknown')
  })
})
