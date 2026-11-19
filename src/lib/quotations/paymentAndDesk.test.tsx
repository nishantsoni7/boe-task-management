/**
 * Owner's three decisions of 18 Nov 2026 (migration 20270807000000): nothing waits for price approval, price suggestions go to the
 * pricing desk, and the bank account + UPI QR print on the quotation (never the Customer ID).
 * Run: npm run test:file -- src/lib/quotations/paymentAndDesk.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import ExcelJS from 'exceljs'
import '@/lib/testing/cssModuleStub'
import { QuotationDocument, hasPayment, type DocData } from '@/components/quotations/QuotationDocument'
import { buildClientWorkbook } from './clientWorkbook'
import type { PaymentDetails } from './api'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/20270807000000_quotation_payment_and_desk.sql'), 'utf8').replace(/\r/g, '')

describe('the migration', () => {
  test('price approval never blocks: blocked is false in the one function every gate reads', () => {
    assert.match(SQL, /create or replace function public\.quotation_price_state/)
    assert.match(SQL, /'blocked', false,/)
    assert.ok(!/\(c->>'needed'\)::boolean and v_state <> 'approved'/.test(SQL))
  })
  test('an empty shown_to means the pricing desk, and the row starts as the desk', () => {
    assert.match(SQL, /cardinality\(s\.shown_to\) = 0 and \(a\.p_admin or \(a\.p_edit and a\.p_view_all\)\)/)
    assert.match(SQL, /update public\.quotation_suggestion_settings set shown_to = '\{\}'::uuid\[\]/)
  })
  test('payment: the write and the full read are administrators only and closed to anon; the client read needs a link or a session and never returns the Customer ID', () => {
    for (const f of ['quotation_payment_get()', 'quotation_payment_set(jsonb)']) assert.match(SQL, new RegExp(`revoke all on function public\\.${f.replace(/[()]/g, '\\$&')} from public, anon;`))
    assert.match(SQL, /if not a\.p_admin then raise exception 'QUOTATIONS_FORBIDDEN: only an administrator (reads|changes) the payment settings'/g)
    const view = SQL.slice(SQL.indexOf('create or replace function public.quotation_payment_details'), SQL.indexOf('create or replace function public.quotation_payment_get'))
    assert.ok(!view.includes('customer_id') && view.includes("p_token ~ '^[0-9a-f]{32}$'") && view.includes("module_entry_open('quotations')"))
    assert.match(SQL, /alter table public\.quotation_payment_details enable row level security;/)
  })
})

const PAY: PaymentDetails = { account_holder: 'Best of Exports', bank: 'HDFC Bank', account_no: '99982000009999', ifsc: 'HDFC0004204', branch: 'Jodhpur, Rajasthan', upi_id: '9829383706@hdfc', qr_image: 'data:image/png;base64,AAAA' }
const doc = (): DocData => ({
  quote_no: 'QT-1', project_name: null, contact_name: null, issued_at: '2026-11-14T04:30:00Z', valid_days: 7, client_name: 'Aurora', salesperson: 'Nishant Soni', gst_mode: 'igst', discount_pct: 0,
  fabric_amount: 0, packing_amount: 0, transport_note: null, notes: null,
  areas: [{ key: 'a', name: 'Room', style: '', multiplier: 1, unit_label: 'rooms' }],
  lines: [{ key: 'l', area_key: 'a', name: 'Chair', size_text: '', spec: '', material: '', finish: '', category: '', qty_mode: 'per_unit', qty: 1, unit_price: 1000, tax_rate: 18, image_path: null, is_optional: false, client_note: '', internal_note: '' }],
})
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('the printed quotation', () => {
  const render = (payment?: PaymentDetails | null) => renderToStaticMarkup(<QuotationDocument doc={doc()} payment={payment} pictureUrl={p => p} />)
  test('shows the account, the UPI ID and the QR when there are details', () => {
    const h = render(PAY)
    const t = text(h)
    for (const v of ['Pay by bank transfer or UPI', 'HDFC Bank', '99982000009999', 'HDFC0004204', 'Jodhpur, Rajasthan', '9829383706@hdfc']) assert.ok(t.includes(v), v)
    assert.ok(h.includes('data:image/png;base64,AAAA'))
    assert.ok(!/Customer ID|271662686/i.test(h))
  })
  test('prints nothing when there are no details or they are empty', () => {
    for (const p of [undefined, null, { ...PAY, account_no: '', upi_id: '', qr_image: null }]) assert.ok(!render(p).includes('Pay by bank transfer'))
    assert.equal(hasPayment(PAY), true)
    assert.equal(hasPayment(null), false)
  })
})

describe('the Excel', () => {
  const head = { quoteNo: 'QT-1', clientName: 'C', projectName: '', issuedOn: '1 Jan 2027', validUntilOn: '8 Jan 2027', unit: 'in' as const, transportNote: '', notes: '', preparedBy: { name: 'N', title: '', phone: '', email: '' } }
  const build = async (payment: PaymentDetails | null) => {
    const d = doc()
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await buildClientWorkbook({ head, money: { gst_mode: 'igst', discount_pct: 0, fabric_amount: 0, packing_amount: 0 }, areas: d.areas, lines: d.lines, pictures: new Map(), payment }) as unknown as ArrayBuffer)
    const all: string[] = []
    wb.getWorksheet('Quotation')!.eachRow(r => r.eachCell(c => all.push(typeof c.value === 'object' && c.value && 'richText' in c.value ? c.value.richText.map(x => x.text).join('') : String(c.value))))
    return all.join('\n')
  }
  test('carries the payment details below the totals, never the Customer ID', async () => {
    const all = await build(PAY)
    for (const v of ['Pay by bank transfer or UPI', '99982000009999', 'HDFC0004204', '9829383706@hdfc']) assert.ok(all.includes(v), v)
    assert.ok(all.indexOf('Pay by bank transfer') > all.indexOf('Total including GST'))
    assert.ok(!all.includes('271662686'))
  })
  test('has no payment block without details', async () => {
    assert.ok(!(await build(null)).includes('Pay by bank transfer'))
  })
})
