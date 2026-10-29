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

test('"To pay before this dispatch" reads across: goods + advance - received = balance, per row', () => {
  const { result, sheet } = build()
  assert.deepEqual(sheet.payColumns.map(c => c.title), ['Goods sent', 'Advance', 'Already received', 'Balance to pay'])
  assert.deepEqual(sheet.payColumns.map(c => c.op), [null, '+', '−', '='])
  for (const r of sheet.payRows) {
    const [goods, advance, received, balance] = r.cells
    assert.equal(goods + advance - received, balance, r.label)
  }
  const total = sheet.payRows.find(r => r.total)!
  assert.equal(total.cells[3], result.toCollectPaise)
  assert.deepEqual(sheet.payRows.map(r => r.label), ['Bank', 'Cash', 'Total'])
  assert.equal(sheet.title, 'Payment plan — Order 0539')
})

test('extra money in bank gets its own column, and every row still adds up', () => {
  const data = parsePlanData(raw)!
  const result = computePaymentPlan(inputFromData(data, {
    planned: plannedQuantities(data.lots), pendingPercent: 50, billingPercentOverride: null,
    advanceAccountOverride: 50000, advanceCashOverride: 0,
  }))
  const sheet = buildPaymentPlanSheet(data, result, { lotLines: {}, generatedOn: 'x', plannedOn: null })
  assert.deepEqual(sheet.payColumns.map(c => c.title), ['Goods sent', 'Advance', 'Already received', 'Extra in bank', 'Balance to pay'])
  for (const r of sheet.payRows) {
    const [goods, advance, received, extra, balance] = r.cells
    assert.equal(goods + advance - received + extra, balance, r.label)
  }
})

test('"How the amount is worked out": four columns that add up, and the carried cells feed the box', () => {
  const { result, sheet } = build()
  assert.deepEqual(sheet.calcColumns, ['Sent earlier', 'This lot', 'Still to come', 'Whole order'])
  const value = sheet.calcRows.find(r => r.label === 'Value')!
  const [earlier, lot, pending, whole] = value.cells as number[]
  assert.equal(earlier + lot + pending, whole)
  assert.equal(whole, result.totalBeforeGstPaise)
  const bank = sheet.calcRows.find(r => r.label === '— in bank')!
  const cash = sheet.calcRows.find(r => r.label === '— in cash')!
  assert.ok(bank.carried && cash.carried)
  const pay = (label: string) => sheet.payRows.find(r => r.label === label)!.cells
  assert.equal((bank.cells[0] as number) + (bank.cells[1] as number), pay('Bank')[0])
  assert.equal(bank.cells[2], pay('Bank')[1])
  assert.equal((cash.cells[0] as number) + (cash.cells[1] as number), pay('Cash')[0])
  assert.equal(cash.cells[2], pay('Cash')[1])
})

test('the notes keep the Finance caveat and the plan note; the subtitle names the lot', () => {
  const { sheet } = build()
  assert.ok(sheet.notes.some(n => /not counted yet/.test(n)))
  assert.ok(sheet.notes.includes('Client asked for the table first'))
  assert.match(sheet.subtitle, /Lot 2/)
  assert.deepEqual(sheet.lineColumns.map(c => c.label).slice(0, 6), ['Code', 'Item', 'Total qty', 'Sent earlier', 'This lot', 'Still to come'])
})

test('the Excel keeps numbers as numbers, in whole rupees', async () => {
  const { sheet, result } = build()
  const bytes = await buildPaymentPlanWorkbook(sheet)
  const XLSX = await import('xlsx')
  const wb = XLSX.read(bytes, { type: 'array' })
  const ws = wb.Sheets['Payment plan']
  assert.ok(ws)
  const rows = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, blankrows: false })
  const total = rows.filter(r => r[0] === 'Total').pop()
  assert.ok(total)
  assert.equal(typeof total[1], 'number')
  assert.equal(total[4], Math.round(result.toCollectPaise / 100))
  assert.ok(rows.some(r => r[0] === 'How the amount is worked out'))
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
  // every door it may call: the Order's five, and since 20270503000000 the BDPI's four (admin change is shared)
  const called = [...new Set([...ui.matchAll(/'((?:order|bdpi)_(?:payment_plan|dispatch_lot)_[a-z_]+)'/g)].map(m => m[1]))].sort()
  assert.deepEqual(called, [
    'bdpi_dispatch_lot_mark_dispatched', 'bdpi_dispatch_lot_save', 'bdpi_payment_plan_read', 'bdpi_payment_plan_save',
    'order_dispatch_lot_admin_change', 'order_dispatch_lot_mark_dispatched', 'order_dispatch_lot_save',
    'order_payment_plan_read', 'order_payment_plan_save',
  ])
  assert.equal([...ui.matchAll(/supabase\.rpc\(/g)].length, 5, 'five calls, through the door table or the shared admin change')
  // the only table reads are the two the product pictures need
  assert.deepEqual([...ui.matchAll(/\.from\('([a-z_]+)'\)/g)].map(m => m[1]).sort(),
    ['order_submission_item_images', 'order_submission_items'])
  assert.match(ui, /createSignedUrls\(/)
  const route = read('src/app/api/orders/[id]/payment-plan/pdf/route.ts')
  assert.match(route, /rpc\('order_payment_plan_read'/)
  assert.doesNotMatch(route, /adminClient|service_role|SERVICE_ROLE/)
})
