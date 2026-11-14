/**
 * The builder redesign (owner-approved 13 Nov 2026, migration 20270714000000): one dimensions unit per quotation, the new
 * client fields, GST out of the product line, "Note for the client" gone, and the "Needs you" strip. The picture pop-up's
 * keyboard is in pictureViewer.dom.test.tsx. The database side (columns, the note copy, the save and the client copy) is
 * run for real in supabase/tests/quotations_pglite.mjs.
 *
 * Run:
 *   npm run test:file -- src/components/quotations/builderRedesign.test.tsx
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import '@/lib/testing/cssModuleStub'
import { QuotationDocument, type DocData } from './QuotationDocument'
import { LineRow } from './ProductLine'
import { viewerItemsOf } from './PictureViewer'
import { fetchQuotation, saveDoc, type Header, type Quotation } from '@/lib/quotations/api'
import { sizeWithUnit, toDimensionUnit, type QuoteArea, type QuoteLine } from '@/lib/quotations/math'
import { needsYou } from '@/lib/quotations/needsYou'
import { addToQuote, type ImportRow } from '@/lib/quotations/importBoq'
import { compareDocs, type VersionDoc } from '@/lib/quotations/versions'
import { piFigures } from '@/lib/quotations/piWorkbook'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const MIGRATION = read('supabase/migrations/20270714000000_quotation_builder_fields.sql')

const line = (over: Partial<QuoteLine> = {}): QuoteLine => ({
  key: 'l1', area_key: null, name: 'Beds', size_text: '83 × 68', spec: '', material: 'Acacia Wood', finish: '', category: '',
  qty_mode: 'fixed', qty: 14, unit_price: 38500, tax_rate: 18, image_path: null, is_optional: false, client_note: '', internal_note: '', ...over,
})
const doc = (over: Partial<DocData> = {}): DocData => ({
  quote_no: 'QT-S-01002', issued_at: '2026-11-13T04:30:00Z', valid_days: 7, client_name: 'Mr. Nayan K', project_name: null, contact_name: null,
  salesperson: 'Saksham', gst_mode: 'igst', discount_pct: 0, fabric_amount: 0, packing_amount: 0, transport_note: null, notes: null,
  areas: [], lines: [line()], ...over,
})
const text = (d: DocData) => renderToStaticMarkup(<QuotationDocument doc={d} pictureUrl={p => `https://img.example/${p}`} />).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('one dimensions unit for the whole quotation', () => {
  test('a size typed without a unit gets the quotation unit; a size that carries its own is left as it is', () => {
    assert.equal(sizeWithUnit('83 × 68', 'in'), '83 × 68 in')
    assert.equal(sizeWithUnit('211 × 173', 'cm'), '211 × 173 cm')
    assert.equal(sizeWithUnit('Length - 42 Breadth - 24 Height - 18', 'in'), 'Length - 42 Breadth - 24 Height - 18 in')
    for (const own of [`6'0" × 6'6"`, '30x18x16 inches', '90 cm x 40 cm', '2 ft x 3 ft', '48"(Length) x 56"(Height)']) assert.equal(sizeWithUnit(own, 'cm'), own, own)
    assert.equal(sizeWithUnit('', 'cm'), '')
    assert.equal(sizeWithUnit(null, 'in'), '')
    // Real data: a size of "Standard" (no numbers) is a word, not a measurement: no unit after it.
    for (const word of ['Standard', 'As per sample', 'Custom']) assert.equal(sizeWithUnit(word, 'in'), word, word)
  })
  test('anything but cm reads as inches (a copy sent before the column existed has no unit)', () => {
    assert.equal(toDimensionUnit('cm'), 'cm')
    for (const v of ['in', undefined, null, '', 'm']) assert.equal(toDimensionUnit(v), 'in')
  })
  test('the printed quotation and the client link write the unit after a bare size, and the inches line only in inches', () => {
    const inches = text(doc())
    assert.ok(inches.includes('83 × 68 in'))
    const cm = text(doc({ dimension_unit: 'cm', lines: [line({ size_text: '211 × 173' })] }))
    assert.ok(cm.includes('211 × 173 cm'))
    assert.ok(!cm.includes('211 × 173 in'), 'a centimetre quotation never says inches for the same size')
    // feet and inches written out: the inches line stays in an inches quotation, and is not made up for a cm one
    assert.ok(text(doc({ lines: [line({ size_text: `6'0" × 6'6"` })] })).includes('72 × 78 in'))
    assert.ok(!text(doc({ dimension_unit: 'cm', lines: [line({ size_text: `6'0" × 6'6"` })] })).includes('72 × 78 in'))
  })
  test('company name and GSTIN print under "Prepared for" when set, and never when they are not; the email has no place on the document', () => {
    const t = text(doc({ company_name: 'Saksham Hospitality Pvt Ltd', client_gstin: '36AAAAA0000A1Z5' }))
    assert.ok(t.includes('Saksham Hospitality Pvt Ltd') && t.includes('GSTIN 36AAAAA0000A1Z5'))
    const plain = text(doc())
    assert.ok(!plain.includes('GSTIN'))
    assert.ok(!/client_email|@/.test(renderToStaticMarkup(<QuotationDocument doc={{ ...doc(), client_email: 'x@y.example' } as DocData} pictureUrl={p => p} />)))
  })
  test('a "note for the client" that an older copy still holds keeps printing (nothing is lost on an old version)', () => {
    assert.ok(text(doc({ lines: [line({ client_note: 'Decor, quoted separately' })] })).includes('Note: Decor, quoted separately'))
  })
  test('the PI workbook keeps centimetres labelled, and leaves inches as typed', () => {
    const base = { money: { gst_mode: 'igst' as const, discount_pct: 0, fabric_amount: 0, packing_amount: 0 }, areas: [] as QuoteArea[], lines: [line({ size_text: '211 × 173' })] }
    assert.equal(piFigures({ ...base, dimensionUnit: 'cm' }).lines[0].dimensions, '211 × 173 cm')
    assert.equal(piFigures({ ...base, dimensionUnit: 'in' }).lines[0].dimensions, '211 × 173')
    assert.equal(piFigures(base).lines[0].dimensions, '211 × 173')
  })
  test('a version compare says when the unit, the company name or the GSTIN changed, and calls the specification Remarks', () => {
    const v = (over: Partial<VersionDoc> = {}): VersionDoc => ({
      client_name: 'X', project_name: null, gst_mode: 'igst', discount_pct: 0, fabric_amount: 0, packing_amount: 0, transport_note: null, valid_days: 7, notes: null,
      areas: [], lines: [{ area_id: null, name: 'Bed', size_text: null, spec: 'old', material: null, finish: null, qty_per_unit: null, qty_fixed: '1', unit_price: '100', tax_rate: '18', image_path: null, is_optional: false, client_note: null }], ...over,
    })
    const c = compareDocs(v(), v({ dimension_unit: 'cm', company_name: 'Acme', client_gstin: '36AAAAA0000A1Z5', lines: [{ ...v().lines[0], spec: 'new' }] }))
    assert.deepEqual(c.header.map(h => [h.label, h.from, h.to]), [['Dimensions in', 'Inches', 'Centimetres'], ['Company name', '—', 'Acme'], ['GSTIN', '—', '36AAAAA0000A1Z5']])
    assert.equal(c.changed[0].changes[0].label, 'Remarks / customization')
    assert.equal(compareDocs(v(), v({ dimension_unit: 'in' })).header.length, 0, 'an old copy (no unit) and an inches copy are the same')
  })
})

describe('the quotation reads and saves the new fields', () => {
  const fakeDb = (q: Record<string, unknown>) => ({ rpc: async () => ({ data: { quotation: { id: 'q', quote_no: 'QT-S-01002', status: 'draft', gst_mode: 'igst', valid_days: 7, ...q }, owner_name: 'Saksham', may_edit: true, areas: [], lines: [], events: [] }, error: null }) })
  test('the header carries email, company name, GSTIN and the unit; a quotation made before the migration reads as inches with blanks', async () => {
    const withFields = await fetchQuotation(fakeDb({ client_email: 'a@b.example', company_name: 'Acme', client_gstin: '36AAAAA0000A1Z5', dimension_unit: 'cm' }) as never, 'q')
    assert.deepEqual([withFields.header.client_email, withFields.header.company_name, withFields.header.client_gstin, withFields.header.dimension_unit], ['a@b.example', 'Acme', '36AAAAA0000A1Z5', 'cm'])
    const before = await fetchQuotation(fakeDb({}) as never, 'q')
    assert.deepEqual([before.header.client_email, before.header.company_name, before.header.client_gstin, before.header.dimension_unit], ['', '', '', 'in'])
  })
  test('save sends the new fields in the header, and no product note for the client from the screen', () => {
    const header = { client_name: 'X', client_email: 'a@b.example', company_name: 'Acme', client_gstin: '36AAAAA0000A1Z5', dimension_unit: 'cm' } as Header
    const d = saveDoc(header, [], [line()], '2026-11-13T00:00:00Z')
    assert.deepEqual([d.header.client_email, d.header.company_name, d.header.client_gstin, d.header.dimension_unit], ['a@b.example', 'Acme', '36AAAAA0000A1Z5', 'cm'])
    assert.equal(d.lines[0].client_note, '', 'a new product has no note for the client')
  })
  test('an Import puts the client file\'s own note into Remarks, joined to its specification, not into a note for the client', () => {
    const row = (over: Partial<ImportRow>): ImportRow => ({ id: 'r', include: true, room: '', rooms: null, name: 'Bed', size: '', material: '', finish: '', spec: 'Teak', qty: 1, qtyMode: 'fixed', price: null, note: 'Pair per room', picture: null, doubtful: [], source: 'Row 2', ...over })
    const [a, b, c] = addToQuote([row({}), row({ spec: '', note: 'Only a note' }), row({ spec: 'Only spec', note: '' })], []).lines
    assert.deepEqual([a.spec, a.client_note], ['Teak\nPair per room', ''])
    assert.deepEqual([b.spec, b.client_note], ['Only a note', ''])
    assert.deepEqual([c.spec, c.client_note], ['Only spec', ''])
    assert.equal(addToQuote([row({ spec: 's'.repeat(1000), note: 'n'.repeat(500) })], []).lines[0].spec.length, 1501)
  })
})

describe('a product line (layout B)', () => {
  const noop = () => {}
  const draw = (l: QuoteLine, extra: { unit?: 'in' | 'cm'; editable?: boolean } = {}) => renderToStaticMarkup(
    <LineRow l={l} area={null} unit={extra.unit ?? 'in'} editable={extra.editable ?? true} qty={14} total={539000} first last url={p => `https://img.example/${p}`}
      onChange={noop} onUpload={noop} onImprove={noop} onView={noop} onRemove={noop} onMove={noop} onDuplicate={noop} />)
  test('it has Remarks / customization and a Material box of the same height, no GST box and no note for the client', () => {
    const html = draw(line())
    assert.match(html, /<textarea[^>]*aria-label="Material"[^>]*rows="3"/)
    assert.match(html, /<textarea[^>]*aria-label="Remarks \/ customization"[^>]*rows="3"/)
    assert.ok(!/Specification and customization|Note for the client|GST rate|aria-label="GST/i.test(html))
    assert.ok(html.includes('Price ₹ before GST'))
  })
  test('the unit sits inside the dimensions box and in its label, and follows the quotation', () => {
    assert.ok(draw(line()).includes('Dimensions (in)'))
    const cm = draw(line(), { unit: 'cm' })
    assert.ok(cm.includes('Dimensions (cm)') && !cm.includes('Dimensions (in)'))
  })
  test('the total shows the pieces; an optional product says it is not in the total', () => {
    assert.ok(draw(line()).includes('14 pieces'))
    assert.ok(draw(line({ is_optional: true })).includes('not in the total'))
  })
  test('a picture opens the pop-up; Replace and Remove sit beside Improve picture; a product without one offers Add picture', () => {
    const withPic = draw(line({ image_path: 'u/p.jpg' }))
    assert.match(withPic, /aria-label="View the picture of Beds"/)
    for (const w of ['Improve picture', 'Replace', 'Remove']) assert.ok(withPic.includes(w), w)
    const none = draw(line())
    assert.ok(none.includes('Add picture') && !none.includes('View the picture'))
    assert.ok(!draw(line({ image_path: 'u/p.jpg' }), { editable: false }).includes('Replace'), 'read-only: no picture tools')
  })
  test('the pop-up steps through the pictures in the order given, and skips products without one', () => {
    const items = viewerItemsOf([line({ key: 'a', name: 'Beds', image_path: 'x/1.jpg' }), line({ key: 'b', name: 'Lamp' }), line({ key: 'c', name: ' Table ', image_path: 'x/2.jpg', material: 'Acacia' })], 'cm')
    assert.deepEqual(items.map(i => i.key), ['a', 'c'])
    assert.equal(items[1].name, 'Table')
    assert.equal(items[1].detail, '83 × 68 cm · Acacia')
  })
})

describe('the "Needs you" strip', () => {
  const q = (over: Partial<Pick<Quotation, 'status' | 'may_edit' | 'request' | 'price'>>) => ({ status: 'draft' as const, may_edit: true, request: null, price: null, ...over })
  const request = (over = {}) => ({ id: 't', title: 'Quote', status: 'working', created_by: 'u1', assigned_to: 'u2', created_at: '', last_update_at: null, asked_by: 'Saksham', may_send: true, ...over })
  const price = (state: string, over = {}) => ({ needed: true, reasons: [], state, blocked: true, note: null, by: null, at: null, may_decide: false, ...over }) as Quotation['price']
  test('a quotation request waits on the person it is assigned to, and leaves once it is sent', () => {
    assert.deepEqual(needsYou(q({ request: request() })).map(n => n.key), ['request'])
    assert.equal(needsYou(q({ request: request({ may_send: false }) })).length, 0, 'not the assignee')
    assert.equal(needsYou(q({ request: request({ status: 'completed' }) })).length, 0, 'already sent')
  })
  test('prices: the salesperson is told to ask or that they were sent back, the desk that they are waiting; each leaves when the state changes', () => {
    assert.deepEqual(needsYou(q({ price: price('to_ask') })).map(n => n.key), ['price_ask'])
    assert.deepEqual(needsYou(q({ price: price('returned') })).map(n => n.key), ['price_returned'])
    assert.deepEqual(needsYou(q({ price: price('requested', { may_decide: true }), may_edit: false })).map(n => n.key), ['price_decide'])
    for (const state of ['requested', 'approved', 'not_needed']) assert.equal(needsYou(q({ price: price(state) })).length, 0, state)
    assert.equal(needsYou(q({ price: price('to_ask'), status: 'confirmed' })).length, 0, 'a locked quotation asks for nothing')
    assert.equal(needsYou(q({ price: price('to_ask'), may_edit: false })).length, 0, 'a reader is not asked')
  })
})

describe('the builder page', () => {
  const SCREEN = read('src/components/quotations/BuilderScreen.tsx')
  test('the right-hand column is gone: client and status on top, products, totals, terms, then the cards', () => {
    const at = (needle: string) => SCREEN.indexOf(needle)
    const order = ['className={s.statusBar}', 'Advanced client details', 'id="q-products"', 'id="q-extra"', 'id="q-terms"', 'className={s.bottom}'].map(at)
    assert.ok(order.every(i => i > 0), 'every section is on the page')
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'in that order')
    assert.ok(!/\bs\.split\b|\bs\.sticky\b|Valid for \(days\)/.test(SCREEN), 'no side column, no Valid for box')
  })
  test('the Advanced client details are closed until opened and hold the fields the owner named', () => {
    assert.match(SCREEN, /const \[advOpen, setAdvOpen\] = useState\(false\)/)
    const adv = SCREEN.slice(SCREEN.indexOf('id="q-advanced"'), SCREEN.indexOf('</section>', SCREEN.indexOf('id="q-advanced"')))
    for (const id of ['q-company', 'q-type', 'q-project', 'q-role', 'q-gst"', 'q-gstin']) assert.ok(adv.includes(id), id)
    const basic = SCREEN.slice(SCREEN.indexOf('className={s.clientGrid}'), SCREEN.indexOf('className={s.advBtn}'))
    for (const id of ['q-client-name', 'q-contact', 'q-phone', 'q-email', 'q-state']) assert.ok(basic.includes(id), id)
    assert.ok(!/q-company|q-gstin|q-type|q-project|q-role/.test(basic), 'nothing from Advanced on top')
  })
  test('one GST rate for all products, picked in the totals; a quotation with mixed rates says so', () => {
    assert.match(SCREEN, /id="q-gst-rate"/)
    assert.match(SCREEN, /Mixed rates/)
    assert.match(SCREEN, /setLines\(p => p\.map\(l => \(\{ \.\.\.l, tax_rate: rate \}\)\)\)/)
  })
  test('Save stays manual: the Unsaved changes badge, the leave warning and Ctrl+S are still there', () => {
    assert.ok(SCREEN.includes('Unsaved changes') && SCREEN.includes('beforeunload') && /ctrlKey \|\| e\.metaKey/.test(SCREEN))
    assert.match(SCREEN, /disabled=\{!dirty \|\| saving\}/)
  })
  test('every class the quotation screens use is in the module stylesheet (a missing one fails silently, with no styling)', () => {
    const css = read('src/components/quotations/quotations.module.css')
    const defined = new Set([...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(m => m[1]))
    const files = ['BuilderScreen', 'ProductLine', 'PictureViewer', 'RequestCard', 'PricingDesk', 'VersionsCard', 'ListScreen', 'ReportsScreen', 'ImportDialog', 'StudioDialog', 'QuotationLinks']
    for (const f of files) {
      const used = [...new Set([...read(`src/components/quotations/${f}.tsx`).matchAll(/\bs\.([A-Za-z_]\w*)/g)].map(m => m[1]))]
      assert.deepEqual(used.filter(c => !defined.has(c)), [], `${f}.tsx uses a class that quotations.module.css does not define`)
    }
  })
})

describe('the migration', () => {
  test('adds the four columns, copies the note into Remarks, and keeps what is stored when a save does not send a field', () => {
    assert.match(MIGRATION, /add column client_email\s+text/)
    assert.match(MIGRATION, /add column company_name\s+text/)
    assert.match(MIGRATION, /add column client_gstin\s+text/)
    assert.match(MIGRATION, /add column dimension_unit text not null default 'in' check \(dimension_unit in \('in', 'cm'\)\)/)
    assert.match(MIGRATION, /char_length\(spec\) <= 1600/)
    assert.match(MIGRATION, /client_note = null\s+where/)
    assert.match(MIGRATION, /case when h \? 'client_email' then/)
    assert.ok(!/drop column/i.test(MIGRATION), 'nothing is dropped')
  })
  test('the client copy has no email and no phone', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('function public.quotation_client_doc'))
    assert.ok(!/client_email|contact_phone|internal_note/.test(fn.slice(0, fn.indexOf('revoke all'))))
  })
})
