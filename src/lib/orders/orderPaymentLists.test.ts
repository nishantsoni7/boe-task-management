/**
 * The two payment lists behind the Confirmed Order's summary figures.
 *
 * WHAT THESE HOLD. That each list is exactly the set of rows its figure counts,
 * that a refused payment is in neither, that every amount carried through is
 * THIS ORDER'S allocated share rather than the payment's ledger amount, and
 * that the builder computes nothing.
 *
 * AND THAT A LATE ANSWER CANNOT REWRITE THE SCREEN. The detail read is
 * asynchronous and its state is one slot, so the last sections drive it with
 * deferred promises resolving in the orders a real reader produces — opening A,
 * going back, opening B, and having A land afterwards — and hold that only the
 * payment actually on screen is ever drawn.
 *
 * Reads nothing. No database, no network.
 *
 * Run:
 *   npx tsx --test "src/lib/orders/orderPaymentLists.test.ts"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  PAYMENT_DETAIL_COLUMNS,
  PAYMENT_DETAIL_UNAVAILABLE,
  PAYMENT_LIST_CAPTION,
  PAYMENT_LIST_EMPTY,
  PAYMENT_LIST_TITLE,
  createPaymentDetailGate,
  loadPaymentDetailInto,
  orderPaymentList,
  paymentDetailFields,
  paymentDetailFor,
  type OrderPaymentDetailState,
  type PaymentDetailReadResult,
  type PaymentDetailRow,
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

// ── A late answer must never rewrite the screen ───────────────────────────────

/**
 * A promise this test resolves by hand, so nothing depends on timing.
 *
 * Every interleaving below is produced deliberately — B's read resolved before
 * A's although A was issued first — rather than hoped for from two real
 * requests, which is what makes these deterministic.
 */
function deferred<T>() {
  let settle!: (value: T) => void
  const promise = new Promise<T>(resolve => { settle = resolve })
  return { promise, settle }
}

const arrived = (humanId: string): PaymentDetailReadResult =>
  ({ row: { human_payment_id: humanId } as PaymentDetailRow, failed: false })

/**
 * The page's two slots and its gate, exactly as the page holds them: one
 * `openId`, one `detail`, and the gate every read is issued through. What the
 * dialog would DRAW is paymentDetailFor(detail, openId) — never `detail` alone.
 */
function screen() {
  const gate = createPaymentDetailGate()
  let openId: string | null = null
  let detail: OrderPaymentDetailState | null = null
  const reads = new Map<string, (result: PaymentDetailReadResult) => void>()

  return {
    gate,
    /** Presses View details on one payment; returns the in-flight load. */
    open(paymentId: string) {
      const d = deferred<PaymentDetailReadResult>()
      reads.set(paymentId, d.settle)
      return loadPaymentDetailInto({
        gate,
        paymentId,
        read: () => d.promise,
        open: id => { openId = id },
        apply: next => { detail = next },
      })
    },
    /** Answers one payment's read, whenever the test chooses to. */
    answer(paymentId: string, result: PaymentDetailReadResult) {
      reads.get(paymentId)!(result)
    },
    /** Back, and Close, as the page wires them: invalidate, then clear. */
    back() { gate.invalidate(); openId = null; detail = null },
    close() { gate.invalidate(); openId = null; detail = null },
    /** A refresh, a lost capability or unmount: invalidate, keep the screen. */
    invalidate() { gate.invalidate() },
    get openId(): string | null { return openId },
    get rawDetail(): OrderPaymentDetailState | null { return detail },
    /** What the dialog actually draws. */
    get drawn(): OrderPaymentDetailState | null { return paymentDetailFor(detail, openId) },
  }
}

/** The human id on a drawn record, or null where none is drawn. */
const shown = (state: OrderPaymentDetailState | null): string | null =>
  state?.state === 'ready' ? state.fields.humanId : null

describe('a detail read that is no longer the current one is discarded', () => {
  test('A, BACK, B — and A landing LAST leaves B on screen, untouched', async () => {
    const s = screen()

    const a = s.open('pay-a')                 // 1. the reader opens A
    const onA = s.drawn
    assert.equal(onA?.state, 'loading')
    assert.equal(s.openId, 'pay-a')

    s.back()                                  // 2. and returns to the list
    assert.equal(s.openId, null)

    const b = s.open('pay-b')                 // 3. then opens B
    s.answer('pay-b', arrived('PAY-B'))       // 4. B answers first
    await b
    const onB = s.drawn
    assert.equal(onB?.state, 'ready')
    assert.equal(onB?.paymentId, 'pay-b')
    assert.equal(shown(onB), 'PAY-B')

    s.answer('pay-a', arrived('PAY-A'))       // 5. A answers AFTERWARDS
    await a

    // 6. Only B's record remains visible. A changed nothing at all.
    const afterA = s.drawn
    assert.equal(s.openId, 'pay-b')
    assert.equal(afterA?.paymentId, 'pay-b')
    assert.equal(shown(afterA), 'PAY-B')
    assert.equal(s.rawDetail?.paymentId, 'pay-b', "A's answer reached the slot")
  })

  test('the same holds WITHOUT the trip back — A, then B, then A lands', async () => {
    const s = screen()
    const a = s.open('pay-a')
    const b = s.open('pay-b')

    s.answer('pay-b', arrived('PAY-B'))
    await b
    s.answer('pay-a', arrived('PAY-A'))
    await a

    const drawn = s.drawn
    assert.equal(drawn?.paymentId, 'pay-b')
    assert.equal(shown(drawn), 'PAY-B')
  })

  test("A'S REFUSAL DOES NOT REFUSE B", async () => {
    const s = screen()
    const a = s.open('pay-a')
    const b = s.open('pay-b')

    s.answer('pay-b', arrived('PAY-B'))
    await b
    s.answer('pay-a', { row: null, failed: true })
    await a

    const drawn = s.drawn
    assert.equal(drawn?.state, 'ready', "A's refusal was drawn over B")
    assert.equal(drawn?.paymentId, 'pay-b')
  })

  test('A CLOSED DIALOG IS NOT REOPENED OR REPOPULATED by an answer arriving after it', async () => {
    const s = screen()
    const a = s.open('pay-a')

    s.close()
    assert.equal(s.openId, null)
    assert.equal(s.rawDetail, null)

    s.answer('pay-a', arrived('PAY-A'))
    await a

    assert.equal(s.openId, null, 'a closed dialog was reopened')
    assert.equal(s.rawDetail, null, 'a cleared slot was repopulated')
    assert.equal(s.drawn, null)
  })

  test('and neither does a REFUSAL arriving after closure', async () => {
    const s = screen()
    const a = s.open('pay-a')
    s.close()
    s.answer('pay-a', { row: null, failed: true })
    await a
    assert.equal(s.rawDetail, null)
    assert.equal(s.openId, null)
  })

  test('an Order refresh, a lost capability or unmount invalidates the read in flight', async () => {
    // All three are the same act — the page calls gate.invalidate() — and the
    // screen is deliberately NOT cleared here, which is what a refresh does.
    const s = screen()
    const a = s.open('pay-a')
    assert.equal(s.drawn?.state, 'loading')

    s.invalidate()
    s.answer('pay-a', arrived('PAY-A'))
    await a

    // The slot still says loading: the superseded answer was not written.
    const afterwards = s.drawn
    assert.equal(afterwards?.state, 'loading')
    assert.equal(shown(afterwards), null, 'a superseded record was written')
  })

  test('a read that THROWS is a refusal, not an unhandled rejection', async () => {
    const slot: { detail: OrderPaymentDetailState | null } = { detail: null }

    await loadPaymentDetailInto({
      gate: createPaymentDetailGate(),
      paymentId: 'pay-a',
      read: () => Promise.reject(new Error('network')),
      open: () => {},
      apply: next => { slot.detail = next },
    })

    const applied = slot.detail
    assert.equal(applied?.state, 'error')
    assert.equal(applied?.paymentId, 'pay-a')
    assert.equal(applied?.state === 'error' ? applied.message : null, PAYMENT_DETAIL_UNAVAILABLE)
  })

  test('an ordinary open, uninterrupted, still lands', async () => {
    const s = screen()
    const a = s.open('pay-a')
    s.answer('pay-a', arrived('PAY-A'))
    await a
    const drawn = s.drawn
    assert.equal(drawn?.state, 'ready')
    assert.equal(shown(drawn), 'PAY-A')
  })
})

describe('the gate itself', () => {
  test('every begin supersedes the one before it', () => {
    const gate = createPaymentDetailGate()
    const first = gate.begin('pay-a')
    assert.equal(first.isCurrent(), true)
    const second = gate.begin('pay-b')
    assert.equal(first.isCurrent(), false)
    assert.equal(second.isCurrent(), true)
  })

  test('invalidate supersedes without issuing anything', () => {
    const gate = createPaymentDetailGate()
    const only = gate.begin('pay-a')
    gate.invalidate()
    assert.equal(only.isCurrent(), false)
    // And it stays invalid: a second invalidate does not wrap back round.
    gate.invalidate()
    assert.equal(only.isCurrent(), false)
  })

  test('a request remembers which payment it was issued for', () => {
    assert.equal(createPaymentDetailGate().begin('pay-a').paymentId, 'pay-a')
  })
})

describe('a state may only be drawn for the payment it names', () => {
  const ready = (paymentId: string): OrderPaymentDetailState =>
    ({ state: 'ready', paymentId, fields: paymentDetailFields({}) })

  test('the matching payment draws it', () => {
    assert.equal(paymentDetailFor(ready('pay-a'), 'pay-a')?.paymentId, 'pay-a')
  })

  test('ANY OTHER PAYMENT DRAWS NOTHING', () => {
    assert.equal(paymentDetailFor(ready('pay-a'), 'pay-b'), null)
  })

  test('and nothing is drawn with no payment open, or no state', () => {
    assert.equal(paymentDetailFor(ready('pay-a'), null), null)
    assert.equal(paymentDetailFor(null, 'pay-a'), null)
    assert.equal(paymentDetailFor(null, null), null)
  })
})

// ── Who signed it off ─────────────────────────────────────────────────────────

describe('the approver is a name, never an id', () => {
  test('THE STORED approved_by UUID IS NOT EVEN FETCHED', () => {
    // What is asked for is the embedded name. The id is not selected, because
    // it is not shown — and an unused sensitive column is not fetched.
    assert.equal(/(^|[ ,])approved_by([ ,]|$)/.test(PAYMENT_DETAIL_COLUMNS), false)
    assert.ok(PAYMENT_DETAIL_COLUMNS.includes('approved_by_user:users!approved_by(full_name)'))
  })

  test('the embed names the FOREIGN KEY, so it cannot go ambiguous', () => {
    // finance_payment_requests references public.users more than once.
    assert.ok(PAYMENT_DETAIL_COLUMNS.includes('users!approved_by('))
    assert.equal(PAYMENT_DETAIL_COLUMNS.includes('users(full_name)'), false)
  })

  test('it asks for full_name and nothing else about the person', () => {
    const embed = PAYMENT_DETAIL_COLUMNS.slice(PAYMENT_DETAIL_COLUMNS.indexOf('users!approved_by('))
    assert.equal(embed, 'users!approved_by(full_name)')
    for (const unsafe of ['email', 'phone', 'role', 'password', 'employee_code']) {
      assert.equal(PAYMENT_DETAIL_COLUMNS.includes(unsafe), false, unsafe)
    }
  })

  test('the name comes through as stored', () => {
    assert.equal(
      paymentDetailFields({ approved_by_user: { full_name: 'Meera Raghunathan' } }).approvedByName,
      'Meera Raghunathan')
  })

  test('A HIDDEN OR ABSENT APPROVER IS NULL, never a placeholder', () => {
    // Null is what the embed returns when the reader's RLS does not show them
    // that user — the dialog then draws no Verified by line at all.
    assert.equal(paymentDetailFields({ approved_by_user: null }).approvedByName, null)
    assert.equal(paymentDetailFields({}).approvedByName, null)
    assert.equal(paymentDetailFields({ approved_by_user: { full_name: '   ' } }).approvedByName, null)
    assert.equal(paymentDetailFields({ approved_by_user: { full_name: null } }).approvedByName, null)
  })
})
