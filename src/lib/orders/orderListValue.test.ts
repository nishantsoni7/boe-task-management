/**
 * The Confirmed Orders list's Value column is the Subtotal (owner, 2026-10-19):
 * products minus discount — never fabric, packing, transport or GST.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderListValue.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ORDER_LIST_SOURCE_PI_EMBED, orderListSubtotal } from './orderListValue'

describe('the Value column is the Subtotal', () => {
  test('Order 0524: the PI subtotal, not the Grand Total', () => {
    // Products 12,53,000, no discount; fabric/packing/transport take it to
    // 13,25,500 before GST; Grand Total 15,64,090 (the Order's total_value).
    assert.equal(orderListSubtotal({
      total_value: '1564090.00', total_product_value: '1253000.00',
      source_pi: { subtotal_after_discount: '1253000.00', grand_total: '1564090.00' },
    }), 1253000)
  })

  test('a discount comes off: the subtotal after discount, not the product value', () => {
    assert.equal(orderListSubtotal({
      total_value: 118000, total_product_value: 100000,
      source_pi: { subtotal_after_discount: 90000, grand_total: 118000 },
    }), 90000)
  })

  test('a hand-amended value no longer matches the PI: the Order\'s own product value', () => {
    assert.equal(orderListSubtotal({
      total_value: 200000, total_product_value: 150000,
      source_pi: { subtotal_after_discount: 90000, grand_total: 118000 },
    }), 150000)
  })

  test('no source PI, or one this reader cannot read: the product value; nothing known: null', () => {
    assert.equal(orderListSubtotal({ total_value: 5000, total_product_value: 4000, source_pi: null }), 4000)
    assert.equal(orderListSubtotal({ total_value: 5000, total_product_value: null, source_pi: undefined }), null)
    assert.equal(orderListSubtotal({ total_value: null, total_product_value: '', source_pi: null }), null)
  })

  test('an array-shaped embed is read the same way', () => {
    assert.equal(orderListSubtotal({
      total_value: 118000, total_product_value: 100000,
      source_pi: [{ subtotal_after_discount: 90000, grand_total: 118000 }],
    }), 90000)
  })

  test('the list reads it in its ONE query, and shows and sorts by it — never total_value', () => {
    const page = readFileSync('src/app/orders/all/page.tsx', 'utf8')
    assert.ok(page.includes(ORDER_LIST_SOURCE_PI_EMBED), 'the embed, through the source PI foreign key')
    assert.ok(page.includes('subtotal: orderListSubtotal(o)'))
    assert.equal((page.match(/fmtAmount\(o\.total_value\)/g) ?? []).length, 0, 'the Grand Total is never drawn as Value')
    assert.equal((page.match(/fmtAmount\(o\.subtotal\)/g) ?? []).length, 2, 'table and phone card')
    assert.ok(page.includes('compareValue(a.subtotal, b.subtotal, -1)') && page.includes('compareValue(a.subtotal, b.subtotal, 1)'))
  })
})
