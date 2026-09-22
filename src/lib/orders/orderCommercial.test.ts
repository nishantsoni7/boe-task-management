/**
 * The Confirmed Order's commercial breakdown: what each line IS, which way it
 * moves the figure, and the one derived number on the page.
 *
 * THE POINT OF THESE. The section was redesigned from a flat list of captioned
 * amounts into a readable calculation, and the risk of that change is that a
 * presentation layer starts doing arithmetic. Every assertion below either pins
 * a formatted string straight through untouched, or pins the single subtraction
 * this module is allowed to perform.
 *
 * Pure functions over rows the shared PI builder already produced. No database,
 * no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderCommercial.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  NET_DIFFERENCE_LABEL,
  ORDER_COMMERCIAL_TITLE,
  ORDER_VALUE_LABEL,
  PRODUCT_VALUE_LABEL,
  orderCommercialLines,
  orderCommercialNet,
  orderStoredCommercialLines,
} from './orderCommercial'
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

describe('the net difference — the ONE derived figure', () => {
  const net = (productValue: unknown, orderValue: unknown) =>
    orderCommercialNet({
      productValue: productValue as number | string | null,
      orderValue: orderValue as number | string | null,
      formatAmount: formatMoney,
    })

  test('states what the terms added, in rupees and percent', () => {
    const n = net(1253000, 1530460)
    assert.equal(n.amount, `+${formatMoney(277460)}`)
    assert.equal(n.percent, '+22.1%')
    assert.equal(n.direction, 'up')
  })

  test('a discount-dominated Order reads as a reduction, with a minus', () => {
    const n = net(1000000, 940000)
    assert.equal(n.amount, `−${formatMoney(60000)}`)
    assert.equal(n.percent, '−6.0%')
    assert.equal(n.direction, 'down')
  })

  test('no change is stated as no change, unsigned', () => {
    const n = net(500000, 500000)
    assert.equal(n.amount, formatMoney(0))
    assert.equal(n.percent, '0.0%')
    assert.equal(n.direction, 'flat')
  })

  test('numeric STRINGS are read as the numbers PostgREST sent', () => {
    // The two columns arrive as strings precisely so they are not rounded by
    // JSON`s double; parsing them here must give the same answer as numbers.
    assert.deepEqual(net('1253000.00', '1530460.00'), net(1253000, 1530460))
  })

  test('paise survive the subtraction rather than becoming a float artefact', () => {
    const n = net('0.30', '0.10')
    assert.equal(n.amount, `−${formatMoney(0.2)}`)
  })

  test('MISSING IS NOT ZERO: either column absent and there is no net to state', () => {
    for (const bad of [null, undefined, '', 'n/a', NaN]) {
      assert.deepEqual(net(bad, 1530460), { amount: null, percent: null, direction: null })
      assert.deepEqual(net(1253000, bad), { amount: null, percent: null, direction: null })
    }
  })

  test('a percentage is offered ONLY where there is a real base to take one of', () => {
    // Zero would divide by zero; a negative base would invert the sign of a
    // real change. Both still state the rupees, which are unambiguous.
    for (const base of [0, -100]) {
      const n = net(base, 5000)
      assert.equal(n.percent, null, String(base))
      assert.ok(n.amount !== null)
    }
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
    assert.equal(NET_DIFFERENCE_LABEL, 'Net effect on product value')
    assert.equal(PRODUCT_VALUE_LABEL, 'Product value')
    assert.equal(ORDER_VALUE_LABEL, 'Order value')
  })
})
