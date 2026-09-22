/**
 * The two payment lists behind the Confirmed Order's summary figures.
 *
 * WHAT THESE HOLD. That each list is exactly the set of rows its figure counts,
 * that a refused payment is in neither, that every amount carried through is
 * THIS ORDER'S allocated share rather than the payment's ledger amount, and
 * that the builder computes nothing.
 *
 * Reads nothing. No database, no network.
 *
 * Run:
 *   npx tsx --test "src/lib/orders/orderPaymentLists.test.ts"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  PAYMENT_LIST_CAPTION,
  PAYMENT_LIST_EMPTY,
  PAYMENT_LIST_TITLE,
  orderPaymentList,
} from './orderPaymentLists'
import { buildOrderFinancePosition, type OrderFinancePaymentRow } from '@/lib/finance/orderFinancePosition'

const row = (over: Partial<OrderFinancePaymentRow>): OrderFinancePaymentRow => ({
  id: 'p1',
  client_name: 'Vittaazio',
  amount: 750000,
  payment_date: '2026-09-01',
  payment_mode: 'hdfc',
  order_number: '0524',
  status: 'approved_linked',
  allocatedAmount: 750000,
  exactAmount: '750000.00',
  exactAllocatedAmount: '750000.00',
  isPartialShare: false,
  attributionBasis: 'allocation',
  ...over,
} as OrderFinancePaymentRow)

// ── Which rows belong to which figure ─────────────────────────────────────────

describe('each list is the set of rows its figure counts', () => {
  const rows = [
    row({ id: 'linked', status: 'approved_linked' }),
    row({ id: 'unlinked', status: 'approved_unlinked' }),
    row({ id: 'pending', status: 'pending_approval' }),
    row({ id: 'clarify', status: 'needs_clarification' }),
    row({ id: 'refused', status: 'rejected' }),
  ]

  test('verified holds BOTH approved statuses, and only those', () => {
    assert.deepEqual(orderPaymentList(rows, 'verified').map(r => r.id), ['linked', 'unlinked'])
  })

  test('awaiting holds pending AND needs-clarification, and only those', () => {
    assert.deepEqual(orderPaymentList(rows, 'awaiting').map(r => r.id), ['pending', 'clarify'])
  })

  test('A REFUSED PAYMENT IS IN NEITHER — exactly as it is counted in neither figure', () => {
    for (const kind of ['verified', 'awaiting'] as const) {
      assert.equal(orderPaymentList(rows, kind).some(r => r.id === 'refused'), false, kind)
    }
    const position = buildOrderFinancePosition([row({ id: 'refused', status: 'rejected' })], 1000000)
    assert.equal(position.verified, '0')
    assert.equal(position.awaitingVerification, '0')
  })

  test('an unrecognised status is in neither list rather than guessed into one', () => {
    const odd = [row({ id: 'odd', status: 'something_new' })]
    assert.deepEqual(orderPaymentList(odd, 'verified'), [])
    assert.deepEqual(orderPaymentList(odd, 'awaiting'), [])
  })

  test('the two lists together are the two counts the position states', () => {
    const position = buildOrderFinancePosition(rows, 1000000)
    assert.equal(orderPaymentList(rows, 'verified').length, position.counts.verified)
    assert.equal(orderPaymentList(rows, 'awaiting').length, position.counts.awaiting)
  })

  test('the rows keep the order they arrived in', () => {
    const ordered = [
      row({ id: 'a', payment_date: '2026-09-03' }),
      row({ id: 'b', payment_date: '2026-09-01' }),
      row({ id: 'c', payment_date: '2026-09-02' }),
    ]
    assert.deepEqual(orderPaymentList(ordered, 'verified').map(r => r.id), ['a', 'b', 'c'])
  })

  test('an empty input is an empty list, not a throw', () => {
    assert.deepEqual(orderPaymentList([], 'verified'), [])
    assert.deepEqual(orderPaymentList([], 'awaiting'), [])
  })
})

// ── The money ─────────────────────────────────────────────────────────────────

describe('the amount carried through is THIS ORDER’S share', () => {
  const split = row({
    id: 'split', amount: 500000, allocatedAmount: 200000,
    exactAmount: '500000.00', exactAllocatedAmount: '200000.00', isPartialShare: true,
  })

  test('a split payment carries the allocated share as its amount', () => {
    const [only] = orderPaymentList([split], 'verified')
    assert.equal(only.allocated, '200000.00')
    assert.equal(only.full, '500000.00')
    assert.ok(only.isPartialShare)
  })

  test('and that share is the SAME figure the summary is built from', () => {
    const [only] = orderPaymentList([split], 'verified')
    assert.equal(buildOrderFinancePosition([split], 1000000).verified, only.allocated)
  })

  test('an ordinary payment is not marked as split', () => {
    assert.equal(orderPaymentList([row({})], 'verified')[0].isPartialShare, false)
  })

  test('the exact strings are passed through untouched — no parsing, no rounding', () => {
    const awkward = row({ exactAllocatedAmount: '0.005', exactAmount: '0.005' })
    assert.equal(orderPaymentList([awkward], 'verified')[0].allocated, '0.005')
  })

  test('it reads withExactAmounts’ answer rather than re-deriving a share', () => {
    // allocatedAmount is mergeOrderPayments' JS number and may carry a float
    // rounding; the exact string is what the totals are built from, and the
    // list must show the same one.
    const drift = row({ allocatedAmount: 199999.99, exactAllocatedAmount: '200000.00' })
    assert.equal(orderPaymentList([drift], 'verified')[0].allocated, '200000.00')
  })
})

// ── The fields a row carries ──────────────────────────────────────────────────

describe('a row carries what the dialog draws, and no more', () => {
  test('the payer, the date, the mode and the reference come through as stored', () => {
    const [only] = orderPaymentList([row({})], 'verified')
    assert.equal(only.client, 'Vittaazio')
    assert.equal(only.dateIso, '2026-09-01')
    assert.equal(only.mode, 'hdfc')
    assert.equal(only.reference, '0524')
    assert.equal(only.status, 'approved_linked')
  })

  test('an absent payer, date, mode or reference is null, never an invented value', () => {
    // The row type says these are strings; the DATABASE says they are nullable,
    // and a legacy payment genuinely carries nulls. The builder must pass the
    // absence through rather than printing "null".
    const bare = { ...row({}), client_name: null, payment_date: null, payment_mode: null, order_number: null } as unknown as OrderFinancePaymentRow
    const [only] = orderPaymentList([bare], 'verified')
    for (const field of ['client', 'dateIso', 'mode', 'reference'] as const) {
      assert.equal(only[field], null, field)
    }
  })

  test('NO DATE IS FORMATTED HERE — the page owns that, so one date reads alike everywhere', () => {
    assert.equal(orderPaymentList([row({})], 'verified')[0].dateIso, '2026-09-01')
  })
})

// ── The words ─────────────────────────────────────────────────────────────────

describe('the words the dialog uses', () => {
  test('each list is titled for the figure it opens from', () => {
    assert.equal(PAYMENT_LIST_TITLE.verified, 'Verified payments')
    assert.equal(PAYMENT_LIST_TITLE.awaiting, 'Payments awaiting verification')
  })

  test('an empty set says so plainly', () => {
    assert.equal(PAYMENT_LIST_EMPTY.awaiting, 'No payments awaiting verification.')
    assert.equal(PAYMENT_LIST_EMPTY.verified, 'No verified payments.')
  })

  test('the allocation rule is stated rather than assumed', () => {
    assert.match(PAYMENT_LIST_CAPTION, /this Order's allocated share/)
  })
})
