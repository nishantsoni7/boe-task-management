/**
 * ONE PAYMENT, SEVERAL ORDERS — THE LINK, END TO END.
 *
 * A customer sends one transfer covering three pieces of business. There is ONE
 * payment row, and the relationship to each Order is an ALLOCATION. This file
 * pins the properties that make that relationship trustworthy on both screens:
 *
 *   1. the payment is never duplicated per Order — Finance shows one row with
 *      several allocations, and each Order shows one payment carrying its own
 *      share;
 *   2. each Order is credited with ITS share and no more, and can say that part
 *      of the payment is elsewhere without claiming to know where;
 *   3. a reader who may not open a linked Order loses its NUMBER and nothing
 *      else — never its id, never its client, never its amount;
 *   4. a reader who cannot see every allocation is told so, and is given NO
 *      definite available balance, because an incomplete sum understates
 *      attribution and therefore OVERSTATES what is free to spend again;
 *   5. a reversal stays in the trail and counts for nothing.
 *
 * No new module is under test here. These are the deployed helpers — the
 * relationship already lives in finance_payment_allocations and PR #49's
 * canonical attribution rule — asked the questions the common-payment
 * requirement actually asks.
 *
 * Offline and pure.
 *
 * Run:
 *   npx tsx --test src/lib/finance/commonPaymentLinkage.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  ALLOCATION_STATE_LABEL,
  summarizePaymentAllocations,
  type PaymentAllocationRow,
} from './paymentAllocations'
import { buildOrderFinancePosition, withExactAmounts } from './orderFinancePosition'
import { mergeOrderPayments, type OrderAllocationRow } from '@/lib/orders/orderPayments'

// ── One real payment of ₹10,00,000, covering two Orders and a PI Draft ───────

const PAYMENT = { id: 'pay-1', amount: '1000000.00' }

const alloc = (over: Partial<PaymentAllocationRow>): PaymentAllocationRow => ({
  id: 'a-1',
  payment_request_id: PAYMENT.id,
  allocated_amount: '0.00',
  status: 'active',
  order_id: null,
  order_submission_id: null,
  ...over,
})

const THE_ALLOCATIONS: PaymentAllocationRow[] = [
  alloc({ id: 'a-1', allocated_amount: '400000.00', order_id: 'order-A' }),
  alloc({ id: 'a-2', allocated_amount: '350000.00', order_id: 'order-B' }),
  alloc({ id: 'a-3', allocated_amount: '250000.00', order_submission_id: 'pi-C' }),
]

/** What the Order screen's own anchored read returns, for one Order. */
const orderAllocation = (allocated: string, status = 'approved_unlinked'): OrderAllocationRow => ({
  id: `oa-${allocated}`,
  allocated_amount: allocated,
  status: 'active',
  payment: {
    id: PAYMENT.id,
    client_name: 'Kalyan Interiors',
    amount: PAYMENT.amount,
    payment_date: '2026-08-05',
    payment_mode: 'bank_transfer',
    order_number: null,
    status,
  },
})

function orderPosition(allocated: string, orderValue: string) {
  const allocations = [orderAllocation(allocated)]
  const merged = mergeOrderPayments([], allocations)
  // THE WHOLE-PAYMENT FACT, as payment_active_allocation_totals() supplies it.
  // This Order reads only the allocation naming IT — the other 6,00,000 is on
  // records RLS would not show it — so the total has to arrive separately, and
  // it is what makes the row a split rather than a payment this Order owns.
  const rows = withExactAmounts(merged, {
    linked: [],
    allocations,
    activeTotals: new Map([[PAYMENT.id, PAYMENT.amount]]),
  })
  return { rows, summary: buildOrderFinancePosition(rows, orderValue) }
}

describe('Finance shows the common payment ONCE, with every allocation on it', () => {
  const summaries = summarizePaymentAllocations(
    [PAYMENT], THE_ALLOCATIONS,
    {
      emptyIsConclusive: true,
      labels: new Map([['order-A', '0041'], ['order-B', '0042'], ['pi-C', 'PI-889']]),
    })

  test('one summary for one payment, however many records it names', () => {
    assert.equal(summaries.size, 1, 'a second summary would be a duplicated payment')
  })

  test('every allocation is listed, with its own amount and its own target', () => {
    const summary = summaries.get(PAYMENT.id)
    assert.ok(summary)
    assert.equal(summary.targets.length, 3)
    assert.deepEqual(
      summary.targets.map(t => [t.kind, t.targetId, t.label, t.amount]),
      [
        ['order', 'order-A', '0041', '400000.00'],
        ['order', 'order-B', '0042', '350000.00'],
        ['submission', 'pi-C', 'PI-889', '250000.00'],
      ])
  })

  test('the allocations reconcile to the payment, so the panel visibly adds up', () => {
    const summary = summaries.get(PAYMENT.id)
    assert.equal(summary?.allocated, '1000000.00')
    assert.equal(summary?.unallocated, '0')
    assert.equal(summary?.state, 'full')
  })

  test('a partly spent common payment keeps a real available balance', () => {
    const partial = summarizePaymentAllocations([PAYMENT], THE_ALLOCATIONS.slice(0, 2),
      { emptyIsConclusive: true })
    assert.equal(partial.get(PAYMENT.id)?.state, 'partial')
    assert.equal(partial.get(PAYMENT.id)?.unallocated, '250000.00')
  })
})

describe('each linked Order is credited with its own share, and says so', () => {
  test('Order A takes 400,000 of a 1,000,000 payment and marks the row a split', () => {
    const { rows, summary } = orderPosition('400000.00', '600000.00')
    assert.equal(rows.length, 1, 'one payment, one row — never one row per allocation')
    assert.equal(rows[0].exactAllocatedAmount, '400000.00')
    assert.equal(rows[0].exactAmount, '1000000.00')
    assert.equal(rows[0].isPartialShare, true)
    assert.equal(summary.verified, '400000.00')
    assert.equal(summary.pendingBalance, '200000.00')
  })

  test('Order B takes 350,000 of the SAME payment, independently', () => {
    const { summary } = orderPosition('350000.00', '350000.00')
    assert.equal(summary.verified, '350000.00')
    assert.equal(summary.fullyPaid, true)
  })

  test('the Order says part of the payment is elsewhere WITHOUT claiming where', () => {
    // This screen reads only THIS Order's allocations. Naming the rest
    // "unallocated" would be a statement about records the reader has not been
    // shown — and about money that is in fact on another Order.
    const { summary } = orderPosition('400000.00', '600000.00')
    assert.deepEqual(summary.splitPayments, [{ paymentId: 'pay-1', elsewhere: '600000.00' }])
    const asText = JSON.stringify(summary.splitPayments)
    assert.doesNotMatch(asText, /order-B|pi-C|unallocated/i)
  })

  test('the two Orders together never claim more than the payment', () => {
    const a = orderPosition('400000.00', '600000.00').summary.verified
    const b = orderPosition('350000.00', '350000.00').summary.verified
    assert.equal(Number(a) + Number(b) <= Number(PAYMENT.amount), true)
  })
})

describe('a reader who may not open a linked record loses its NAME and nothing else', () => {
  // Labels are resolved from a bounded read under the reader's own RLS: a
  // record they may not open simply is not in the map.
  const summaries = summarizePaymentAllocations(
    [PAYMENT], THE_ALLOCATIONS,
    { emptyIsConclusive: true, labels: new Map([['order-A', '0041']]) })

  const summary = summaries.get(PAYMENT.id)

  test('the hidden allocations are still counted, so the arithmetic stays honest', () => {
    assert.equal(summary?.allocated, '1000000.00')
    assert.equal(summary?.state, 'full')
  })

  test('but neither hidden record is NAMED', () => {
    const labels = summary?.targets.map(t => t.label)
    assert.deepEqual(labels, ['0041', null, null])
  })

  test('the amount of a hidden record is shown — it is this payment’s own money', () => {
    // The reader is entitled to know their payment is spoken for and by how
    // much; what they are not entitled to is WHICH customer's Order took it.
    assert.equal(summary?.targets[1].amount, '350000.00')
  })

  test('the label is the ONLY thing withheld, and the kind is all a door gets', () => {
    // The rendering rule that goes with this: a target with no label is written
    // as its kind alone and is never a link. Pinned here as data — a target
    // that carries no label carries no name anywhere in its own row.
    const hidden = summary?.targets[1]
    assert.equal(hidden?.label, null)
    assert.equal(hidden?.kind, 'order')
  })
})

describe('incomplete visibility suppresses a definite available balance', () => {
  test('a reader who cannot see every allocation is told so, and gets NO figure', () => {
    // An incomplete sum understates attribution, which OVERSTATES the balance,
    // and that is how the same rupees get allocated twice.
    const summaries = summarizePaymentAllocations([PAYMENT], [], { emptyIsConclusive: false })
    const summary = summaries.get(PAYMENT.id)
    assert.equal(summary?.state, 'unknown')
    assert.equal(summary?.unallocated, null)
    assert.equal(summary?.allocated, null)
    assert.deepEqual(summary?.targets, [])
  })

  test('and the word for it is about the reader, not about the money', () => {
    assert.equal(ALLOCATION_STATE_LABEL.unknown, 'Not visible to you')
    assert.notEqual(ALLOCATION_STATE_LABEL.unknown, ALLOCATION_STATE_LABEL.unallocated)
  })

  test('a failed allocation read is never evidence that money is free', () => {
    const summaries = summarizePaymentAllocations([PAYMENT], THE_ALLOCATIONS,
      { readable: false, emptyIsConclusive: true })
    assert.equal(summaries.get(PAYMENT.id)?.state, 'unknown')
    assert.equal(summaries.get(PAYMENT.id)?.unallocated, null)
  })
})

describe('correction and reversal keep the trail', () => {
  test('a reversed allocation counts for nothing and frees its share again', () => {
    const reversed = [
      THE_ALLOCATIONS[0],
      { ...THE_ALLOCATIONS[1], status: 'reversed' },
      THE_ALLOCATIONS[2],
    ]
    const summary = summarizePaymentAllocations([PAYMENT], reversed, { emptyIsConclusive: true })
      .get(PAYMENT.id)

    assert.equal(summary?.allocated, '650000.00')
    assert.equal(summary?.unallocated, '350000.00')
    assert.equal(summary?.state, 'partial')
    assert.equal(summary?.targets.length, 2, 'a withdrawn claim is not a live destination')
  })

  test('the Order it was reversed against no longer counts it', () => {
    // mergeOrderPayments drops a reversed allocation, so this Order's list is
    // empty and its position is nil — the money is back on the payment, where
    // the reversal and its reason stay readable forever.
    const reversedHere = [{ ...orderAllocation('350000.00'), status: 'reversed' }]
    const merged = mergeOrderPayments([], reversedHere)
    const rows = withExactAmounts(merged, {
      linked: [], allocations: reversedHere,
      activeTotals: new Map([[PAYMENT.id, '650000.00']]),
    })
    const summary = buildOrderFinancePosition(rows, '350000.00')
    assert.equal(summary.verified, '0')
    assert.equal(summary.fullyPaid, false)
  })
})
