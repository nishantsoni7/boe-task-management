import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  computePaymentPlan,
  inputFromData,
  parsePlanData,
  plannedQuantities,
} from './paymentPlan'
import { buildPaymentPlanSheet, paymentPlanFileName } from './paymentPlanSheet'
import { buildPaymentPlanWorkbook } from './paymentPlanXlsx'
import { renderPaymentPlanPdf } from './paymentPlanPdf'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')

const raw = {
  found: true, has_pi: true,
  order: { id: 'o1', display_number: '0539', status: 'running', total_value: '28320.00', client_name: 'Acme Interiors' },
  pi: { total_before_gst: '24000.00', gst_amount: '4320.00', grand_total: '28320.00', billing_percentage: '50.00' },
  items: [
    { item_sequence: '1', product_name: 'Table', quantity: '10.00', rate: '1000.00' },
    { item_sequence: '2', product_name: 'Chair', quantity: '20.00', rate: '500.00' },
  ],
  plan: { pending_percent: '50.00', billing_percent: null, advance_account_override: null, advance_cash_override: '10000.00', note: 'Client asked for the table first' },
  lots: [
    { id: 'l1', lot_no: 1, status: 'dispatched', planned_on: null, dispatched_on: '2026-10-20', lines: [{ item_sequence: '2', quantity: '5.00' }] },
    { id: 'l2', lot_no: 2, status: 'planned', planned_on: '2026-11-01', lines: [{ item_sequence: '1', quantity: '10.00' }] },
  ],
  finance: { verified: '1000.00', awaiting: '600.00', payment_count: 2, account_verified: '1000.00', cash_verified: '0', account_awaiting: '600.00', cash_awaiting: '0' },
}

const build = () => {
  const data = parsePlanData(raw)!
  const planned = plannedQuantities(data.lots)
  const result = computePaymentPlan(inputFromData(data, {
    planned, pendingPercent: data.pendingPercent, billingPercentOverride: null, advanceAccountOverride: data.advanceAccountOverride, advanceCashOverride: data.advanceCashOverride,
  }))
  const sheet = buildPaymentPlanSheet(data, result, { lotLines: planned, generatedOn: '28-10-2026', plannedOn: '2026-11-01' })
  return { data, result, sheet }
}

test('the sheet carries the same figures the calculation produced, account and cash apart', () => {
  const { result, sheet } = build()
  const byLabel = new Map(sheet.summary.map(s => [s.label, s]))
  const due = byLabel.get('Total to be paid')!
  assert.deepEqual([due.account, due.cash, due.total], [result.split.due.account, result.split.due.cash, result.requiredPaise])
  const got = byLabel.get('Already received')!
  assert.deepEqual([got.account, got.cash], [100000, 1000000])
  const last = sheet.summary[sheet.summary.length - 1]
  assert.equal(last.label, 'Balance to pay')
  assert.equal(last.total, result.toCollectPaise)
  assert.equal(sheet.title, 'Payment plan — Order 0539')
})

test('earlier lots and the planned lot are both listed, and the note and Finance caveat travel with the sheet', () => {
  const { sheet } = build()
  assert.deepEqual(sheet.lotRows.map(r => r[0]), ['Lot 1', 'This lot (planned)'])
  assert.ok(sheet.notes.some(n => /not counted yet/.test(n)))
  assert.ok(sheet.notes.includes('Client asked for the table first'))
  assert.ok(sheet.facts.some(f => f.label === 'Received in cash' && /typed/.test(f.value)))
  assert.ok(sheet.facts.some(f => f.label === 'Received in account' && /confirmed payments/.test(f.value)))
})

test('the Excel keeps numbers as numbers and carries the rupee format', async () => {
  const { sheet } = build()
  const bytes = await buildPaymentPlanWorkbook(sheet)
  const XLSX = await import('xlsx')
  const wb = XLSX.read(bytes, { type: 'array' })
  const ws = wb.Sheets['Payment plan']
  assert.ok(ws)
  const rows = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, blankrows: false })
  const required = rows.find(r => r[0] === 'Total to be paid')
  assert.ok(required)
  assert.equal(typeof required[1], 'number')
  const { result } = build()
  assert.deepEqual(required.slice(1, 4), [result.split.due.account / 100, result.split.due.cash / 100, result.requiredPaise / 100])
})

test('the PDF renders to a real PDF with the order number in its file name', async () => {
  const { sheet } = build()
  const pdf = await renderPaymentPlanPdf(sheet, null)
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-')
  assert.ok(pdf.length > 1500)
  assert.equal(paymentPlanFileName('0539', 'pdf'), 'Payment-plan-0539.pdf')
  assert.equal(paymentPlanFileName('a/b c', 'xlsx'), 'Payment-plan-a-b-c.xlsx')
})

test('the Order page only LINKS to the plan, for holders of view_payment_plan, never under View As', () => {
  const page = read('src/app/orders/[id]/page.tsx')
  assert.match(page, /ordersCaps\.canViewPaymentPlan && !viewAsUserId/)
  assert.match(page, /router\.push\(`\/orders\/\$\{order\.id\}\/payment-plan`\)/)
  assert.doesNotMatch(page, /<OrderPaymentPlan\b/, 'the plan is not drawn on the Order page itself')
})

test('the plan has its own page, which says "no access" rather than drawing nothing', () => {
  const page = read('src/app/orders/[id]/payment-plan/page.tsx')
  assert.match(page, /<OrderPaymentPlan\b/)
  assert.match(page, /caps\.canViewPaymentPlan/)
  assert.match(page, /canEdit=\{ready\.caps\.canEditPaymentPlan\}/)
  assert.match(page, /Back to the Order/)
  assert.match(page, /You do not have access to the Payment plan/)
})

test('the section talks only to its own five functions, and the PDF route runs as the caller', () => {
  const ui = read('src/app/orders/[id]/OrderPaymentPlan.tsx')
  const called = [...ui.matchAll(/supabase\.rpc\('([a-z_]+)'/g)].map(m => m[1]).sort()
  assert.deepEqual(called, [
    'order_dispatch_lot_admin_change', 'order_dispatch_lot_mark_dispatched', 'order_dispatch_lot_save',
    'order_payment_plan_read', 'order_payment_plan_save',
  ])
  // the only table reads are the two the product pictures need
  assert.deepEqual([...ui.matchAll(/\.from\('([a-z_]+)'\)/g)].map(m => m[1]).sort(),
    ['order_submission_item_images', 'order_submission_items'])
  assert.match(ui, /createSignedUrls\(/)
  const route = read('src/app/api/orders/[id]/payment-plan/pdf/route.ts')
  assert.match(route, /rpc\('order_payment_plan_read'/)
  assert.doesNotMatch(route, /adminClient|service_role|SERVICE_ROLE/)
})
