/**
 * Client choices, step 2 (owner, 18 Nov 2026; migration 20270809000000): the client's copy, the PDF page, the Excel sheet and the picture route carry
 * the choices. Confirmed AND to-confirm rows both print; the choice's own note and the internal note never do.
 * Run: npm run test:file -- src/lib/quotations/clientChoicesOutput.test.tsx
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import ExcelJS from 'exceljs'
import sharp from 'sharp'
import '@/lib/testing/cssModuleStub'
import { QuotationDocument, type DocData } from '@/components/quotations/QuotationDocument'
import { CHOICE_FIRST_UNITS, CHOICE_NEXT_UNITS, CHOICE_SIGN_UNITS, choiceRowUnits, choiceRowsOf, choiceWords, hasChoices, planChoicePages, sourceText, statusText } from './choicesDoc'
import { buildClientWorkbook, type SheetPicture } from './clientWorkbook'
import { lineHoldsPicture } from './pictureStore'
import type { LineChoices, QuoteArea, QuoteLine } from './math'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const SQL = read('supabase/migrations/20270809000000_quotation_client_choices_output.sql')
const PHOTO = '00000000-0000-0000-0000-0000000000b2/44444444-1111-1111-1111-111111111111.jpg'

const AREAS: QuoteArea[] = [{ key: 'a', name: 'Boho room', style: '', multiplier: 1, unit_label: 'rooms' }]
const CH: LineChoices = {
  fabric: { source: 'catalog', name: 'Berlin velvet 30', code: 'F18', supplier: 'V2 Homes', used_for: 'Seat', note: 'FACTORY-ONLY-NOTE', photo: PHOTO, status: 'confirmed', confirmed_on: '2026-11-18' },
  stone: { source: 'client', name: 'Their own slate', status: 'to_confirm' },
}
const L = (n: number, over: Partial<QuoteLine> = {}): QuoteLine => ({
  key: `l${n}`, area_key: 'a', name: `Chair ${n}`, size_text: '', spec: '', material: '', finish: 'FINISH-NEVER', category: '', qty_mode: 'per_unit', qty: 1, unit_price: 1000,
  tax_rate: 18, image_path: null, is_optional: false, client_note: '', internal_note: 'INTERNAL-NOTE-NEVER', choices: CH, ...over,
})
const doc = (lines: QuoteLine[]): DocData => ({
  quote_no: 'QT-1', project_name: null, contact_name: null, issued_at: '2026-11-14T04:30:00Z', valid_days: 7, client_name: 'Aurora', salesperson: 'N S', gst_mode: 'igst',
  discount_pct: 0, fabric_amount: 0, packing_amount: 0, transport_note: null, notes: null, areas: AREAS, lines,
})
const html = (lines: QuoteLine[]) => renderToStaticMarkup(<QuotationDocument doc={doc(lines)} pictureUrl={p => `/p/${p}`} />)
const plain = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
/** The column heads of the choices table. */
const heads = (h: string) => [...(/<table class="[^"]*chtbl[^"]*"><thead><tr>(.*?)<\/tr>/.exec(h)?.[1] ?? '').matchAll(/<th>(.*?)<\/th>/g)].map(m => m[1])

describe('the migration', () => {
  test('replaces only quotation_client_doc, leaves the note out, adds no key to a line without choices, changes no table', () => {
    assert.match(SQL, /create or replace function public\.quotation_client_doc\(p_id uuid\)/)
    assert.match(SQL, /e\.v - 'note'/)
    assert.match(SQL, /case when l\.client_choices <> '\{\}'::jsonb/)
    assert.ok(!/internal_note|cost/.test(SQL.replace(/--.*$/gm, '')), 'no internal field is read')
    assert.ok(!/\b(alter|create|drop)\s+table\b/i.test(SQL.replace(/--.*$/gm, '')))
    assert.match(SQL, /revoke all on function public\.quotation_client_doc\(uuid\) from public, anon, authenticated;/)
  })
})

describe('the helpers', () => {
  test('products with choices, in table order; both statuses; the words never include the note', () => {
    const rows = choiceRowsOf(AREAS, [L(1), L(2, { choices: undefined }), L(3, { choices: {} }), L(4)])
    assert.deepEqual(rows.map(r => r.line.key), ['l1', 'l4'])
    assert.equal(hasChoices([L(2, { choices: undefined })]), false)
    assert.equal(hasChoices([L(1)]), true)
    assert.deepEqual(choiceWords(CH.fabric!), ['Berlin velvet 30', 'F18 · V2 Homes', 'For: Seat'])
    assert.ok(!choiceWords(CH.fabric!).join(' ').includes('FACTORY-ONLY-NOTE'))
    assert.deepEqual([sourceText(CH.fabric!), sourceText(CH.stone!)], ['From our catalog', 'Client’s own'])
    assert.deepEqual([statusText(CH.fabric!), statusText(CH.stone!)], ['Confirmed 18 Nov 2026', 'To confirm'])
  })
  test('pages: one row fits one page, many rows make several, nothing is empty, and the signature lines never stand alone', () => {
    assert.equal(planChoicePages([]).length, 0)
    const rows = (n: number) => choiceRowsOf(AREAS, Array.from({ length: n }, (_, i) => L(i + 1)))
    assert.equal(planChoicePages(rows(1)).length, 1)
    for (const n of [2, 5, 6, 9, 25, 60]) {
      const pages = planChoicePages(rows(n))
      assert.equal(pages.flat().length, n, `every row is on a page (${n})`)
      assert.ok(pages.every(p => p.length > 0), `no empty page (${n})`)
      pages.forEach((p, i) => {
        const used = p.reduce((t, r) => t + choiceRowUnits(r), 0) + (i === pages.length - 1 ? CHOICE_SIGN_UNITS : 0)
        assert.ok(used <= (i === 0 ? CHOICE_FIRST_UNITS : CHOICE_NEXT_UNITS) || p.length === 1, `page ${i + 1} of ${n} fits`)
      })
    }
  })
})

describe('the printed quotation', () => {
  test('prints one Client choices page after the products and before the terms, with both statuses, the swatch and the signature lines', () => {
    const h = html([L(1), L(2, { choices: { fabric: CH.fabric } })])
    const t = plain(h)
    assert.equal((h.match(/aria-label="Client choices"/g) ?? []).length, 1)
    assert.ok(h.indexOf('aria-label="Products and prices"') < h.indexOf('aria-label="Client choices"') && h.indexOf('aria-label="Client choices"') < h.indexOf('aria-label="Terms and acceptance"'))
    for (const s of ['What you chose, and what is still open.', 'Berlin velvet 30', 'F18 · V2 Homes', 'For: Seat', 'Their own slate', 'Confirmed 18 Nov 2026', 'To confirm', 'From our catalog', 'Client’s own', 'Not used', 'For the client: name, date and signature', 'For Best of Exports: name and date']) assert.ok(t.includes(s), s)
    assert.ok(h.includes(`src="/p/${PHOTO}"`), 'the swatch goes through pictureUrl, so the logo switch applies to it')
    assert.deepEqual(heads(h), ['Product', 'Fabric', 'Stone'], 'only the choices this quotation uses get a column')
  })
  test('a choice with any name gets its own column, after the fixed kinds; more than four kinds share "Other choices"', () => {
    const leather = { source: 'client' as const, label: 'Leather', name: 'Tan nubuck', status: 'to_confirm' as const }
    const h = html([L(1, { choices: { ...CH, x_mf0b: leather } }), L(2, { choices: { x_mf0a: { ...leather, label: 'leather ', name: 'Black hide' } } })])
    assert.deepEqual(heads(h), ['Product', 'Fabric', 'Stone', 'leather'], 'the same name on two products is one column, named as first added')
    for (const s of ['Tan nubuck', 'Black hide']) assert.ok(plain(h).includes(s), s)
    const many: LineChoices = { ...CH, finish: { source: 'catalog', code: 'W-04', status: 'confirmed' }, rope_weave: { source: 'catalog', name: 'Flat rope', status: 'to_confirm' }, x_mf0a: { ...leather, name: 'Saddle tan' } }
    const h2 = html([L(1, { choices: many })])
    assert.deepEqual(heads(h2), ['Product', 'Fabric', 'Finish', 'Stone', 'Other choices'])
    const t2 = plain(h2)
    for (const s of ['Rope weave Flat rope', 'Leather Saddle tan']) assert.ok(t2.includes(s), s)
  })
  test('never prints the choice note, the internal note or the finish', () => {
    const t = plain(html([L(1)]))
    for (const s of ['FACTORY-ONLY-NOTE', 'INTERNAL-NOTE-NEVER', 'FINISH-NEVER']) assert.ok(!t.includes(s), s)
  })
  test('no choices, no page: the document is as before', () => {
    const h = html([L(1, { choices: undefined })])
    assert.ok(!h.includes('aria-label="Client choices"') && !plain(h).includes('What you chose'))
  })
  test('the page numbers follow: the terms page moves down by the choice pages', () => {
    const none = html([L(1, { choices: undefined })])
    const some = html([L(1)])
    const sign = (t: string) => Number(/Terms and acceptance<\/span><b>——<\/b><span>(\d+)/.exec(t)![1])
    assert.equal(sign(some), sign(none) + 1)
    const many = html(Array.from({ length: 12 }, (_, i) => L(i + 1)))
    assert.ok(sign(many) > sign(some))
  })
})

describe('the Excel', () => {
  const head = { quoteNo: 'QT-1', clientName: 'Aurora', projectName: '', issuedOn: '1 Jan 2027', validUntilOn: '8 Jan 2027', unit: 'in', transportNote: '', notes: '', preparedBy: { name: 'N', title: '', phone: '', email: '' } }
  const money = { gst_mode: 'igst' as const, discount_pct: 0, fabric_amount: 0, packing_amount: 0 }
  const build = async (lines: QuoteLine[], pictures = new Map<string, SheetPicture>()) => {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await buildClientWorkbook({ head, money, areas: AREAS, lines, pictures }) as unknown as ArrayBuffer)
    return wb
  }
  const all = (ws: ExcelJS.Worksheet) => { const o: string[] = []; ws.eachRow(r => r.eachCell(c => o.push(typeof c.value === 'object' && c.value && 'richText' in c.value ? c.value.richText.map(x => x.text).join('') : String(c.value)))); return o.join('\n') }

  test('a second sheet "Client choices" appears only when a product has a choice, and the first sheet does not change', async () => {
    const without = await build([L(1, { choices: undefined })])
    assert.deepEqual(without.worksheets.map(w => w.name), ['Quotation'])
    const withC = await build([L(1)])
    assert.deepEqual(withC.worksheets.map(w => w.name), ['Quotation', 'Client choices'])
    const a = without.getWorksheet('Quotation')!, b = withC.getWorksheet('Quotation')!
    assert.equal(all(a), all(b), 'the first sheet is the same with or without choices')
  })
  test('the sheet is the same table: both statuses, the source, a Not used cell, the signature lines, never a note', async () => {
    const wb = await build([L(1), L(2, { choices: { rope_weave: { source: 'catalog', name: 'Flat rope', status: 'to_confirm' } } })])
    const t = all(wb.getWorksheet('Client choices')!)
    for (const s of ['CLIENT CHOICES', 'Berlin velvet 30', 'F18 · V2 Homes', 'For: Seat', 'From our catalog · Confirmed 18 Nov 2026', 'Client’s own · To confirm', 'Flat rope', 'Not used', 'Fabric', 'Rope weave', 'For the client: name, date and signature', 'For Best of Exports: name and date']) assert.ok(t.includes(s), s)
    for (const s of ['FACTORY-ONLY-NOTE', 'INTERNAL-NOTE-NEVER', 'FINISH-NEVER']) assert.ok(!t.includes(s), s)
    assert.ok(!all(wb.getWorksheet('Quotation')!).includes('Berlin velvet'), 'the first sheet carries no choices')
  })
  test('the sheet has the PDF\'s columns: a choice with any name is a column; a single column still gets both signature lines', async () => {
    const wb = await build([L(1, { choices: { x_mf0a: { source: 'client', label: 'Leather', name: 'Tan nubuck', status: 'to_confirm' } } })])
    const ws = wb.getWorksheet('Client choices')!
    assert.deepEqual([1, 2, 3, 4].map(c => String(ws.getCell(5, c).value ?? '')), ['No.', 'Product', 'Leather', ''])
    const t = all(ws)
    for (const s of ['Tan nubuck', 'Client’s own · To confirm', 'For the client: name, date and signature', 'For Best of Exports: name and date']) assert.ok(t.includes(s), s)
  })
  test('a swatch picture is placed on the second sheet', async () => {
    const bytes = new Uint8Array(await sharp({ create: { width: 120, height: 80, channels: 3, background: { r: 90, g: 60, b: 40 } } }).jpeg().toBuffer())
    const wb = await build([L(1)], new Map([[PHOTO, { bytes, width: 120, height: 80 }]]))
    assert.equal(wb.getWorksheet('Client choices')!.getImages().length, 1)
    assert.equal(wb.getWorksheet('Quotation')!.getImages().length, 0)
  })
})

describe('the picture route', () => {
  test('a choice swatch counts as a picture the quotation uses, in its live lines and in sent versions, whatever the choice is called', () => {
    const p = PHOTO
    assert.equal(lineHoldsPicture({ image_path: p }, p), true)
    for (const k of ['fabric', 'finish', 'stone', 'rope_weave', 'x_mf0a1b2c']) assert.equal(lineHoldsPicture({ image_path: null, client_choices: { [k]: { photo: p } } }, p), true, k)
    for (const l of [null, 'x', {}, { image_path: 'other.jpg' }, { client_choices: { fabric: { photo: 'other.jpg' } } }, { client_choices: { fabric: null } }, { client_choices: 'x' }]) assert.equal(lineHoldsPicture(l, p), false, JSON.stringify(l))
    const route = read('src/app/api/quotations/picture-file/route.ts')
    assert.ok(route.includes("select('image_path, client_choices')") && route.includes('(used.data ?? []).some(l => lineHoldsPicture(l, path as string))'))
    assert.ok(route.includes('pictureRequestProblem(path, token, id)'), 'the path is still validated before it reaches a filter')
  })
})
