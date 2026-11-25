/**
 * The client's copy shows the per-piece fabric and packing figures and the packing type (owner, 23 Nov 2026; migration 20270820000000), never the metres or a rate.
 * Run: npm run test:file -- src/lib/quotations/clientCosting.test.tsx
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import ExcelJS from 'exceljs'
import '@/lib/testing/cssModuleStub'
import { QuotationDocument, type DocData } from '@/components/quotations/QuotationDocument'
import { choiceRowsOf, hasChoices, lineCostWords } from './choicesDoc'
import { buildClientWorkbook } from './clientWorkbook'
import { toLines } from './api'
import type { CostingView, QuoteArea, QuoteLine } from './math'

const AREAS: QuoteArea[] = [{ key: 'a', name: 'Lobby lounge', style: '', multiplier: 1, unit_label: 'rooms' }]
const L = (n: number, over: Partial<QuoteLine> = {}): QuoteLine => ({
  key: `l${n}`, area_key: 'a', name: `Chair ${n}`, size_text: '', spec: '', material: '', finish: '', category: '', qty_mode: 'fixed', qty: 3, unit_price: 1000,
  tax_rate: 18, image_path: null, is_optional: false, client_note: '', internal_note: 'INTERNAL-NOTE-NEVER', ...over,
})
const VIEW: CostingView = { fabric: { per: 1360 }, packing: { type: 'Carton with foam corners', per: 650 } }
const withView = (n: number, v: CostingView, over: Partial<QuoteLine> = {}) => L(n, { costingView: v, ...over })
const doc = (lines: QuoteLine[]): DocData => ({
  quote_no: 'QT-1', project_name: null, contact_name: null, issued_at: '2026-11-14T04:30:00Z', valid_days: 7, client_name: 'Aurora', salesperson: 'N S', gst_mode: 'igst',
  discount_pct: 0, fabric_amount: 4080, packing_amount: 1950, transport_note: null, notes: null, areas: AREAS, lines,
})
const html = (lines: QuoteLine[]) => renderToStaticMarkup(<QuotationDocument doc={doc(lines)} pictureUrl={p => `/p/${p}`} />)
const plain = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const fabricChoice = { fabric: { source: 'catalog' as const, status: 'to_confirm' as const, name: 'Berlin velvet' } }

describe('which products are on the page', () => {
  test('a product with only packing figures gets a row; a product with nothing does not; with no costing the page is as before', () => {
    const rows = choiceRowsOf(AREAS, [L(1), withView(2, { packing: { per: 400 } }), withView(3, VIEW, { choices: fabricChoice })])
    assert.deepEqual(rows.map(r => r.line.key), ['l2', 'l3'])
    assert.equal(hasChoices([L(1)]), false)
    assert.equal(hasChoices([withView(1, { packing: { per: 400 } })]), true)
    assert.deepEqual(lineCostWords(L(1)), { fabric: '', packing: '' })
  })
})

describe('the link and the PDF page', () => {
  test('the fabric price per piece sits in the fabric cell and the packing line under the product', () => {
    const t = plain(html([withView(1, VIEW, { choices: fabricChoice })]))
    assert.match(t, /Berlin velvet/)
    assert.match(t, /₹1,360 per piece/)
    assert.match(t, /Packing: Carton with foam corners · ₹650 per piece/)
    assert.match(t, /Fabric and packing are added to the total; the other choices have no charge/)
  })
  test('no charge, waiting prices, and a packing-only product are worded plainly', () => {
    const t = plain(html([
      withView(1, { fabric: { free: true } }, { choices: { fabric: { source: 'client', status: 'to_confirm', name: 'Own linen' } } }),
      withView(2, { fabric: { wait: true }, packing: { type: 'Crate', wait: true } }, { choices: fabricChoice }),
      withView(3, { packing: { per: 400 } }),
    ]))
    assert.match(t, /No charge for the fabric/)
    assert.match(t, /Fabric price to be confirmed/)
    assert.match(t, /Packing: Crate · price to be confirmed/)
    assert.match(t, /Packing · ₹400 per piece/)
  })
  test('never the metres, a rate, the costing or the internal note', () => {
    const h = html([withView(1, VIEW, { choices: fabricChoice, costing: { fabric: { metres: 1.6, rate: 850 }, packing: { per_piece: 650 } } })])
    for (const s of ['INTERNAL-NOTE-NEVER', 'per metre', 'metres', '>850<', 'per_piece']) assert.ok(!h.includes(s), s)
  })
  test('a quotation with no costing prints exactly the Client choices page it printed before', () => {
    const t = plain(html([L(1, { choices: fabricChoice })]))
    assert.doesNotMatch(t, /per piece/)
    assert.doesNotMatch(t, /to be confirmed/)
  })
})

describe('the Excel', () => {
  const head = { quoteNo: 'QT-1', clientName: 'Aurora', projectName: '', issuedOn: '1 Jan 2027', validUntilOn: '8 Jan 2027', unit: 'in', transportNote: '', notes: '', preparedBy: { name: 'N', title: '', phone: '', email: '' } }
  const money = { gst_mode: 'igst' as const, discount_pct: 0, fabric_amount: 4080, packing_amount: 1950 }
  const all = (ws: ExcelJS.Worksheet) => { const o: string[] = []; ws.eachRow(r => r.eachCell(c => o.push(typeof c.value === 'object' && c.value && 'richText' in c.value ? c.value.richText.map(x => x.text).join('') : String(c.value)))); return o.join('\n') }
  test('the same words are on the Client choices sheet, and never a rate', async () => {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await buildClientWorkbook({ head, money, areas: AREAS, lines: [withView(1, VIEW, { choices: fabricChoice }), withView(2, { packing: { per: 400 } })], pictures: new Map() }) as unknown as ArrayBuffer)
    const t = all(wb.getWorksheet('Client choices')!)
    for (const s of ['₹1,360 per piece', 'Packing: Carton with foam corners · ₹650 per piece', 'Packing · ₹400 per piece']) assert.ok(t.includes(s), s)
    assert.ok(!/metres|per metre/.test(t))
  })
})

describe('where the figures come from', () => {
  test('a client copy takes the database\'s view; a staff copy works it out, and only for a line that has costing', () => {
    const [fromDb] = toLines([{ area_id: null, name: 'A', size_text: null, material: null, finish: null, qty_per_unit: null, qty_fixed: 3, unit_price: 1000, tax_rate: 18, image_path: null, is_optional: false, client_note: null, costing_view: VIEW }])
    assert.deepEqual(fromDb.costingView, VIEW)
    const [staff] = toLines([{ area_id: null, name: 'A', size_text: null, material: null, finish: null, qty_per_unit: null, qty_fixed: 3, unit_price: 1000, tax_rate: 18, image_path: null, is_optional: false, client_note: null,
      client_choices: fabricChoice, costing: { fabric: { metres: 1.6, rate: 850 }, packing: { per_piece: 650 } } }])
    assert.deepEqual(staff.costingView, { fabric: { per: 1360 }, packing: { per: 650 } })
    const [old] = toLines([{ area_id: null, name: 'A', size_text: null, material: null, finish: null, qty_per_unit: null, qty_fixed: 3, unit_price: 1000, tax_rate: 18, image_path: null, is_optional: false, client_note: null, client_choices: fabricChoice }])
    assert.equal(old.costingView, undefined, 'a version sent before the change, with a named fabric and no costing, shows nothing new')
  })
  test('the migration replaces only functions, never reads the metres or the rate into the client document', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20270820000000_quotation_client_costing_view.sql'), 'utf8').replace(/\r/g, '').replace(/--.*$/gm, '')
    assert.match(sql, /create or replace function public\.quotation_client_doc\(p_id uuid\)/)
    assert.match(sql, /jsonb_build_object\('costing_view', public\.quotation_costing_view\(l\.client_choices, l\.costing\)\)/)
    assert.ok(!/\b(alter|drop)\s+table\b|create\s+table/i.test(sql))
    assert.ok(!/'costing',/.test(sql), 'the raw costing is never put into the document')
  })
})
