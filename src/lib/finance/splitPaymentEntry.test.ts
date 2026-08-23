/**
 * DIVIDING ONE PAYMENT AS IT IS RECORDED.
 *
 * The arithmetic and the refusals of the Add Payment form's allocation list.
 * Offline and pure: no database, no React, no clock.
 *
 * Run:
 *   npx tsx --test src/lib/finance/splitPaymentEntry.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  EMPTY_ALLOCATION_ROW,
  duplicateTargetKeys,
  splitPaymentBlockedReason,
  splitPaymentErrorMessage,
  splitPaymentTotals,
  targetKey,
  toRpcAllocations,
  type SplitAllocationRow,
} from './splitPaymentEntry'

const row = (over: Partial<SplitAllocationRow> = {}): SplitAllocationRow => ({
  key: 'k1', kind: 'order', targetId: 'o-1', targetLabel: '0007', amount: '1000', ...over,
})

const base = {
  amount: '100000',
  paymentDate: '2026-08-20',
  paymentMode: 'bank_transfer',
  clientName: 'Acme',
}

describe('the three figures the form shows continuously', () => {
  test('one payment split across two Confirmed Orders', () => {
    const t = splitPaymentTotals({
      amount: '100000',
      rows: [
        row({ key: 'a', targetId: 'o-1', amount: '60000' }),
        row({ key: 'b', targetId: 'o-2', amount: '40000' }),
      ],
    })
    assert.equal(t.payment,   '100000')
    assert.equal(t.allocated, '100000')
    assert.equal(t.remaining, '0')
    assert.equal(t.overAllocated, false)
    assert.equal(t.fullyAllocated, true)
  })

  test('a remainder is an ordinary, saveable state', () => {
    const t = splitPaymentTotals({
      amount: '500000',
      rows: [row({ amount: '200000' })],
    })
    assert.equal(t.remaining, '300000')
    assert.equal(t.fullyAllocated, false)
    assert.equal(splitPaymentBlockedReason({ ...base, amount: '500000', rows: [row({ amount: '200000' })] }), null)
  })

  test('an empty list is a plain unallocated payment, and saves', () => {
    const t = splitPaymentTotals({ amount: '1000', rows: [] })
    assert.equal(t.allocated, '0')
    assert.equal(t.remaining, '1000')
    assert.equal(t.fullyAllocated, false)
    assert.equal(splitPaymentBlockedReason({ ...base, amount: '1000', rows: [] }), null)
  })

  test('over-allocation shows a NEGATIVE remainder rather than a clamped zero', () => {
    // Clamping would hide the one condition the person has to see.
    const t = splitPaymentTotals({
      amount: '1000',
      rows: [row({ key: 'a', targetId: 'o-1', amount: '600' }), row({ key: 'b', targetId: 'o-2', amount: '600' })],
    })
    assert.equal(t.remaining, '-200')
    assert.equal(t.overAllocated, true)
  })

  test('the money is counted in exact decimal, not in float', () => {
    // 0.1 + 0.2 in binary floating point is 0.30000000000000004, which would
    // leave a payment of 0.30 looking over-allocated by a fraction of a paisa.
    const t = splitPaymentTotals({
      amount: '0.30',
      rows: [row({ key: 'a', targetId: 'o-1', amount: '0.10' }), row({ key: 'b', targetId: 'o-2', amount: '0.20' })],
    })
    assert.equal(t.allocated, '0.30')
    assert.equal(t.remaining, '0.00')
    assert.equal(t.overAllocated, false)
    assert.equal(t.fullyAllocated, true)
  })

  test('an empty row counts as nothing; a trailing dot counts as what was typed', () => {
    // sanitizeAmountInput deliberately lets a trailing '.' stand while somebody
    // is still typing, and isValidAmount reads '12.' as 12. Asserted rather than
    // assumed, because the running total is on screen as the person types and it
    // must not flicker between 12 and 0 on a keystroke that changes nothing.
    const t = splitPaymentTotals({ amount: '1000', rows: [row({ amount: '' }), row({ key: 'b', amount: '12.' })] })
    assert.equal(t.allocated, '12')
    assert.equal(t.remaining, '988')
  })

  test('an unreadable payment amount leaves every derived figure null', () => {
    const t = splitPaymentTotals({ amount: 'abc', rows: [row()] })
    assert.equal(t.payment, null)
    assert.equal(t.remaining, null)
    assert.equal(t.overAllocated, false)
    assert.equal(t.allocated, '1000')
  })
})

describe('one payment holds one allocation per record', () => {
  test('the same Order twice is a duplicate', () => {
    const rows = [row({ key: 'a', targetId: 'o-1' }), row({ key: 'b', targetId: 'o-1' })]
    assert.deepEqual([...duplicateTargetKeys(rows)], ['order:o-1'])
    assert.match(splitPaymentBlockedReason({ ...base, rows }) ?? '', /listed twice/)
  })

  test('an Order and a PI Draft are different targets even at the same position', () => {
    const rows = [
      row({ key: 'a', kind: 'order', targetId: 'x' }),
      row({ key: 'b', kind: 'submission', targetId: 'x' }),
    ]
    assert.equal(duplicateTargetKeys(rows).size, 0)
    assert.equal(splitPaymentBlockedReason({ ...base, rows }), null)
  })

  test('an incomplete row has no target key and cannot be a duplicate', () => {
    const rows = [EMPTY_ALLOCATION_ROW('a'), EMPTY_ALLOCATION_ROW('b')]
    assert.equal(targetKey(rows[0]), null)
    assert.equal(duplicateTargetKeys(rows).size, 0)
  })
})

describe('why the form cannot be saved', () => {
  test('payment-level facts are asked for before any row is judged', () => {
    // Somebody who has typed nothing is told to name the client, not to fix
    // row 3 — the order the form is filled in, not the order it is validated.
    const broken = [row({ kind: null, targetId: null, amount: '' })]
    assert.match(splitPaymentBlockedReason({ ...base, clientName: '  ', rows: broken }) ?? '', /client/)
    assert.match(splitPaymentBlockedReason({ ...base, amount: '', rows: broken }) ?? '', /amount received/)
    assert.match(splitPaymentBlockedReason({ ...base, paymentDate: '', rows: broken }) ?? '', /date/)
    assert.match(splitPaymentBlockedReason({ ...base, paymentMode: '', rows: broken }) ?? '', /how the payment was made/)
  })

  test('a row with an amount but no target names its own position', () => {
    const rows = [row({ key: 'a' }), row({ key: 'b', kind: null, targetId: null, amount: '500' })]
    assert.match(splitPaymentBlockedReason({ ...base, rows }) ?? '', /allocation 2/)
  })

  test('a row with a target but no amount names its own position', () => {
    const rows = [row({ key: 'a', targetId: 'o-1', amount: '' })]
    assert.match(splitPaymentBlockedReason({ ...base, rows }) ?? '', /allocation 1/)
  })

  test('zero and negative allocations are refused', () => {
    // isValidAmount already rejects a negative, so the sentence it produces is
    // the amount one; zero reaches the positive test and gets its own.
    assert.ok(splitPaymentBlockedReason({ ...base, rows: [row({ amount: '0' })] }))
    assert.ok(splitPaymentBlockedReason({ ...base, rows: [row({ amount: '-5' })] }))
  })

  test('over-allocation is refused and names the payment', () => {
    const rows = [row({ key: 'a', targetId: 'o-1', amount: '900' }), row({ key: 'b', targetId: 'o-2', amount: '900' })]
    const reason = splitPaymentBlockedReason({ ...base, amount: '1000', rows })
    assert.match(reason ?? '', /total more than the 1000 received/)
  })

  test('untouched empty rows are ignored entirely', () => {
    // A form that starts with a blank row must not refuse to save because of it.
    const rows = [row({ key: 'a', amount: '400' }), EMPTY_ALLOCATION_ROW('b')]
    assert.equal(splitPaymentBlockedReason({ ...base, rows }), null)
  })
})

describe('what is sent to the RPC', () => {
  test('only complete rows, in the order they were added', () => {
    const rows = [
      row({ key: 'a', kind: 'order', targetId: 'o-1', amount: '600' }),
      EMPTY_ALLOCATION_ROW('b'),
      row({ key: 'c', kind: 'submission', targetId: 's-1', amount: '400' }),
    ]
    assert.deepEqual(toRpcAllocations(rows), [
      { kind: 'order', id: 'o-1', amount: 600 },
      { kind: 'submission', id: 's-1', amount: 400 },
    ])
  })

  test('there is no third target kind, so a retired Order Request cannot be named', () => {
    // The type admits 'order' and 'submission' and nothing else, and the RPC
    // refuses anything else by name. This is the payload's half of that.
    const rows = toRpcAllocations([row()])
    for (const r of rows) assert.ok(r.kind === 'order' || r.kind === 'submission')
  })
})

describe('server refusals become sentences that name the rule', () => {
  const cases: [string, RegExp][] = [
    ['PAYMENT_ENTRY_NOT_PERMITTED: …',            /access to Finance/],
    ['PAYMENT_ENTRY_ALLOCATION_NOT_PERMITTED: …', /permission to allocate/],
    ['PAYMENT_ALLOCATIONS_EXCEED_AMOUNT: …',      /more than the amount received/],
    ['PAYMENT_ALLOCATIONS_TOO_MANY: …',           /at most 20 ways/],
    ['PAYMENT_ALLOCATION_KIND_INVALID: …',        /Confirmed Order or a PI Draft/],
    ['PAYMENT_ALLOCATION_AMOUNT_INVALID: …',      /positive amount/],
    ['PAYMENT_CLIENT_REQUIRED: …',                /client/],
    ['PAYMENT_DATE_FUTURE: …',                    /future/],
    ['ALLOCATION_DUPLICATE: …',                   /listed twice/],
    ['ALLOCATION_TARGET_CONVERTED: …',            /now an Order/],
    ['ALLOCATION_TARGET_NOT_AVAILABLE: …',        /not available to you/],
  ]

  for (const [raw, expected] of cases) {
    test(raw.split(':')[0], () => assert.match(splitPaymentErrorMessage(raw), expected))
  }

  test('an unrecognised refusal never leaks database text, and says nothing was saved', () => {
    const message = splitPaymentErrorMessage(
      'duplicate key value violates unique constraint "finance_payment_allocations_one_active_order_uidx"')
    assert.doesNotMatch(message, /constraint|uidx|duplicate key/)
    assert.match(message, /Nothing was saved/)
  })

  test('a null refusal is still a sentence', () => {
    assert.match(splitPaymentErrorMessage(null), /could not be recorded/)
  })
})
