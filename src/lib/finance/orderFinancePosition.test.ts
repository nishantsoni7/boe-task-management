/**
 * The Confirmed Order's finance position.
 *
 * WHAT THIS FILE PROVES
 * ---------------------
 * The three defects this module was written to close, each pinned by a test that
 * fails against the old behaviour:
 *
 *   1. THE ORDER AND ITS PI AGREE. The same money summed here produces the same
 *      string pi_submission_payment_summary() produces in `numeric`.
 *   2. RECEIVED, VERIFIED AND AWAITING ARE THREE FIGURES. Money the client has
 *      sent that Finance has not yet looked at is no longer invisible, and is
 *      never silently added to the verified total either.
 *   3. THE TABLE RECONCILES WITH THE SUMMARY. A payment split across two Orders
 *      contributes only this Order's share to both the tile and the row.
 *
 * Plus the rules that must not drift: a reversed allocation is not this Order's
 * money, a rejected payment counts in nothing, and an unreadable figure is left
 * out of a total rather than counted as zero.
 *
 * Run:
 *   npx tsx --test src/lib/finance/orderFinancePosition.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { mergeOrderPayments, type OrderAllocationRow } from '@/lib/orders/orderPayments'
import { piPaymentStatusLabel } from './piPaymentView'
import {
  buildOrderFinancePosition,
  progressWidth,
  withExactAmounts,
  type OrderFinancePaymentRow,
} from './orderFinancePosition'

// ── Fixtures ──────────────────────────────────────────────────────────────────
// Shaped exactly as the Order detail page's two anchored reads return them:
// `numeric` as a STRING, because that is what PostgREST sends.

type LinkedRow = {
  id: string
  client_name: string | null
  amount: string | number | null
  payment_date: string | null
  payment_mode: string | null
  order_number: string | null
  status: string
}

const linked = (over: Partial<LinkedRow> = {}): LinkedRow => ({
  id: 'pay-legacy',
  client_name: 'Kalyan Interiors',
  amount: '400000.00',
  payment_date: '2026-08-01',
  payment_mode: 'bank_transfer',
  order_number: 'ORD-2026-0007',
  status: 'approved_linked',
  ...over,
})

const allocation = (over: {
  id?: string
  allocated_amount?: string | number | null
  status?: string
  paymentId?: string
  paymentAmount?: string | number | null
  paymentStatus?: string
} = {}): OrderAllocationRow => ({
  id: over.id ?? 'alloc-1',
  allocated_amount: over.allocated_amount ?? '250000.00',
  status: over.status ?? 'active',
  payment: {
    id: over.paymentId ?? 'pay-pi',
    client_name: 'Kalyan Interiors',
    amount: over.paymentAmount ?? '250000.00',
    payment_date: '2026-08-05',
    payment_mode: 'upi',
    order_number: null,
    status: over.paymentStatus ?? 'approved_unlinked',
  },
})

/** The whole pipeline the Order page runs: merge, then re-read exact amounts. */
function position(
  linkedRows: readonly LinkedRow[],
  allocations: readonly OrderAllocationRow[],
  orderValue: string | number | null,
) {
  const merged = mergeOrderPayments(
    linkedRows as Parameters<typeof mergeOrderPayments>[0],
    allocations,
  )
  const rows = withExactAmounts(merged, { linked: linkedRows, allocations })
  return { rows, summary: buildOrderFinancePosition(rows, orderValue) }
}

// ── 1. The Order and its PI agree ─────────────────────────────────────────────

describe('the Order agrees with the PI it was approved from', () => {
  test('a set of allocations whose float sum is wrong totals exactly', () => {
    // Three payments in paise that binary floating point cannot add. The
    // database sums these in `numeric` on the PI card; the Order must print the
    // same string, or the same money reads differently on two screens.
    const allocations = [
      allocation({ id: 'a1', paymentId: 'p1', allocated_amount: '0.10', paymentAmount: '0.10' }),
      allocation({ id: 'a2', paymentId: 'p2', allocated_amount: '0.20', paymentAmount: '0.20' }),
      allocation({ id: 'a3', paymentId: 'p3', allocated_amount: '0.30', paymentAmount: '0.30' }),
    ]
    const { summary } = position([], allocations, '1.00')

    assert.equal(summary.verified, '0.60')

    // The old path — Number() and + over the same rows — does not produce 0.6.
    const floatTotal = allocations.reduce((sum, a) => sum + Number(a.allocated_amount), 0)
    assert.notEqual(String(floatTotal), '0.6')
  })

  test('a hundred paise-level allocations stay exact', () => {
    const allocations = Array.from({ length: 100 }, (_, i) =>
      allocation({ id: `a${i}`, paymentId: `p${i}`, allocated_amount: '0.07', paymentAmount: '0.07' }))
    const { summary } = position([], allocations, '10.00')
    assert.equal(summary.verified, '7.00')
  })

  test('the verified percentage truncates exactly as the gate does', () => {
    // 39.999% of the Order value. Rounded it would print 40% beside a balance
    // that is not nought; truncated it prints 39.99 and the screen is coherent.
    const { summary } = position(
      [linked({ amount: '399990.00', status: 'approved_linked' })], [], '1000000.00')
    assert.equal(summary.verifiedPercent, '39.99')
    assert.equal(summary.fullyPaid, false)
  })
})

// ── 2. Received, verified and awaiting are three separate figures ─────────────

describe('the three states of money are three separate figures', () => {
  test('money awaiting verification is visible, and is NOT verified money', () => {
    // The defect: an Order's summary counted only verified money but called it
    // "Received", so a payment the client had genuinely made and Finance had not
    // yet reached did not exist on this screen at all.
    const { summary } = position(
      [
        linked({ id: 'p-verified', amount: '400000.00', status: 'approved_linked' }),
        linked({ id: 'p-waiting',  amount: '100000.00', status: 'pending_approval' }),
      ],
      [], '1000000.00')

    assert.equal(summary.verified, '400000.00')
    assert.equal(summary.awaitingVerification, '100000.00')
    assert.equal(summary.received, '500000.00')
    // The balance is measured against VERIFIED money — the figure the approval
    // gate uses. Unverified money does not reduce what is still owed.
    assert.equal(summary.pendingBalance, '600000.00')
    assert.equal(summary.verifiedPercent, '40.00')
    assert.equal(summary.receivedPercent, '50.00')
  })

  test('needs_clarification counts as awaiting, exactly as the database does', () => {
    const { summary } = position(
      [linked({ amount: '100000.00', status: 'needs_clarification' })], [], '1000000.00')
    assert.equal(summary.awaitingVerification, '100000.00')
    assert.equal(summary.verified, '0')
    assert.equal(summary.counts.awaiting, 1)
  })

  test('approved_unlinked is VERIFIED money — a PI payment is not lesser money', () => {
    // Whether a verified payment also carries a legacy order_id is a Finance
    // bookkeeping detail and says nothing about whether the client paid.
    const { summary } = position([], [allocation({ paymentStatus: 'approved_unlinked' })], '1000000.00')
    assert.equal(summary.verified, '250000.00')
    assert.equal(summary.awaitingVerification, '0')
  })

  test('a rejected payment counts in nothing but is still listed', () => {
    const { rows, summary } = position(
      [
        linked({ id: 'p-ok', amount: '400000.00', status: 'approved_linked' }),
        linked({ id: 'p-no', amount: '999999.00', status: 'rejected' }),
      ],
      [], '1000000.00')

    assert.equal(summary.verified, '400000.00')
    assert.equal(summary.awaitingVerification, '0')
    assert.equal(summary.rejected, '999999.00')
    assert.equal(summary.received, '400000.00')
    // Listed, so a reader can see the refusal happened.
    assert.equal(rows.length, 2)
    assert.equal(summary.counts.rejected, 1)
  })

  test('an unrecognised status is counted in no total and is still shown', () => {
    const { rows, summary } = position(
      [linked({ amount: '50000.00', status: 'some_future_status' })], [], '1000000.00')
    assert.equal(summary.verified, '0')
    assert.equal(summary.awaitingVerification, '0')
    assert.equal(summary.rejected, '0')
    assert.equal(rows.length, 1)
    assert.equal(summary.counts.total, 1)
  })
})

// ── 3. The table reconciles with the summary ─────────────────────────────────

describe('a split payment credits this Order with only its own share', () => {
  test('the row carries the SHARE, not the ledger amount', () => {
    // ₹1,000,000 arrived; ₹250,000 of it is allocated to this Order. The old
    // table printed ₹1,000,000 in the Amount column beside a tile that said
    // ₹250,000, and a reader adding the column by eye got a different total.
    const { rows, summary } = position(
      [], [allocation({ allocated_amount: '250000.00', paymentAmount: '1000000.00' })], '500000.00')

    assert.equal(rows[0].exactAllocatedAmount, '250000.00')
    assert.equal(rows[0].exactAmount, '1000000.00')
    assert.equal(rows[0].isPartialShare, true)
    assert.equal(summary.verified, '250000.00')

    // And the screen can say where the rest went — without claiming it is
    // unallocated, which this Order cannot know.
    assert.deepEqual(summary.splitPayments, [{ paymentId: 'pay-pi', elsewhere: '750000.00' }])
  })

  test('a legacy linked payment is wholly this Order’s and is never marked split', () => {
    const { rows, summary } = position([linked({ amount: '400000.00' })], [], '1000000.00')
    assert.equal(rows[0].exactAllocatedAmount, '400000.00')
    assert.equal(rows[0].isPartialShare, false)
    assert.deepEqual(summary.splitPayments, [])
  })

  test('an allocation for the payment’s whole amount is not a split', () => {
    const { rows, summary } = position(
      [], [allocation({ allocated_amount: '250000.00', paymentAmount: '250000.00' })], '500000.00')
    assert.equal(rows[0].isPartialShare, false)
    assert.deepEqual(summary.splitPayments, [])
  })

  test('several allocations of one payment onto this Order sum through the merge’s first row', () => {
    // mergeOrderPayments de-duplicates by payment id and keeps the first row it
    // sees. withExactAmounts must describe THAT row — reading a later allocation
    // would annotate a row the list is not showing.
    const { rows } = position([], [
      allocation({ id: 'a1', paymentId: 'p1', allocated_amount: '100.00', paymentAmount: '500.00' }),
      allocation({ id: 'a2', paymentId: 'p1', allocated_amount: '400.00', paymentAmount: '500.00' }),
    ], '1000.00')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].exactAllocatedAmount, '100.00')
  })
})

// ── Continuity: what a reversal and a legacy link do ─────────────────────────

describe('reversal and de-duplication', () => {
  test('a reversed allocation is not this Order’s money', () => {
    const { rows, summary } = position([], [
      allocation({ id: 'a-live', paymentId: 'p-live', allocated_amount: '250000.00' }),
      allocation({ id: 'a-dead', paymentId: 'p-dead', allocated_amount: '900000.00', status: 'reversed' }),
    ], '1000000.00')

    assert.equal(rows.length, 1)
    assert.equal(summary.verified, '250000.00')
  })

  test('a payment that is BOTH legacy-linked and allocated here is counted once', () => {
    // Counting it twice would double the Order's received figure — the exact
    // failure mergeOrderPayments exists to prevent, re-asserted through the
    // exact-amount pass so a second code path cannot reintroduce it.
    const { rows, summary } = position(
      [linked({ id: 'p-both', amount: '400000.00', status: 'approved_linked' })],
      [allocation({ id: 'a-dup', paymentId: 'p-both', allocated_amount: '400000.00', paymentAmount: '400000.00' })],
      '1000000.00')

    assert.equal(rows.length, 1)
    assert.equal(summary.verified, '400000.00')
    assert.equal(summary.counts.total, 1)
  })
})

// ── Degradation: missing values never become a confident zero ────────────────

describe('an Order with no value, and figures that cannot be read', () => {
  test('no order value: percentages and balance are NULL, totals still stand', () => {
    const { summary } = position([linked({ amount: '400000.00' })], [], null)
    assert.equal(summary.orderValue, null)
    assert.equal(summary.verifiedPercent, null)
    assert.equal(summary.receivedPercent, null)
    assert.equal(summary.pendingBalance, null)
    assert.equal(summary.fullyPaid, false)
    // The money is still money — only its relation to a total is unknown.
    assert.equal(summary.verified, '400000.00')
  })

  test('a zero order value yields no percentage rather than a divide', () => {
    const { summary } = position([linked({ amount: '400000.00' })], [], '0.00')
    assert.equal(summary.verifiedPercent, null)
    assert.equal(summary.pendingBalance, '0.00')
  })

  test('an unreadable amount is left OUT of the total, not counted as zero', () => {
    const { rows, summary } = position(
      [
        linked({ id: 'p-good', amount: '400000.00', status: 'approved_linked' }),
        linked({ id: 'p-bad',  amount: 'NaN',       status: 'approved_linked' }),
      ],
      [], '1000000.00')

    assert.equal(summary.verified, '400000.00')
    // Still listed, and still counted as a row, so nothing disappears silently.
    assert.equal(rows.length, 2)
    assert.equal(summary.counts.verified, 2)
  })

  test('no payments at all: every total is zero and the whole value is pending', () => {
    const { rows, summary } = position([], [], '1000000.00')
    assert.equal(rows.length, 0)
    assert.equal(summary.verified, '0')
    assert.equal(summary.received, '0')
    assert.equal(summary.pendingBalance, '1000000.00')
    assert.equal(summary.verifiedPercent, '0.00')
    assert.deepEqual(summary.counts, { total: 0, verified: 0, awaiting: 0, rejected: 0 })
  })

  test('an overpaid Order shows no negative balance and reports over 100%', () => {
    const { summary } = position([linked({ amount: '1500000.00' })], [], '1000000.00')
    assert.equal(summary.pendingBalance, '0.00')
    assert.equal(summary.verifiedPercent, '150.00')
    assert.equal(summary.fullyPaid, true)
  })
})

describe('progressWidth', () => {
  test('is a pixel quantity, clamped, and never a figure', () => {
    assert.equal(progressWidth('39.99'), 39.99)
    assert.equal(progressWidth('150.00'), 100)
    assert.equal(progressWidth('-5'), 0)
    assert.equal(progressWidth(null), 0)
    assert.equal(progressWidth('nonsense'), 0)
  })
})

describe('withExactAmounts', () => {
  test('an allocation row missing from the source falls back to the merged figures', () => {
    // Defensive: the merge and the exact pass read the same two arrays, so this
    // cannot arise today. It is pinned so a future caller passing a narrowed
    // source degrades to the displayed value rather than to zero.
    const merged = mergeOrderPayments(
      [linked({ id: 'p1', amount: '400000.00' })] as Parameters<typeof mergeOrderPayments>[0], [])
    const rows: OrderFinancePaymentRow[] = withExactAmounts(merged, { linked: [], allocations: [] })
    assert.equal(rows[0].exactAmount, '400000')
    assert.equal(rows[0].exactAllocatedAmount, '400000')
    assert.equal(rows[0].isPartialShare, false)
  })
})

// ── One vocabulary across both screens ───────────────────────────────────────

describe('a payment status is called the same thing on the Order and on the PI', () => {
  const page = readFileSync('src/app/orders/[id]/page.tsx', 'utf8')

  test('the Order screen takes its labels from the PI card\'s own map', () => {
    assert.ok(page.includes('piPaymentStatusLabel(p.status)'),
      'the label comes from the shared map, not a second one on this page')
  })

  test('the three labels that disagreed are gone', () => {
    // Same stored value, two different words on two screens:
    //   'Pending'           for pending_approval, where the product says
    //                       "Awaiting Verification"
    //   'Order No. Pending' for approved_unlinked, which on an ORDER's own
    //                       screen is close to false — the money IS on this
    //                       Order, by the allocation PI conversion moved
    //   'Received'          for approved_linked, which is now the summary's word
    //                       for verified + awaiting together
    for (const stale of ["label: 'Pending'", "'Order No. Pending'", "label: 'Received'"]) {
      assert.ok(!page.includes(stale), `${stale} must not be a payment label here`)
    }
  })

  test('both verified statuses read alike, because both are verified money', () => {
    assert.equal(piPaymentStatusLabel('approved_unlinked'), piPaymentStatusLabel('approved_linked'))
    assert.equal(piPaymentStatusLabel('approved_unlinked'), 'Verified')
    assert.equal(piPaymentStatusLabel('pending_approval'), 'Awaiting Verification')
  })

  test('and the colours are still this screen\'s own', () => {
    assert.ok(page.includes('const PAYMENT_STATUS_COLOR'))
    assert.ok(page.includes("rejected:            '#991B1B'"), 'the existing palette is unchanged')
  })
})
