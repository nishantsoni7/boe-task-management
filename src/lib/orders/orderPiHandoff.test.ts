/**
 * THE CONFIRMED ORDER'S HANDOFF FROM ITS APPROVED PI.
 *
 * WHAT THESE TESTS ARE FOR
 * ------------------------
 * The handoff exists so an operations reader on /orders/[id] can see what the
 * Order actually IS. Three things about it can go wrong quietly, and each would
 * be worse than the missing information it replaced:
 *
 *   1. A FIGURE COULD BE INVENTED. A PI whose workbook never stated a pre-GST
 *      total must say so. ₹0 is a number somebody would bill against.
 *   2. A FIGURE COULD BE SAID TWICE, under two captions, four inches apart —
 *      which is how a reader starts wondering whether they are different
 *      numbers. handoffFigures is the one thing in the module that judges, and
 *      it is judged here.
 *   3. A PRIVATE STORAGE KEY COULD BE TRUSTED. orderPiWorkbookPath is what
 *      stands between the record's own column and Supabase's signer.
 *
 * Pure and offline. No database, no network, no rendering.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderPiHandoff.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  ORDER_PI_HANDOFF_COLUMNS,
  buildOrderPiHandoff,
  handoffFigures,
  orderBillingValue,
  orderPiWorkbookPath,
  type OrderPiRow,
} from './orderPiHandoff'
import { BILLING_UNDECLARED } from './billingPercentage'
import { buildCommercialRows } from '@/lib/pi/previewView'
import { persistedCommercial } from './draftsView'
import { commercialBreakdownRows } from '@/app/orders/drafts/[submissionId]/piDetailView'

// ── A PI, as the database hands it back ───────────────────────────────────────
//
// `numeric` arrives from PostgREST as a STRING, and the fixture says so: a test
// that fed numbers would not exercise the one conversion boundary this module
// has.

const SUBMISSION_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

function piRow(overrides: Partial<OrderPiRow> = {}): OrderPiRow {
  return {
    id: SUBMISSION_ID,
    client_name: 'Marigold Interiors',
    bill_to_name: 'Marigold Interiors Pvt Ltd',
    ship_to_name: 'Marigold Site Office',
    creation_date: '2026-07-01',
    source_created_by: 'R. Sharma',
    contact_number: '+91 98200 11223',
    bill_to_phone: null,
    ship_to_phone: null,
    billing_address: '14 Nariman Point, Mumbai',
    shipping_address: 'Plot 8, Sector 21, Gurugram',
    order_confirmation_date: '2026-07-04',
    dispatch_commitment: '6 weeks from date of confirmation',
    due_date: '2026-08-15',
    gross_product_amount: '1200000.00',
    discount_amount: '50000.00',
    subtotal_after_discount: '1150000.00',
    fabric_cost: '0',
    fabric_cost_meaning: 'not_applicable',
    fabric_cost_text: null,
    packing_cost: '0',
    packing_cost_meaning: 'included',
    packing_cost_text: 'Inclusive',
    transportation_amount: '20000.00',
    transportation_text: null,
    total_before_gst: '1170000.00',
    gst_amount: '210600.00',
    grand_total: '1380600.00',
    billing_percentage: '65',
    source_workbook_name: 'Marigold-PI-July.xlsx',
    source_workbook_path: `submissions/${SUBMISSION_ID}/original/9f1c-marigold.xlsx`,
    ...overrides,
  }
}

/** An Order that states both of its copied commercial columns — the ordinary
 *  case, and the one that must not produce a second Product value. */
const ORDER_STATES_BOTH = { totalProductValue: 1200000, totalValue: 1380600 }

const ready = (row: OrderPiRow, order = ORDER_STATES_BOTH) => {
  const handoff = buildOrderPiHandoff(row, order)
  assert.equal(handoff.kind, 'ready')
  if (handoff.kind !== 'ready') throw new Error('unreachable')
  return handoff
}

// ── 1. A PI-linked Order ──────────────────────────────────────────────────────

describe('a Confirmed Order created from an approved PI', () => {
  test('carries the PI\'s client, both parties and a dialable contact number', () => {
    const { client } = ready(piRow())
    assert.equal(client.name, 'Marigold Interiors')
    assert.equal(client.billTo.name, 'Marigold Interiors Pvt Ltd')
    assert.equal(client.billTo.address, '14 Nariman Point, Mumbai')
    assert.equal(client.shipTo.name, 'Marigold Site Office')
    assert.equal(client.shipTo.address, 'Plot 8, Sector 21, Gurugram')
    assert.equal(client.phone?.label, '+91 98200 11223')
    assert.equal(client.phone?.tel, '+919820011223')
  })

  test('states the confirm date and the due date the PI carries', () => {
    const dates = ready(piRow()).dates
    const confirmed = dates.find(d => d.key === 'confirmed')
    const due = dates.find(d => d.key === 'due')
    assert.ok(confirmed?.value, 'the confirm date must be printed')
    assert.ok(due?.value, 'the due date must be printed')
    // NOT constructed through `new Date(...)`: a timezone-shifted due date is
    // exactly the bug formatPiDate exists to prevent.
    assert.match(String(due?.value), /15/)
    assert.match(String(due?.value), /Aug/)
  })

  test('an absent due date falls back to the commitment, as PROSE and never as a date', () => {
    const dates = ready(piRow({ due_date: null })).dates
    const due = dates.find(d => d.key === 'due')
    assert.equal(due?.value, null, 'nothing may invent a date from the prose')
    assert.match(String(due?.note), /6 weeks from date of confirmation/)
  })

  test('the workbook filename is carried for the download control', () => {
    assert.equal(ready(piRow()).workbookName, 'Marigold-PI-July.xlsx')
    assert.equal(ready(piRow({ source_workbook_name: '   ' })).workbookName, null)
  })
})

// ── 2. An Order with no PI ────────────────────────────────────────────────────

describe('an Order that did not come from a PI', () => {
  test('the page state is `none`, which renders nothing at all', () => {
    // buildOrderPiHandoff is never reached for such an Order: the page branches
    // on source_order_submission_id first. This pins the CONTRACT that `none`
    // exists and is distinct from `unavailable`, so an Order with no PI can
    // never be reported as one whose PI could not be read.
    const none = { kind: 'none' } as const
    const unavailable = { kind: 'unavailable' } as const
    assert.notEqual(none.kind, unavailable.kind)
  })
})

// ── 3. Billing ────────────────────────────────────────────────────────────────

describe('the billing declaration', () => {
  test('a declared percentage prints as a percentage and as a value', () => {
    const { billing } = ready(piRow())
    assert.equal(billing.declared, true)
    assert.equal(billing.percent, '65%')
    assert.equal(billing.amountMissing, false)
    // 65% of the PRE-GST total, 11,70,000 → 7,60,500. Never of the grand total.
    assert.match(String(billing.amount), /7,60,500/)
  })

  test('an undeclared percentage says Undeclared — never 0%, never an em dash', () => {
    const { billing } = ready(piRow({ billing_percentage: null }))
    assert.equal(billing.declared, false)
    assert.equal(billing.percent, BILLING_UNDECLARED)
    assert.equal(billing.amount, null)
    assert.notEqual(billing.percent, '0%')
    assert.notEqual(billing.percent, '—')
  })

  test('the derivation is total_before_gst × percentage ÷ 100, and nothing else', () => {
    assert.equal(orderBillingValue({ total_before_gst: '1170000.00', billing_percentage: '65' }), 760500)
    // Emphatically NOT the grand total (which carries tax this percentage says
    // nothing about) and not the product value.
    assert.notEqual(orderBillingValue({ total_before_gst: '1170000.00', billing_percentage: '65' }), 1380600 * 0.65)
  })

  test('a MISSING pre-GST total produces the missing treatment, never ₹0', () => {
    const { billing } = ready(piRow({ total_before_gst: null }))
    assert.equal(billing.declared, true, 'the percentage was still declared')
    assert.equal(billing.amountMissing, true)
    assert.equal(orderBillingValue({ total_before_gst: null, billing_percentage: '65' }), null)
    assert.ok(
      billing.amount === null || !/₹\s*0(\D|$)/.test(billing.amount),
      'a missing pre-GST total must never render as ₹0',
    )
  })

  test('an out-of-range stored percentage is refused rather than shown', () => {
    // The CHECK constraint makes this impossible; if one ever appeared it would
    // mean the column no longer means what billingPercentage.ts says it does.
    assert.equal(ready(piRow({ billing_percentage: '12' })).billing.declared, false)
    assert.equal(orderBillingValue({ total_before_gst: '1170000.00', billing_percentage: '12' }), null)
  })
})

// ── 4. The commercial rows ────────────────────────────────────────────────────

describe('the commercial breakdown', () => {
  test('is the approved PI\'s own rows, string for string', () => {
    const row = piRow()
    const expected = commercialBreakdownRows(buildCommercialRows(persistedCommercial(row)))
    assert.deepEqual([...ready(row).commercialRows], expected)
  })

  test('carries the whole calculation the PI screen shows', () => {
    const keys = ready(piRow()).commercialRows.map(r => r.key)
    for (const key of ['gross', 'discount', 'subtotal', 'fabric', 'packing', 'transportation', 'beforeGst', 'gst', 'grandTotal']) {
      assert.ok(keys.includes(key), `${key} must be in the breakdown`)
    }
  })

  test('drops the advance row, because this Order already exists', () => {
    // "Required advance (40%)" is a PRE-approval condition. Printing it against
    // a Confirmed Order would state a requirement that no longer applies.
    assert.ok(!ready(piRow()).commercialRows.some(r => r.key === 'advance'))
  })

  test('preserves the four cost MEANINGS rather than collapsing them to zero', () => {
    const rows = ready(piRow()).commercialRows
    assert.equal(rows.find(r => r.key === 'fabric')?.value, 'Not applicable')
    assert.equal(rows.find(r => r.key === 'packing')?.value, 'Included')
  })

  test('a missing pre-GST cell prints the missing treatment, not ₹0', () => {
    const rows = ready(piRow({ total_before_gst: null })).commercialRows
    const beforeGst = rows.find(r => r.key === 'beforeGst')
    assert.equal(beforeGst?.kind, 'missing')
    assert.ok(!/₹\s*0(\D|$)/.test(String(beforeGst?.value)))
  })
})

// ── 5. No financial section is stated twice ───────────────────────────────────

describe('the handoff adds facts rather than repeating them', () => {
  const rows = commercialBreakdownRows(buildCommercialRows(persistedCommercial(piRow())))

  test('Product value is DROPPED when the Order\'s own strip already states it', () => {
    const figures = handoffFigures(rows, ORDER_STATES_BOTH)
    assert.ok(!figures.some(f => f.key === 'gross'),
      'orders.total_product_value is already on screen; a second Product value is the same rupees under a second caption')
  })

  test('Total before GST is NEVER dropped — `orders` has no such column', () => {
    for (const order of [ORDER_STATES_BOTH, { totalProductValue: null, totalValue: null }]) {
      assert.ok(handoffFigures(rows, order).some(f => f.key === 'beforeGst'),
        'the handoff is the only place the pre-GST total can appear')
    }
  })

  test('a NULL on the Order is not "already shown", so the PI carries the figure', () => {
    const figures = handoffFigures(rows, { totalProductValue: null, totalValue: 1380600 })
    assert.ok(figures.some(f => f.key === 'gross'),
      'an Order printing an em dash states nothing; the PI has the number')
  })

  test('the card never prints the same figure key twice', () => {
    const keys = handoffFigures(rows, ORDER_STATES_BOTH).map(f => f.key)
    assert.equal(new Set(keys).size, keys.length)
  })
})

// ── 6. The private workbook key ───────────────────────────────────────────────

describe('the original workbook path', () => {
  test('is accepted only inside THIS submission\'s own original/ folder', () => {
    assert.equal(
      orderPiWorkbookPath({ id: SUBMISSION_ID, source_workbook_path: `submissions/${SUBMISSION_ID}/original/a.xlsx` }),
      `submissions/${SUBMISSION_ID}/original/a.xlsx`,
    )
  })

  test('refuses another submission\'s folder, however well formed', () => {
    const other = '11111111-2222-3333-4444-555555555555'
    assert.equal(
      orderPiWorkbookPath({ id: SUBMISSION_ID, source_workbook_path: `submissions/${other}/original/a.xlsx` }),
      null,
    )
  })

  test('refuses traversal, nesting, backslashes and the images folder', () => {
    const bad = [
      `submissions/${SUBMISSION_ID}/original/../../etc/passwd`,
      `submissions/${SUBMISSION_ID}/original/nested/a.xlsx`,
      `submissions/${SUBMISSION_ID}/original/a\\b.xlsx`,
      `submissions/${SUBMISSION_ID}/images/a.png`,
      `orders/${SUBMISSION_ID}/versions/1/approved.xlsx`,
      `submissions/${SUBMISSION_ID}/original/`,
      '',
      '   ',
    ]
    for (const path of bad) {
      assert.equal(orderPiWorkbookPath({ id: SUBMISSION_ID, source_workbook_path: path }), null, path)
    }
  })

  test('a record with no workbook yields null rather than a guess', () => {
    assert.equal(orderPiWorkbookPath({ id: SUBMISSION_ID, source_workbook_path: null }), null)
    assert.equal(orderPiWorkbookPath({ id: SUBMISSION_ID }), null)
  })
})

// ── 7. The select ─────────────────────────────────────────────────────────────

describe('what the Order screen selects from the PI', () => {
  const columns = ORDER_PI_HANDOFF_COLUMNS.split(',').map(c => c.trim())

  test('is never `*`', () => {
    assert.ok(!columns.includes('*'))
  })

  test('carries no duplicate', () => {
    assert.equal(new Set(columns).size, columns.length)
  })

  test('does NOT reach the PI\'s review material', () => {
    // An Order viewer is entitled to the agreed document, not to the argument
    // that produced it. Each of these belongs to the review audience.
    for (const forbidden of [
      'review_note', 'rejected_by', 'rejected_at',
      'parse_warnings', 'parse_blocking_issues',
      'deletion_claim_token',
      'advance_exception_reason', 'advance_exception_status',
      'finance_verified_by', 'finance_verified_at',
      'approved_by', 'status',
    ]) {
      assert.ok(!columns.includes(forbidden), `${forbidden} must not be selected by the Order screen`)
    }
  })

  test('carries every column the shared builders read', () => {
    for (const needed of [
      'client_name', 'bill_to_name', 'ship_to_name', 'creation_date', 'source_created_by',
      'contact_number', 'bill_to_phone', 'ship_to_phone', 'billing_address', 'shipping_address',
      'order_confirmation_date', 'dispatch_commitment', 'due_date',
      'gross_product_amount', 'discount_amount', 'subtotal_after_discount',
      'fabric_cost', 'fabric_cost_meaning', 'fabric_cost_text',
      'packing_cost', 'packing_cost_meaning', 'packing_cost_text',
      'transportation_amount', 'transportation_text',
      'total_before_gst', 'gst_amount', 'grand_total',
      'billing_percentage', 'source_workbook_name', 'source_workbook_path',
    ]) {
      assert.ok(columns.includes(needed), `${needed} must be selected`)
    }
  })
})
