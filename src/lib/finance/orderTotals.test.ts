/**
 * THE CONFIRMED TOTAL OF THE ORDER A SEARCH NAMES — the pure rules
 * (src/lib/finance/orderTotals.ts) and the places that must call them.
 * The SQL (finance_order_confirmed_totals, 20270701000000) is executed by
 * supabase/tests/confirmed_payments_order_search_pglite.mjs.
 *
 * Run: npm run test:file -- src/lib/finance/orderTotals.test.ts
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  ORDER_TOTALS_MIN_TERM,
  ORDER_TOTALS_SHOWN,
  orderTotalsTerm,
  orderTotalsView,
  paymentsCountLabel,
  type OrderTotalRow,
} from './orderTotals'
import { legacyOrdersOf, type AllocationTargetRow } from './allocatedAgainst'

const row = (over: Partial<OrderTotalRow> = {}): OrderTotalRow => ({
  target_type: 'order', target_reference: '0425', reserved_order_number: null, target_client_name: null,
  payments_count: 3, confirmed_total: '1250000.00', ...over,
})

describe('which search terms ask for a total', () => {
  test('an order-like term of 3 characters or more, in the literal form the list searches by', () => {
    assert.equal(ORDER_TOTALS_MIN_TERM, 3)
    assert.equal(orderTotalsTerm('0425'), '0425')
    assert.equal(orderTotalsTerm('  PID-00012 '), 'PID-00012')
    assert.equal(orderTotalsTerm('Hotel ABC'), 'Hotel ABC')
  })

  test('nothing for a short, blank or all-punctuation term', () => {
    assert.equal(orderTotalsTerm(''), null)
    assert.equal(orderTotalsTerm('04'), null)
    assert.equal(orderTotalsTerm('  '), null)
    assert.equal(orderTotalsTerm('%_,'), null)
  })

  test('a % _ , or quote is removed before the term is sent, so it is text, never a pattern or more filter', () => {
    assert.equal(orderTotalsTerm('04_25'), '04 25')
    assert.equal(orderTotalsTerm('0425,x'), '0425 x')
  })
})

describe('what the banner draws', () => {
  test('one order: its name as the Order / PI column names it, the exact total, the payment count', () => {
    const view = orderTotalsView([row()])
    assert.equal(view.lines.length, 1)
    assert.equal(view.lines[0].label, 'Order 0425')
    assert.equal(view.lines[0].total, '1250000.00')
    assert.equal(view.lines[0].payments, '3 payments')
    assert.equal(view.more, 0)
  })

  test('a PI Draft and an old order are named like their cells name them', () => {
    const view = orderTotalsView([
      row({ target_type: 'pi_draft', target_reference: 'PID-00020', reserved_order_number: '0440', payments_count: 1, confirmed_total: 1000000 }),
      row({ target_type: 'legacy_order', target_reference: 'AB-12', target_client_name: 'Hotel Sunrise', payments_count: 1, confirmed_total: '200000' }),
    ])
    assert.deepEqual(view.lines.map(l => l.label), ['PI Draft · PID-00020 · Reserved 0440', 'Old order AB-12 · Hotel Sunrise'])
    assert.equal(view.lines[0].total, '1000000')
    assert.equal(view.lines[0].payments, '1 payment')
  })

  test('at most five orders are listed and the rest are counted', () => {
    const rows = Array.from({ length: 8 }, (_, i) => row({ target_reference: `04${20 + i}` }))
    const view = orderTotalsView(rows)
    assert.equal(view.lines.length, ORDER_TOTALS_SHOWN)
    assert.equal(view.more, 3)
  })

  test('no rows, or a failed read (null), draws nothing', () => {
    assert.deepEqual(orderTotalsView(null), { lines: [], more: 0 })
    assert.deepEqual(orderTotalsView([]), { lines: [], more: 0 })
  })

  test('a missing total reads as zero rather than "null"', () => {
    assert.equal(orderTotalsView([row({ confirmed_total: null })]).lines[0].total, '0')
  })

  test('the payment count says "payment" once', () => {
    assert.equal(paymentsCountLabel(1), '1 payment')
    assert.equal(paymentsCountLabel(2), '2 payments')
  })
})

describe('where the total comes from', () => {
  const view = readFileSync('src/app/finance/received/ReceivedPaymentsView.tsx', 'utf8')
  const banner = readFileSync('src/app/finance/received/receivedPaymentsOrderTotals.tsx', 'utf8')

  test('it is asked of the database for the typed term, on the Confirmed surface only, and a stale answer is dropped', () => {
    assert.ok(view.includes("supabase.rpc('finance_order_confirmed_totals', { p_term: term })"))
    assert.ok(view.includes("const term = surface === 'confirmed' ? orderTotalsTerm(search) : null"))
    assert.ok(/if \(token !== loadToken\.current\) return\s+setOrderTotals\(/.test(view),
      'the answer of an older search never repaints a newer one')
  })

  test('a failed read draws nothing, never a figure', () => {
    assert.ok(view.includes('setOrderTotals(error ? null :'))
  })

  test('the banner is drawn between the toolbar and the list, for Confirmed Payments only', () => {
    assert.ok(view.includes("{surface === 'confirmed' && <OrderTotalsBanner rows={orderTotals} />}"))
  })

  test('the figure is the database\'s sum, never added up from the rows on screen', () => {
    const code = banner.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    assert.ok(!/\.reduce\(|sumExact|addExact/.test(code), 'no addition in the banner')
    assert.ok(!view.includes('requests.reduce'), 'and none over the page in hand')
  })

  test('the banner says what the figure covers', () => {
    assert.ok(banner.includes('Everything confirmed and allocated to this order, whatever the filters below.'))
  })
})

describe('the old orders of one payment, for the Edit window', () => {
  const target = (over: Partial<AllocationTargetRow>): AllocationTargetRow => ({
    payment_request_id: 'pay-1', allocation_id: 'al-x', target_type: 'order', target_id: 'o-1',
    target_reference: '0425', reserved_order_number: null, allocated_amount: '1', ...over,
  })

  test('only this payment\'s active old orders, with number and client tidied', () => {
    const rows = [
      target({}),
      target({ allocation_id: 'al-1', target_type: 'legacy_order', target_id: null, target_reference: 'AB-12', target_client_name: '  Hotel   Sunrise ' }),
      target({ allocation_id: 'al-2', payment_request_id: 'pay-2', target_type: 'legacy_order', target_id: null, target_reference: 'ZZ-1', target_client_name: 'Other' }),
    ]
    assert.deepEqual(legacyOrdersOf('pay-1', rows), [{ allocationId: 'al-1', orderNo: 'AB-12', clientName: 'Hotel Sunrise' }])
  })

  test('nothing while the read has not answered', () => {
    assert.deepEqual(legacyOrdersOf('pay-1', null), [])
  })
})

describe('the migration and the screen agree on the names', () => {
  const migration = readFileSync('supabase/migrations/20270701000000_finance_confirmed_payments_order_search.sql', 'utf8')
  const edit = readFileSync('src/app/finance/received/receivedPaymentsEdit.tsx', 'utf8')

  test('every RPC the screens call is created by the migration', () => {
    for (const fn of ['finance_order_confirmed_totals', 'correct_legacy_order_client', 'order_search_text']) {
      assert.ok(migration.includes(`create or replace function public.${fn}(`), fn)
    }
  })

  test('the Edit window calls the correction by its parameter names', () => {
    assert.ok(edit.includes("supabase.rpc('correct_legacy_order_client'"))
    assert.ok(edit.includes('p_allocation_id: change.allocationId'))
    assert.ok(edit.includes('p_client_name: change.next'))
    assert.ok(migration.includes('p_allocation_id uuid,') && migration.includes('p_client_name   text'))
  })

  test('the correction is finance.manage, the authority that edits a Confirmed Payment, and never writes the payment row', () => {
    assert.ok(migration.includes("actor_has_module_permission('finance', 'manage')"))
    const door = migration.slice(migration.indexOf('create or replace function public.correct_legacy_order_client('))
    const code = door.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    assert.ok(!/update public\.finance_payment_requests/.test(code), 'the payment row is never updated')
  })

  test('no bank, expense or Order file calls any of the three', () => {
    for (const file of ['src/app/finance/bank/BankStatementsView.tsx', 'src/app/finance/expenses/ExpensesView.tsx']) {
      const src = readFileSync(file, 'utf8')
      assert.ok(!/correct_legacy_order_client|finance_order_confirmed_totals/.test(src), file)
    }
  })
})
