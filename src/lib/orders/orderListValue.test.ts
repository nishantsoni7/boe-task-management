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
import { ORDER_LIST_SOURCE_PI_EMBED, factoryStatus, orderListFlags, orderListSubtotal } from './orderListValue'

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

describe('columns, markers and Factory Status (owner, 2026-10-19)', () => {
  test('Sample and commission come from the source PI; a hidden commission is no icon', () => {
    assert.deepEqual(orderListFlags({ source_pi: { subtotal_after_discount: 1, grand_total: 1, advance_exception_reason_code: 'sample_order', commission: { middleman_commission: 'yes' } } }), { sample: 'sample_order', commission: true }, 'legacy: the advance reason')
    assert.deepEqual(orderListFlags({ source_pi: { subtotal_after_discount: 1, grand_total: 1, advance_exception_reason_code: 'against_client_po', commission: { middleman_commission: 'no' } } }), { sample: null, commission: false })
    assert.deepEqual(orderListFlags({ source_pi: { subtotal_after_discount: 1, grand_total: 1, advance_exception_reason_code: null, commission: null } }), { sample: null, commission: false }, 'RLS gave no commission row')
    assert.deepEqual(orderListFlags({ source_pi: null }), { sample: null, commission: false })
    assert.deepEqual(orderListFlags({ source_pi: [{ subtotal_after_discount: 1, grand_total: 1, commission: [{ middleman_commission: 'Yes' }] }] }), { sample: null, commission: true })
  })

  test('Factory Status: Aligned for Production once Operations accepted, else Not Aligned', () => {
    assert.deepEqual(factoryStatus('aligned'), { aligned: true, label: 'Aligned for Production' })
    assert.deepEqual(factoryStatus('not_aligned'), { aligned: false, label: 'Not Aligned' })
    assert.deepEqual(factoryStatus(null), { aligned: false, label: 'Not Aligned' })
  })

  test('the table: Project code, Client, Product Value, Factory Status, Sales Person, Confirmed, Due — no Requested by, no Status', () => {
    const page = readFileSync('src/app/orders/all/page.tsx', 'utf8')
    const head = page.slice(page.indexOf('<thead>'), page.indexOf('</thead>'))
    const cols = [...head.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map(m => m[1])
    assert.deepEqual(cols, ['Project code', 'Client', 'Product Value', 'Factory Status', 'Sales Person', 'Confirmed', 'Due'])
    assert.equal(page.includes('requested_by_name} />'), false, 'no Requested by cell')
    assert.ok(page.includes('production_alignment'))
    // Symbols only, named by tooltip and accessible label.
    assert.ok(page.includes('title={SAMPLE_TYPE_LABEL[sample]} aria-label={SAMPLE_TYPE_LABEL[sample]} role="img"'))
    assert.equal(page.includes('<StatusBadge'), false, 'no Status pill in the table or the cards')
    // Every column left-aligned; the markers at the right edge of the code cell.
    assert.equal(/<th className="fin-num">/.test(page), false)
    assert.ok(page.includes('className="fin-ordno orders-code-cell"'))
    assert.ok(page.includes('sample_type, sample_type_set_at'), "the Order's own sample choice is read")
    assert.ok(page.includes('title={COMMISSION_ICON_LABEL} aria-label={COMMISSION_ICON_LABEL} role="img"'))
  })
})

describe('the sample choice (20270320000000)', () => {
  test("the Order's own choice wins once made — even 'not a sample'; else the PI's; else the legacy reason", () => {
    const pi = { subtotal_after_discount: 1, grand_total: 1, sample_type: 'sampling_needed', advance_exception_reason_code: 'sample_order' }
    assert.equal(orderListFlags({ source_pi: pi }).sample, 'sampling_needed', 'the PI choice beats the legacy reason')
    assert.equal(orderListFlags({ sample_type: 'sample_order', sample_type_set_at: '2026-10-19T00:00:00Z', source_pi: pi }).sample, 'sample_order')
    assert.equal(orderListFlags({ sample_type: null, sample_type_set_at: '2026-10-19T00:00:00Z', source_pi: pi }).sample, null, 'cleared on the Order')
    assert.equal(orderListFlags({ sample_type: 'sample_order', sample_type_set_at: null, source_pi: { ...pi, sample_type: null, advance_exception_reason_code: null } }).sample, null, 'an Order value without a set_at is not a choice')
  })
})
