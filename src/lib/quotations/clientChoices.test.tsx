/**
 * Client choices, PR 1 (owner, 18 Nov 2026; migration 20270808000100): what is saved, what the database allows, that the client's
 * copy is untouched, and the builder panel. Run: npm run test:file -- src/lib/quotations/clientChoices.test.tsx
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import '@/lib/testing/cssModuleStub'
import { CHOICE_KINDS, choiceCounts, cleanChoices, computeTotals, type LineChoices, type QuoteLine } from './math'
import { saveDoc, toLines } from './api'
import { ChoicesPanel } from '@/components/quotations/ChoicesPanel'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const SQL = read('supabase/migrations/20270808000100_quotation_client_choices.sql')
const PHOTO = '11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.jpg'

const line = (over: Partial<QuoteLine> = {}): QuoteLine => ({
  key: 'l1', area_key: null, name: 'Arm chair', size_text: '', spec: '', material: '', finish: '', category: '', qty_mode: 'fixed', qty: 2, unit_price: 1000,
  tax_rate: 18, image_path: null, is_optional: false, client_note: '', internal_note: '', ...over,
})
const header = { client_name: 'C' } as never

describe('what is saved', () => {
  test('only the kinds in use and the fields with something in them; text is trimmed; confirmed_on only when confirmed', () => {
    const c = cleanChoices({
      fabric: { source: 'catalog', status: 'confirmed', confirmed_on: '2026-11-18', name: '  Berlin velvet ', code: '', supplier: 'V2 Homes', photo: PHOTO },
      stone: { source: 'client', status: 'to_confirm', confirmed_on: '2026-11-18', name: 'Their slate' },
    })
    assert.deepEqual(Object.keys(c), ['fabric', 'stone'])
    assert.deepEqual(c.fabric, { source: 'catalog', status: 'confirmed', name: 'Berlin velvet', supplier: 'V2 Homes', photo: PHOTO, confirmed_on: '2026-11-18' })
    assert.deepEqual(c.stone, { source: 'client', status: 'to_confirm', name: 'Their slate' })
    assert.deepEqual(cleanChoices(undefined), {})
  })
  test('over-long text is cut to what the database allows', () => {
    assert.equal(cleanChoices({ finish: { source: 'catalog', status: 'to_confirm', name: 'x'.repeat(500), note: 'y'.repeat(900) } }).finish?.name?.length, 200)
    assert.equal(cleanChoices({ finish: { source: 'catalog', status: 'to_confirm', note: 'y'.repeat(900) } }).finish?.note?.length, 400)
  })
  test('the save document always carries client_choices (an empty object clears them), and a read-back line keeps them', () => {
    const choices: LineChoices = { rope_weave: { source: 'client', status: 'to_confirm', name: 'Flat rope' } }
    const doc = saveDoc(header, [], [line({ choices }), line({ key: 'l2' })], '2026-11-18T00:00:00Z')
    assert.deepEqual(doc.lines[0].client_choices, choices)
    assert.deepEqual(doc.lines[1].client_choices, {})
    const [back, none] = toLines([
      { id: 'a', area_id: null, name: 'Chair', size_text: null, material: null, finish: null, qty_per_unit: null, qty_fixed: 1, unit_price: 1, tax_rate: 18, image_path: null, is_optional: false, client_note: null, client_choices: choices },
      { id: 'b', area_id: null, name: 'Chair', size_text: null, material: null, finish: null, qty_per_unit: null, qty_fixed: 1, unit_price: 1, tax_rate: 18, image_path: null, is_optional: false, client_note: null, client_choices: {} },
    ])
    assert.deepEqual(back.choices, choices)
    assert.equal('choices' in none, false)
  })
  test('a choice never changes a price: the totals are the same with and without choices', () => {
    const money = { gst_mode: 'igst' as const, discount_pct: 5, fabric_amount: 1000, packing_amount: 500 }
    const plain = computeTotals(money, [], [line()])
    const withC = computeTotals(money, [], [line({ choices: { fabric: { source: 'catalog', status: 'confirmed', name: 'Silk' } } })])
    assert.deepEqual(withC, plain)
  })
  test('counts: how many choices, how many still wait', () => {
    assert.deepEqual(choiceCounts(undefined), { total: 0, open: 0 })
    assert.deepEqual(choiceCounts({ fabric: { source: 'catalog', status: 'confirmed' }, stone: { source: 'client', status: 'to_confirm' } }), { total: 2, open: 1 })
    assert.deepEqual([...CHOICE_KINDS], ['fabric', 'finish', 'stone', 'rope_weave'])
  })
})

describe('the migration', () => {
  test('a column on the line, checked, stored by quotation_save, with the old-tab fallback; the client copy is untouched', () => {
    assert.match(SQL, /add column client_choices jsonb not null default '\{\}'::jsonb/)
    assert.match(SQL, /check \(public\.quotation_line_choices_ok\(client_choices\)\)/)
    assert.match(SQL, /internal_note, reference_images, client_choices\)/)
    assert.match(SQL, /case when v \? 'client_choices' then/)
    assert.match(SQL, /old_choices->\(\(ord - 1\)::text/)
    assert.ok(!/quotation_client_doc|quotation_public/.test(SQL.replace(/^--.*$/gm, '')), 'neither the client copy nor the public read is replaced')
    assert.match(SQL, /revoke all on function public\.quotation_save\(uuid, jsonb\) from public, anon;/)
  })
})

describe('the builder panel', () => {
  const html = (choices: LineChoices | undefined, editable = true) => renderToStaticMarkup(
    <ChoicesPanel choices={choices} editable={editable} url={p => `https://img.example/${p}`} onChange={() => undefined} onUpload={async () => PHOTO} />)
  test('closed it shows the status chip: how many wait, or that all are confirmed', () => {
    assert.ok(html(undefined).includes('Client choices') && html(undefined).includes('fabric, finish, stone, rope weave'))
    assert.ok(html({ fabric: { source: 'catalog', status: 'to_confirm' } }).includes('1 to confirm'))
    assert.ok(html({ fabric: { source: 'catalog', status: 'confirmed' } }).includes('1 confirmed'))
  })
  test('it is a closed section until opened (collapsible), and has no price field', () => {
    assert.ok(html({ fabric: { source: 'catalog', status: 'to_confirm' } }).includes('aria-expanded="false"'))
    assert.ok(!/price/i.test(html(undefined)))
  })
})

describe('the builder wiring', () => {
  test('each product row shows the panel and uploads swatch photos through the quotation picture path', () => {
    const row = read('src/components/quotations/ProductLine.tsx')
    assert.match(row, /<ChoicesPanel choices=\{l\.choices\}/)
    // The upload function is made once (the product rows are memoized and take it as a prop), then handed to every row.
    const screen = read('src/components/quotations/BuilderScreen.tsx')
    assert.match(screen, /const uploadSwatch = useCallback\(\(f: File\) => \(profile \? uploadPicture\(supabase, profile\.id, f\)/)
    assert.match(screen, /onUploadSwatch=\{uploadSwatch\}/)
  })
  test('the client views draw the choices from step 2 on (migration 20270809000000): the document, the Excel sheet and the shared helpers, never the note', () => {
    assert.ok(read('src/components/quotations/QuotationDocument.tsx').includes('choiceRowsOf(doc.areas, doc.lines)'))
    assert.ok(read('src/lib/quotations/clientWorkbook.ts').includes('addChoicesSheet(wb, input)'))
    assert.ok(!read('src/lib/quotations/choicesDoc.ts').includes('.note'), 'the choice note is never read for the client')
  })
})
