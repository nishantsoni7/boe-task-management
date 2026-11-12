/**
 * THE ORDER TOTAL BANNER, actually rendered (owner, 2026-11-12): when the search
 * names an order, the confirmed total of that order sits above the list.
 *
 * Run: npm run test:file -- src/app/finance/received/orderTotals.render.test.tsx
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

import { OrderTotalsBanner } from './receivedPaymentsOrderTotals'
import type { OrderTotalRow } from '@/lib/finance/orderTotals'

const row = (over: Partial<OrderTotalRow> = {}): OrderTotalRow => ({
  target_type: 'order', target_reference: '0425', reserved_order_number: null, target_client_name: null,
  payments_count: 3, confirmed_total: '1250000.00', ...over,
})
const html = (rows: OrderTotalRow[] | null) => renderToStaticMarkup(createElement(OrderTotalsBanner, { rows }))
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

describe('the order total banner', () => {
  test('one order: its name, the confirmed total to the paisa, the payment count, and what the figure covers', () => {
    const markup = html([row()])
    assert.ok(markup.includes('data-order-totals="one"'))
    assert.ok(markup.includes('role="status"'), 'announced politely to a screen reader')
    const t = text(markup)
    assert.match(t, /Order 0425 · ₹12,50,000\.00 confirmed · 3 payments/)
    assert.match(t, /Everything confirmed and allocated to this order, whatever the filters below\./)
  })

  test('a total is never rounded or reformatted into something else', () => {
    assert.match(text(html([row({ confirmed_total: '1234.5' })])), /₹1,234\.50 confirmed/)
    assert.match(text(html([row({ confirmed_total: 0, payments_count: 0 })])), /₹0\.00 confirmed · 0 payments/)
  })

  test('a PI Draft and an old order read like their Order / PI cells', () => {
    assert.match(text(html([row({ target_type: 'pi_draft', target_reference: 'PID-00020', reserved_order_number: '0440', payments_count: 1 })])),
      /PI Draft · PID-00020 · Reserved 0440 · ₹12,50,000\.00 confirmed · 1 payment/)
    assert.match(text(html([row({ target_type: 'legacy_order', target_reference: 'AB-12', target_client_name: 'Hotel Sunrise' })])),
      /Old order AB-12 · Hotel Sunrise · ₹12,50,000\.00 confirmed/)
  })

  test('several orders: each with its own total, and the reader is told to type the full number', () => {
    const markup = html([row(), row({ target_reference: '0426', confirmed_total: '300000', payments_count: 1 })])
    assert.ok(markup.includes('data-order-totals="several"'))
    const t = text(markup)
    assert.match(t, /Several orders match\. Type the full number to see one order(?:'|&#x27;)s total\./)
    assert.match(t, /Order 0425 · ₹12,50,000\.00 3 payments/)
    assert.match(t, /Order 0426 · ₹3,00,000\.00 1 payment/)
  })

  test('more than five: the first five and a count of the rest', () => {
    const many = Array.from({ length: 8 }, (_, i) => row({ target_reference: `04${20 + i}` }))
    const markup = html(many)
    assert.equal([...markup.matchAll(/<li /g)].length, 5)
    assert.match(text(markup), /…and 3 more \(showing 5\)\./)
    const capped = html(Array.from({ length: 26 }, (_, i) => row({ target_reference: `05${10 + i}` })))
    assert.match(text(capped), /…and many more/)
  })

  test('nothing is drawn for no term, no match or a failed read', () => {
    assert.equal(html(null), '')
    assert.equal(html([]), '')
  })
})
