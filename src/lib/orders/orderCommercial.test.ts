/**
 * The Confirmed Order's commercial breakdown: what each line IS, and which way
 * it moves the figure.
 *
 * THE POINT OF THESE. The section was redesigned from a flat list of captioned
 * amounts into a readable calculation, and the risk of that change is that a
 * presentation layer starts doing arithmetic. Every assertion below pins a
 * formatted string straight through untouched — and since the net-effect line
 * was removed, that is now ALL this module does. Nothing here computes money,
 * and one describe block below exists to keep it that way.
 *
 * Pure functions over rows the shared PI builder already produced. No database,
 * no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderCommercial.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ORDER_COMMERCIAL_TITLE,
  ORDER_VALUE_LABEL,
  PRODUCT_VALUE_LABEL,
  orderCommercialLines,
  orderStoredCommercialLines,
} from './orderCommercial'
/** The whole module, so the removed exports can be asserted ABSENT rather than
 *  merely unused. */
import * as orderCommercial from './orderCommercial'
import {
  buildCommercialRows,
  formatInr,
  type PiAmountRow,
} from '@/lib/pi/previewView'
import { commercialBreakdownRows } from '@/app/orders/drafts/[submissionId]/piDetailView'
import { formatMoney } from '@/lib/finance/piPaymentView'

const amount = (n: number) => ({ amount: n, text: null, zeroMeaning: null, cell: 'I1' })

/** A whole PI footer, through the SHARED builder — never hand-written rows, so
 *  a change to the upstream order or labels is caught here. */
const rows = (over: Partial<Parameters<typeof buildCommercialRows>[0]> = {}): PiAmountRow[] =>
  commercialBreakdownRows(buildCommercialRows({
    discount: 20000,
    discountLabel: null,
    subtotalAfterDiscount: amount(1233000),
    fabricCost: amount(40000),
    packingCost: amount(15000),
    transportation: amount(9000),
    totalBeforeGst: amount(1297000),
    gst: amount(233460),
    grandTotal: amount(1530460),
    grossProductAmount: 1253000,
    expectedSubtotal: 1233000,
    ...over,
  }))

describe('the lines, and what each one IS', () => {
  test('the calculation runs in the workbook`s own order, start to finish', () => {
    assert.deepEqual(orderCommercialLines(rows()).map(l => l.key), [
      'gross', 'discount', 'subtotal', 'fabric', 'packing', 'transportation',
      'beforeGst', 'gst', 'grandTotal',
    ])
  })

  test('it opens on the product value and ends on the order value', () => {
    const lines = orderCommercialLines(rows())
    assert.equal(lines[0].role, 'base')
    assert.equal(lines[0].label, PRODUCT_VALUE_LABEL)
    assert.equal(lines.at(-1)?.role, 'final')
    assert.equal(lines.at(-1)?.label, ORDER_VALUE_LABEL)
    // Exactly one of each: two "final" rows would be two answers.
    assert.equal(lines.filter(l => l.role === 'final').length, 1)
    assert.equal(lines.filter(l => l.role === 'base').length, 1)
  })

  test('THE ADVANCE ROW IS NOT HERE — it is a pre-approval condition', () => {
    // commercialBreakdownRows drops it upstream; this pins that it stays gone,
    // because an Order that exists is past the requirement.
    assert.ok(!orderCommercialLines(rows()).some(l => /advance/i.test(l.label)))
  })

  test('every factor is told from every running total', () => {
    const by = Object.fromEntries(orderCommercialLines(rows()).map(l => [l.key, l.role]))
    assert.equal(by.discount, 'deduction')
    for (const k of ['fabric', 'packing', 'transportation', 'gst']) assert.equal(by[k], 'addition', k)
    for (const k of ['subtotal', 'beforeGst']) assert.equal(by[k], 'running', k)
  })

  test('deductions carry a minus and additions carry a plus', () => {
    const by = Object.fromEntries(orderCommercialLines(rows()).map(l => [l.key, l.sign]))
    assert.equal(by.discount, '−')
    for (const k of ['fabric', 'packing', 'transportation', 'gst']) assert.equal(by[k], '+', k)
    // A total is not a movement and takes no sign.
    for (const k of ['gross', 'subtotal', 'beforeGst', 'grandTotal']) assert.equal(by[k], null, k)
  })

  test('a nil factor takes NO sign — `− ₹0` reads as a deduction that is not one', () => {
    const lines = orderCommercialLines(rows({ discount: 0, packingCost: amount(0) }))
    assert.equal(lines.find(l => l.key === 'discount')?.value, formatInr(0))
    assert.equal(lines.find(l => l.key === 'discount')?.sign, null)
    assert.equal(lines.find(l => l.key === 'packing')?.sign, null)
  })

  test('a worded or missing cell takes no sign either', () => {
    const lines = orderCommercialLines(rows({
      fabricCost: { amount: null, text: 'Included', zeroMeaning: 'included', cell: 'I117' },
      packingCost: { amount: null, text: null, zeroMeaning: null, cell: 'I118' },
    }))
    const fabric = lines.find(l => l.key === 'fabric')
    const packing = lines.find(l => l.key === 'packing')
    assert.notEqual(fabric?.kind, 'amount')
    assert.equal(fabric?.sign, null)
    assert.equal(packing?.sign, null)
  })

  test('NO AMOUNT IS RE-FORMATTED — every value is the shared builder`s string', () => {
    const built = rows()
    const lines = orderCommercialLines(built)
    for (const [i, line] of lines.entries()) {
      assert.equal(line.value, built[i].value, line.key)
      assert.equal(line.kind, built[i].kind, line.key)
    }
    // And the first one really is the gross amount the workbook stated.
    assert.equal(lines[0].value, formatInr(1253000))
  })

  test('only the two end labels are re-worded; every factor keeps the PI`s own', () => {
    const built = rows()
    const lines = orderCommercialLines(built)
    for (const [i, line] of lines.entries()) {
      if (line.key === 'gross' || line.key === 'grandTotal') continue
      assert.equal(line.label, built[i].label, line.key)
    }
    assert.equal(lines[0].label, 'Product value')
    assert.equal(lines.at(-1)?.label, 'Order value')
  })

  test('a row this build does not know is drawn, and claims no direction', () => {
    const [unknown] = orderCommercialLines([
      { key: 'levy', label: 'Some new levy', value: formatInr(500), kind: 'amount' },
    ])
    assert.equal(unknown.label, 'Some new levy')
    assert.equal(unknown.value, formatInr(500))
    assert.equal(unknown.sign, null, 'a guessed sign is worse than no sign')
  })

  test('the group break the PI draws before tax is carried through', () => {
    const lines = orderCommercialLines(rows())
    assert.equal(lines.find(l => l.key === 'beforeGst')?.groupStart, true)
  })
})

describe('THE NET-EFFECT LINE IS GONE, and nothing replaced it', () => {
  // It used to close the section with a display subtraction of the Order's two
  // stored columns. It was removed as a presentation decision — the breakdown
  // opens on the product value and closes on the Order value, so the difference
  // between the first row and the last restated what the rows already showed.
  //
  // These assertions exist so it cannot come back by accident, and so the
  // removal cannot be confused with a change to the money.

  test('the module exports neither the label nor the calculation', () => {
    for (const gone of ['NET_DIFFERENCE_LABEL', 'orderCommercialNet']) {
      assert.equal(gone in orderCommercial, false, `${gone} must no longer be exported`)
    }
  })

  test('and the module now performs NO arithmetic on money at all', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/orders/orderCommercial.ts'), 'utf8')
    // The subtraction, its rounding and its percentage are all gone. If any
    // arithmetic reappears here, this module has stopped being presentation.
    for (const arithmetic of ['Math.round(', 'total - base', 'toFixed(', '/ base']) {
      assert.equal(source.includes(arithmetic), false, `${arithmetic} must not return`)
    }
    assert.equal(source.includes('Net effect'), true,
      'the removal should still be explained in the module, so it is not re-added')
  })

  test('the two stored columns themselves are untouched', () => {
    // The breakdown still opens on the product value and closes on the Order
    // value; only the line BETWEEN their two figures went.
    const lines = orderCommercialLines(rows())
    assert.equal(lines[0].label, PRODUCT_VALUE_LABEL)
    assert.equal(lines[lines.length - 1].label, ORDER_VALUE_LABEL)
    assert.equal(lines[lines.length - 1].role, 'final')
  })
})

describe('the Order that never came from a PI', () => {
  test('still states its two stored figures rather than nothing at all', () => {
    const lines = orderStoredCommercialLines({
      productValue: formatMoney(1253000),
      orderValue: formatMoney(1530460),
    })
    assert.deepEqual(lines.map(l => l.key), ['gross', 'grandTotal'])
    assert.deepEqual(lines.map(l => l.role), ['base', 'final'])
    assert.deepEqual(lines.map(l => l.label), [PRODUCT_VALUE_LABEL, ORDER_VALUE_LABEL])
    assert.equal(lines[0].value, formatMoney(1253000))
    assert.equal(lines[1].value, formatMoney(1530460))
  })

  test('and INVENTS no middle: there is no PI to read a discount or a tax off', () => {
    const lines = orderStoredCommercialLines({ productValue: '₹1', orderValue: '₹2' })
    assert.equal(lines.length, 2)
    assert.ok(lines.every(l => l.sign === null))
  })
})

describe('the words', () => {
  test('are said once, here, so the section and its tests cannot disagree', () => {
    assert.equal(ORDER_COMMERCIAL_TITLE, 'Commercial breakdown')
    assert.equal(PRODUCT_VALUE_LABEL, 'Product value')
    assert.equal(ORDER_VALUE_LABEL, 'Order value')
  })
})
