// "PRODUCT VALUE" MEANS ONE THING EVERYWHERE: the products after the discount.
//
// Traced 2026-09-27: the PI Draft card, the Create Confirmed Order dialog's
// "Total product value" row and the Order page's "Total product value" were
// three readings of two different figures (the gross and the after-discount
// subtotal). These pin that all three now say the same rupees, from stored
// columns only, for a discounted and an undiscounted PI — and that no stored
// total, payment figure, fabric/packing charge or Total before GST moved.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCommercialRows, formatInr } from '@/lib/pi/previewView'
import { persistedCommercial } from './draftsView'
import {
  buildApprovalSummary,
  buildBreakdownView,
  commercialBreakdownRows,
  summaryCommercialFigures,
  PRODUCT_VALUE_BEFORE_DISCOUNT_LABEL,
} from '@/app/orders/drafts/[submissionId]/piDetailView'
import { orderProductValue, PRODUCT_VALUE_BEFORE_DISCOUNT_DETAIL } from './orderWorkspace'
import { orderCommercialLines } from './orderCommercial'

type Pi = Parameters<typeof persistedCommercial>[0]
const pi = (over: Partial<Pi>): Pi => ({
  gross_product_amount: 0, discount_amount: 0, subtotal_after_discount: null,
  fabric_cost: 0, fabric_cost_meaning: 'numeric', fabric_cost_text: null,
  packing_cost: 0, packing_cost_meaning: 'numeric', packing_cost_text: null,
  transportation_amount: null, transportation_text: null,
  total_before_gst: null, gst_amount: null, grand_total: null,
  ...over,
} as Pi)

// Rivoli, from the screenshot: ₹73,900 discount, no fabric or packing.
const RIVOLI = pi({ gross_product_amount: 1038100, discount_amount: 73900, subtotal_after_discount: 964200,
  total_before_gst: 964200, gst_amount: 173556, grand_total: 1137756 })
// A discount AND fabric and packing charges.
const KALYAN = pi({ gross_product_amount: 500000, discount_amount: 25000, subtotal_after_discount: 475000,
  fabric_cost: 45000, packing_cost: 12500, total_before_gst: 532500, gst_amount: 95850, grand_total: 628350 })
// No discount.
const PLAIN = pi({ gross_product_amount: 500000, discount_amount: 0, subtotal_after_discount: 500000,
  fabric_cost: 20000, packing_cost: 5000, total_before_gst: 525000, gst_amount: 94500, grand_total: 619500 })

const rowsOf = (p: Pi) => commercialBreakdownRows(buildCommercialRows(persistedCommercial(p)))
const draftProductValue = (p: Pi) => summaryCommercialFigures(rowsOf(p)).find(f => f.key === 'productValue')!.value
const dialogProductValue = (p: Pi) =>
  buildApprovalSummary({ client: 'X', productValue: draftProductValue(p), advanceConfirmed: '₹0' })
    .find(r => r.key === 'product_value')!.value
const orderSummaryValue = (p: Pi, stored = Number(p.gross_product_amount)) => orderProductValue({
  stored,
  pi: { gross: Number(p.gross_product_amount), discount: Number(p.discount_amount), subtotal: p.subtotal_after_discount === null ? null : Number(p.subtotal_after_discount) },
})

describe('the draft card, the approval dialog and the Order page state one product value', () => {
  for (const [name, p, expected] of [['Rivoli (discount only)', RIVOLI, 964200], ['Kalyan (discount + fabric + packing)', KALYAN, 475000], ['no discount', PLAIN, 500000]] as const) {
    test(name, () => {
      assert.equal(draftProductValue(p), formatInr(expected), 'PI Draft card')
      assert.equal(dialogProductValue(p), formatInr(expected), 'Create Confirmed Order dialog')
      // The Order was created by approval, which stores the PI's GROSS.
      const order = orderSummaryValue(p)
      assert.equal(order.amount, expected, 'Order page summary')
      assert.equal(order.detail, null)
    })
  }

  test('Total before GST, the grand total and the charges are the stored figures, untouched', () => {
    const rows = Object.fromEntries(rowsOf(KALYAN).map(r => [r.key, r.value]))
    assert.equal(rows.beforeGst, formatInr(532500))
    assert.equal(rows.grandTotal, formatInr(628350))
    assert.equal(rows.fabric, formatInr(45000))
    assert.equal(rows.packing, formatInr(12500))
  })
})

describe('an Order whose figure no longer matches its PI keeps its own, and says what it is', () => {
  test('amended away from the PI gross: the Order’s own figure, marked before discount', () => {
    assert.deepEqual(orderSummaryValue(RIVOLI, 1100000), { amount: 1100000, detail: PRODUCT_VALUE_BEFORE_DISCOUNT_DETAIL })
  })
  test('no PI read, or no discount: exactly as before', () => {
    assert.deepEqual(orderProductValue({ stored: 700000, pi: null }), { amount: 700000, detail: null })
    assert.deepEqual(orderSummaryValue(PLAIN, 480000), { amount: 480000, detail: null })
  })
})

describe('with a discount, the gross line is called the value BEFORE it, in both breakdowns', () => {
  test('the PI Draft’s Commercial breakdown', () => {
    assert.equal(buildBreakdownView(rowsOf(RIVOLI)).rows[0].label, PRODUCT_VALUE_BEFORE_DISCOUNT_LABEL)
    assert.equal(buildBreakdownView(rowsOf(PLAIN)).rows[0].label, 'Product value')
  })
  test('the Order page’s Commercial breakdown', () => {
    assert.equal(orderCommercialLines(rowsOf(RIVOLI))[0].label, PRODUCT_VALUE_BEFORE_DISCOUNT_LABEL)
    assert.equal(orderCommercialLines(rowsOf(PLAIN))[0].label, 'Product value')
  })
})
