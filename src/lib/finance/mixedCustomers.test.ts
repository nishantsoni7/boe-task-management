/**
 * ONE PAYMENT, SEVERAL CUSTOMERS — warned, confirmed, never blocked.
 *
 * Run:
 *   npx tsx --test src/lib/finance/mixedCustomers.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

import {
  MIXED_CUSTOMER_BLOCKED_REASON,
  MIXED_CUSTOMER_CONFIRM_LABEL,
  customerGroups,
  customerKey,
  customerSignature,
  customerTargetLabel,
  isMixedCustomerSelection,
  rowCustomerTargets,
} from './mixedCustomers'
import { MixedCustomerWarning } from '@/app/finance/components/MixedCustomerWarning'
import { allocateFundsBlockedReason } from '@/app/finance/received/AllocateFundsModal'
import { EMPTY_ALLOCATION_ROW } from './splitPaymentEntry'

const read = (...p: string[]) => readFileSync(join(...p), 'utf8')

describe('grouping targets by customer', () => {
  test('the same customer across several Orders is ONE customer — no warning', () => {
    const groups = customerGroups([
      { clientName: 'Hotel Aurum', label: 'Order 0524' },
      { clientName: 'Hotel Aurum', label: 'Order 0529' },
      { clientName: 'Hotel Aurum', label: 'PI Draft 019' },
    ])
    assert.equal(groups.length, 1)
    assert.deepEqual(groups[0].targets, ['Order 0524', 'Order 0529', 'PI Draft 019'])
    assert.equal(isMixedCustomerSelection(groups), false)
  })

  test('spacing and letter case do not make a second customer', () => {
    assert.equal(customerKey('  Hotel   Aurum '), customerKey('hotel aurum'))
    assert.equal(isMixedCustomerSelection(customerGroups([
      { clientName: 'Hotel Aurum', label: 'Order 0524' },
      { clientName: 'HOTEL  AURUM', label: 'Order 0529' },
    ])), false)
  })

  test('different customers are listed with their own targets', () => {
    const groups = customerGroups([
      { clientName: 'Hotel Aurum', label: 'Order 0524' },
      { clientName: 'Cafe Verde', label: 'PI Draft 019' },
      { clientName: 'Hotel Aurum', label: 'Order 0529' },
    ])
    assert.equal(isMixedCustomerSelection(groups), true)
    assert.deepEqual(groups, [
      { customer: 'Cafe Verde', targets: ['PI Draft 019'] },
      { customer: 'Hotel Aurum', targets: ['Order 0524', 'Order 0529'] },
    ])
  })

  test('an unreadable customer is not evidence of a second customer', () => {
    assert.equal(isMixedCustomerSelection(customerGroups([
      { clientName: 'Hotel Aurum', label: 'Order 0524' },
      { clientName: null, label: 'A Confirmed Order' },
      { clientName: '—', label: 'PI Draft 020' },
    ])), false)
  })

  test('a confirmation is tied to one set of customers', () => {
    const ab = customerGroups([{ clientName: 'A', label: 'Order 1' }, { clientName: 'B', label: 'Order 2' }])
    const abc = customerGroups([...[{ clientName: 'A', label: 'Order 1' }, { clientName: 'B', label: 'Order 2' }], { clientName: 'C', label: 'Order 3' }])
    assert.notEqual(customerSignature(ab), customerSignature(abc))
    // Order of selection does not matter.
    const ba = customerGroups([{ clientName: 'B', label: 'Order 2' }, { clientName: 'A', label: 'Order 1' }])
    assert.equal(customerSignature(ab), customerSignature(ba))
  })

  test('rows without a chosen record are ignored; chosen rows are named, never by uuid', () => {
    const targets = rowCustomerTargets([
      { ...EMPTY_ALLOCATION_ROW('r1') },
      { ...EMPTY_ALLOCATION_ROW('r2'), kind: 'order', targetId: 'o-1', clientName: 'Hotel Aurum', reference: '0524' },
      { ...EMPTY_ALLOCATION_ROW('r3'), kind: 'submission', targetId: 's-1', clientName: 'Cafe Verde', reference: null },
    ])
    assert.deepEqual(targets, [
      { clientName: 'Hotel Aurum', label: 'Order 0524' },
      { clientName: 'Cafe Verde', label: 'A PI Draft' },
    ])
    assert.equal(customerTargetLabel('submission', '019'), 'PI Draft 019')
  })
})

describe('the warning, rendered', () => {
  const groups = customerGroups([
    { clientName: 'Hotel Aurum', label: 'Order 0524' },
    { clientName: 'Cafe Verde', label: 'PI Draft 019' },
  ])
  const html = renderToStaticMarkup(createElement(MixedCustomerWarning, {
    groups, confirmed: false, onConfirmedChange: () => {},
  }))

  test('it is announced, lists every customer and target, and says how it will display', () => {
    assert.ok(html.includes('role="alert"'))
    for (const text of ['Hotel Aurum', 'Order 0524', 'Cafe Verde', 'PI Draft 019', 'Multiple customers']) {
      assert.ok(html.includes(text), `missing ${text}`)
    }
  })

  test('the confirmation is a real, labelled checkbox (keyboard reachable)', () => {
    assert.ok(/<input[^>]*type="checkbox"/.test(html))
    const id = /<input[^>]*id="([^"]+)"[^>]*type="checkbox"/.exec(html)?.[1]
    assert.ok(id && html.includes(`for="${id}"`), 'the label must be tied to the checkbox')
    assert.ok(html.includes(MIXED_CUSTOMER_CONFIRM_LABEL))
  })
})

describe('both doors that divide a payment use it', () => {
  for (const file of ['RecordSplitPaymentModal.tsx', 'AllocateFundsModal.tsx']) {
    test(`${file} shows the warning and waits for the tick`, () => {
      const src = read('src', 'app', 'finance', 'received', file)
      assert.ok(src.includes('<MixedCustomerWarning'), 'the warning is drawn')
      assert.ok(src.includes('mixedCustomers && !mixedConfirmed ? MIXED_CUSTOMER_BLOCKED_REASON : null'),
        'submission waits for the explicit confirmation')
      assert.ok(src.includes('customerSignature(customers)'), 'the confirmation is tied to the customer set')
    })
  }

  test('the blocked reason tells the person what to do', () => {
    assert.match(MIXED_CUSTOMER_BLOCKED_REASON, /different customers/)
    assert.match(MIXED_CUSTOMER_BLOCKED_REASON, /Tick the confirmation/)
  })

  test('Allocate Funds counts the customers the payment already pays for', () => {
    const src = read('src', 'app', 'finance', 'received', 'AllocateFundsModal.tsx')
    assert.ok(src.includes('customerGroups([...existingCustomers, ...chosenTargets])'))
    assert.ok(src.includes('loadAllocationLedger(supabase, payment.id)'))
  })

  test('neither door sends a customer — the server derives it', () => {
    const record = read('src', 'app', 'finance', 'received', 'RecordSplitPaymentModal.tsx')
    assert.ok(record.includes('p_client_name:  null'))
    const funds = read('src', 'app', 'finance', 'received', 'AllocateFundsModal.tsx')
    assert.ok(!/client_name\s*:/.test(funds.slice(funds.indexOf("supabase.rpc('allocate_payment_to_targets'"))
      .slice(0, 300)), 'Allocate Funds sends targets only')
  })

  test('the mixed-customer rule is a warning, not a new refusal in Allocate Funds itself', () => {
    // Existing Allocate Funds behaviour is unchanged: its own blocked-reason
    // function knows nothing about customers.
    const payment = { id: 'p', human_payment_id: 'PAY-1', amount: 1000, allocated_total: 0 }
    const rows = [
      { ...EMPTY_ALLOCATION_ROW('a'), kind: 'order' as const, targetId: 'o1', clientName: 'A', reference: '1', amount: '400' },
      { ...EMPTY_ALLOCATION_ROW('b'), kind: 'order' as const, targetId: 'o2', clientName: 'B', reference: '2', amount: '600' },
    ]
    assert.equal(allocateFundsBlockedReason({ payment, rows }), null)
  })
})
