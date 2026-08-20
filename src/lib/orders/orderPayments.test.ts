/**
 * PI-to-Order payment continuity, on the Order's own screen.
 *
 * WHAT THIS FILE PROVES
 * ---------------------
 * When an approved PI becomes a Confirmed Order, its ALLOCATIONS move onto the
 * Order — the same rows, the same ids, the same payments — and no payment row is
 * created, copied or re-linked. An Order screen that read only
 * finance_payment_requests.order_id would therefore show nothing for money the
 * client genuinely paid, and the business would conclude it was lost.
 *
 * These tests cover the join that prevents that, and the two things it must
 * never do: invent a payment, or count one twice.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderPayments.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  isVerifiedPaymentStatus,
  mergeOrderPayments,
  receivedFromPayments,
  type OrderAllocationRow,
} from './orderPayments'

/** A payment carrying the LEGACY order link, exactly as the Order screen reads it. */
const linked = (over: Partial<{
  id: string; client_name: string; amount: string; payment_date: string
  payment_mode: string; order_number: string | null; status: string
}> = {}) => ({
  id: 'pay-legacy',
  client_name: 'Kalyan Interiors',
  amount: '400000.00',
  payment_date: '2026-08-01',
  payment_mode: 'bank_transfer',
  order_number: null,
  status: 'approved_linked',
  ...over,
})

/** An allocation that MOVED onto this Order when its PI was approved. */
type AllocationOverride = Omit<Partial<OrderAllocationRow>, 'payment'> & {
  payment?: Partial<NonNullable<OrderAllocationRow['payment']>>
}

const allocation = (over: AllocationOverride = {}): OrderAllocationRow => ({
  id: 'alloc-1',
  allocated_amount: '250000.00',
  status: 'active',
  ...over,
  payment: {
    id: 'pay-from-pi',
    client_name: 'Kalyan Interiors',
    amount: '250000.00',
    payment_date: '2026-08-05',
    payment_mode: 'upi',
    order_number: null,
    status: 'approved_unlinked',
    ...(over.payment ?? {}),
  },
})

// ── The continuity itself ─────────────────────────────────────────────────────

describe('an Order sees the payments its PI collected', () => {
  test('a moved allocation puts its payment on the Order’s list', () => {
    const rows = mergeOrderPayments([], [allocation()])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'pay-from-pi', 'the SAME payment id — nothing was copied')
    assert.equal(rows[0].viaAllocation, true)
  })

  test('the payment id is unchanged, so its proof and history follow it', () => {
    // The whole point of MOVING rather than copying: one payment row, one
    // verification, one proof, one Finance trail, findable by one id.
    const rows = mergeOrderPayments([], [allocation({ payment: { id: 'pay-777' } })])
    assert.equal(rows[0].id, 'pay-777')
  })

  test('the Order is credited with the ALLOCATED figure, not the whole payment', () => {
    // A payment may legitimately be split across targets. Crediting the full
    // ledger amount would give this Order money that belongs elsewhere.
    const rows = mergeOrderPayments([], [
      allocation({ allocated_amount: '100000.00', payment: { amount: '250000.00' } }),
    ])
    assert.equal(rows[0].amount, 250000, 'the ledger amount is still reported')
    assert.equal(rows[0].allocatedAmount, 100000, 'but only its share counts')
    assert.equal(receivedFromPayments(rows), 100000)
  })

  test('a REVERSED allocation is not money this Order has', () => {
    const rows = mergeOrderPayments([], [allocation({ status: 'reversed' })])
    assert.deepEqual(rows, [])
  })

  test('an allocation with no readable payment is skipped, never half-drawn', () => {
    const rows = mergeOrderPayments([], [{ ...allocation(), payment: null }])
    assert.deepEqual(rows, [])
  })
})

// ── No double counting ────────────────────────────────────────────────────────

describe('one payment is one row, however many ways it reaches the Order', () => {
  test('a legacy-linked payment that also carries an allocation appears once', () => {
    // Phase 1 backfilled an allocation for every approved_linked payment, so
    // this is the ORDINARY case for a legacy Order, not an edge one.
    const rows = mergeOrderPayments(
      [linked({ id: 'pay-A' })],
      [allocation({ id: 'alloc-A', payment: { id: 'pay-A' } })],
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0].viaAllocation, false, 'the legacy row wins, with its own amount')
    assert.equal(receivedFromPayments(rows), 400000)
  })

  test('two allocations naming the same payment still yield one row', () => {
    const rows = mergeOrderPayments([], [
      allocation({ id: 'alloc-1' }),
      allocation({ id: 'alloc-2' }),
    ])
    assert.equal(rows.length, 1)
  })

  test('distinct payments are all kept, newest first', () => {
    const rows = mergeOrderPayments(
      [linked({ id: 'pay-A', payment_date: '2026-08-01' })],
      [
        allocation({ id: 'alloc-B', payment: { id: 'pay-B', payment_date: '2026-08-09' } }),
        allocation({ id: 'alloc-C', payment: { id: 'pay-C', payment_date: '2026-08-04' } }),
      ],
    )
    assert.deepEqual(rows.map(r => r.id), ['pay-B', 'pay-C', 'pay-A'])
  })

  test('a payment with no date is kept and sorts last — it is still money', () => {
    const rows = mergeOrderPayments([], [
      allocation({ id: 'a1', payment: { id: 'pay-dated', payment_date: '2026-08-04' } }),
      allocation({ id: 'a2', payment: { id: 'pay-undated', payment_date: null } }),
    ])
    assert.deepEqual(rows.map(r => r.id), ['pay-dated', 'pay-undated'])
  })
})

// ── What counts as received ───────────────────────────────────────────────────

describe('only VERIFIED payment counts as received', () => {
  test('the two verified statuses mirror the database rule exactly', () => {
    assert.equal(isVerifiedPaymentStatus('approved_unlinked'), true)
    assert.equal(isVerifiedPaymentStatus('approved_linked'), true)
    for (const status of ['pending_approval', 'needs_clarification', 'rejected', '', null]) {
      assert.equal(isVerifiedPaymentStatus(status), false, `${status} must not count`)
    }
    const sql = readFileSync(
      'supabase/migrations/20260918000000_finance_payment_allocations.sql', 'utf8')
    assert.ok(sql.includes("p_status in ('approved_unlinked', 'approved_linked')"),
      'finance_payment_status_is_verified() must say the same two')
  })

  test('unverified money is listed but not counted', () => {
    const rows = mergeOrderPayments([], [
      allocation({ id: 'a1', payment: { id: 'pay-pending', status: 'pending_approval' } }),
      allocation({ id: 'a2', payment: { id: 'pay-ok', status: 'approved_unlinked' },
                   allocated_amount: '90000.00' }),
    ])
    assert.equal(rows.length, 2, 'both are shown — the history is the point')
    assert.equal(receivedFromPayments(rows), 90000, 'but only one is money')
  })

  test('a rejected payment counts as nothing', () => {
    const rows = mergeOrderPayments([], [
      allocation({ payment: { id: 'pay-x', status: 'rejected' } }),
    ])
    assert.equal(receivedFromPayments(rows), 0)
  })

  test('a numeric arriving as a string keeps its value', () => {
    // PostgREST sends `numeric` as a string precisely so JSON's double cannot
    // round it. Parsing happens here, once, at the display boundary.
    const rows = mergeOrderPayments([], [
      allocation({ allocated_amount: '1234567.89' }),
    ])
    assert.equal(rows[0].allocatedAmount, 1234567.89)
  })
})

// ── The reads themselves ──────────────────────────────────────────────────────

describe('the Order screen reads, and never writes, the payment tables', () => {
  const page = readFileSync('src/app/orders/[id]/page.tsx', 'utf8')

  test('both reads are anchored to this one Order', () => {
    assert.ok(page.includes(".from('finance_payment_requests')"))
    assert.ok(page.includes(".from('finance_payment_allocations')"))
    const allocRead = page.slice(page.indexOf(".from('finance_payment_allocations')"), 
                                 page.indexOf('setPayments(mergeOrderPayments('))
    assert.ok(allocRead.includes(".eq('order_id', id)"),
      'the allocation read is bounded by the Order, never unbounded')
    assert.ok(allocRead.includes(".eq('status', 'active')"))
  })

  test('the legacy link read is untouched, so a converted Order Request is unaffected', () => {
    assert.ok(page.includes(".select('id, client_name, amount, payment_date, payment_mode, order_number, status')"))
    assert.ok(page.includes(".eq('order_id', id)"))
    assert.ok(page.includes('finance_payment_allocations_payment_fk'),
      'the embed names the foreign key, so it cannot become ambiguous')
  })

  test('the merge is the shared one, not a second copy on the page', () => {
    assert.ok(page.includes('mergeOrderPayments('))
    assert.ok(page.includes('receivedFromPayments(payments)'))
    assert.ok(!/payments\s*\n?\s*\.filter\(p => p\.status/.test(page),
      'the old inline "approved_linked only" sum must be gone')
  })

  test('no write reaches either payment table from this screen', () => {
    const reads = page.slice(page.indexOf(".from('finance_payment_allocations')"))
    for (const call of ['.insert(', '.update(', '.upsert(', '.delete(']) {
      assert.ok(!reads.slice(0, 800).includes(call),
        `${call} must not appear beside the allocation read`)
    }
  })
})
