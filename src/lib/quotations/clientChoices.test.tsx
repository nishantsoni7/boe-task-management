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
import { CHOICE_KINDS, MAX_CHOICES, choiceCounts, choiceKeys, choiceLabel, cleanChoices, computeTotals, copyChoiceTo, newChoiceKey, type LineChoice, type LineChoices, type QuoteLine } from './math'
import { saveDoc, toLines } from './api'
import { ChoicesPanel, ChoicesSummary, settle } from '@/components/quotations/ChoicesPanel'

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

describe('choices with any name (step 3, 25 Nov 2026; 20270828000000)', () => {
  const leather: LineChoice = { source: 'client', status: 'to_confirm', label: ' Leather ', name: 'Tan nubuck' }
  test('the order: the four fixed kinds first, then the others in the order they were added; a key the database refuses is never read', () => {
    const c = { x_mf0b: leather, stone: { source: 'catalog', status: 'confirmed' }, x_mf0a: { ...leather, label: 'Cane' }, fabric: { source: 'catalog', status: 'to_confirm' }, leather: leather } as LineChoices
    assert.deepEqual(choiceKeys(c), ['fabric', 'stone', 'x_mf0a', 'x_mf0b'])
    assert.deepEqual(choiceKeys(c).map(k => choiceLabel(k, c[k])), ['Fabric', 'Stone', 'Cane', 'Leather'])
    assert.deepEqual(choiceCounts(c), { total: 4, open: 3 })
    assert.match(newChoiceKey(Date.UTC(2026, 10, 25)), /^x_[a-z0-9]{2,24}$/)
    assert.ok(newChoiceKey(1) < newChoiceKey(2) && newChoiceKey(Date.UTC(2026, 10, 25)) < newChoiceKey(Date.UTC(2026, 10, 26)), 'later keys sort later')
  })
  test('saved: the label trimmed and cut to 40, never on a fixed kind; a blank one saved as "Choice"; at most twelve', () => {
    const saved = cleanChoices({ x_mf0a: leather, fabric: { source: 'catalog', status: 'to_confirm', label: 'Fabric' }, x_mf0b: { ...leather, label: '  ' }, x_mf0c: { ...leather, label: 'x'.repeat(60) } })
    assert.deepEqual(saved.x_mf0a, { source: 'client', status: 'to_confirm', label: 'Leather', name: 'Tan nubuck' })
    assert.equal('label' in saved.fabric!, false)
    assert.equal(saved.x_mf0b!.label, 'Choice')
    assert.equal(saved.x_mf0c!.label!.length, 40)
    const many = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`x_k${String(i).padStart(2, '0')}`, leather])) as LineChoices
    assert.equal(Object.keys(cleanChoices(many)).length, MAX_CHOICES)
  })
  test('Done: a choice named like a free fixed kind moves to its key (so the Fabric and packing tab sees it); otherwise it stays', () => {
    const [moved, k] = settle({ x_mf0a: { source: 'catalog', status: 'to_confirm', label: ' fabric ', name: 'Velvet' } }, 'x_mf0a')
    assert.equal(k, 'fabric')
    assert.deepEqual(moved, { fabric: { source: 'catalog', status: 'to_confirm', name: 'Velvet' } })
    const taken: LineChoices = { fabric: { source: 'catalog', status: 'to_confirm' }, x_mf0a: { source: 'catalog', status: 'to_confirm', label: 'Fabric' } }
    assert.deepEqual(settle(taken, 'x_mf0a'), [taken, 'x_mf0a'], 'a second fabric stays a choice of its own')
    const other: LineChoices = { x_mf0a: leather }
    assert.deepEqual(settle(other, 'x_mf0a'), [other, 'x_mf0a'])
  })
  test('Copy to: the whole choice goes to the picked products, replacing one of the same name; a full product is left out', () => {
    const src = line({ key: 'a', choices: { x_mf0a: { ...leather, photo: PHOTO, note: 'Ask V2' }, fabric: { source: 'catalog', status: 'confirmed', name: 'Velvet' } } })
    const same = line({ key: 'b', choices: { x_zz01: { source: 'catalog', status: 'to_confirm', label: 'leather', name: 'Old hide' } } })
    const none = line({ key: 'c' })
    const full = line({ key: 'd', choices: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`x_k${String(i).padStart(2, '0')}`, { ...leather, label: `C${i}` }])) as LineChoices })
    const untouched = line({ key: 'e' })
    const r = copyChoiceTo([src, same, none, full, untouched], 'a', 'x_mf0a', new Set(['b', 'c', 'd']))
    assert.deepEqual([r.copied, r.full], [2, 1])
    assert.deepEqual(r.lines[1].choices, { x_zz01: { ...leather, label: 'Leather', photo: PHOTO, note: 'Ask V2' } }, 'replaced under its own key')
    assert.deepEqual(r.lines[2].choices, { x_mf0a: { ...leather, label: 'Leather', photo: PHOTO, note: 'Ask V2' } })
    assert.equal(r.lines[3], full)
    assert.equal(r.lines[4], untouched)
    const f = copyChoiceTo([src, same], 'a', 'fabric', new Set(['b']))
    assert.deepEqual(f.lines[1].choices?.fabric, { source: 'catalog', status: 'confirmed', name: 'Velvet' })
  })
})

describe('the builder panel (version 2, 25 Nov 2026: the product strip opens it and says what was chosen)', () => {
  const html = (choices: LineChoices | undefined, editable = true) => renderToStaticMarkup(
    <ChoicesPanel choices={choices} editable={editable} url={p => `https://img.example/${p}`} onChange={() => undefined} onUpload={async () => PHOTO} />).replace(/<!-- -->/g, '')
  const summary = (choices: LineChoices | undefined) => renderToStaticMarkup(<ChoicesSummary choices={choices} />).replace(/<!-- -->/g, '')
  test('closed, the strip says none yet, or the first two choices, how many more, and how many wait or that all are confirmed', () => {
    assert.match(summary(undefined), />none yet: fabric, finish or anything else</)
    assert.match(summary({}), />none yet: fabric, finish or anything else</, 'an empty set is no choices')
    const one = summary({ fabric: { source: 'catalog', status: 'to_confirm', name: 'Berlin velvet', code: 'F18' } })
    assert.ok(one.includes('>Fabric: Berlin velvet F18<') && one.includes('>1 to confirm<'))
    assert.ok(summary({ fabric: { source: 'catalog', status: 'confirmed', name: 'Silk' } }).includes('>1 confirmed<'))
    const many = summary({
      fabric: { source: 'client', status: 'confirmed' }, finish: { source: 'catalog', status: 'to_confirm' },
      stone: { source: 'catalog', status: 'to_confirm', name: 'Slate' }, rope_weave: { source: 'catalog', status: 'confirmed' },
    })
    assert.ok(many.includes('>Fabric: Client’s own<') && many.includes('>Finish: Not named yet<'), 'a choice without a name says whose it is')
    assert.ok(!many.includes('Slate') && many.includes('>+2 more<') && many.includes('>2 to confirm<'))
    assert.ok(summary({ fabric: { source: 'code', status: 'to_confirm', code: 'F-2210' } }).includes('>Fabric: Client’s code: F-2210<'))
    assert.ok(summary({ x_mf0a: { source: 'client', status: 'confirmed', label: 'Leather', name: 'Tan' } }).includes('>Leather: Tan<'), 'an any-name choice by its own name')
  })
  test('opened, each choice is a compact card: its photo (or "No photo"), a confirmed or to-confirm dot, the choice and the selection; no price box', () => {
    const body = html({ fabric: { source: 'catalog', status: 'confirmed', name: 'Berlin velvet', photo: PHOTO }, x_mf0a: { source: 'client', status: 'to_confirm', label: 'Leather', name: 'Tan nubuck' } })
    assert.equal((body.match(/class="ccCard"/g) ?? []).length, 2)
    assert.ok(body.includes(`src="https://img.example/${PHOTO}"`) && body.includes('No photo'))
    assert.ok(body.includes('aria-label="Confirmed by the client"') && body.includes('aria-label="To confirm"'))
    assert.ok(body.includes('>Fabric</span><b class="ccName">Berlin velvet</b>') && body.includes('>Leather · <em>to confirm</em></span><b class="ccName">Tan nubuck</b>'))
    assert.ok(body.includes('aria-label="Edit Fabric"') && body.includes('Add a choice'))
    assert.ok(!body.includes('aria-expanded') && !/<input[^>]*(aria-label|placeholder)="[^"]*price/i.test(body), 'no toggle of its own, no price box')
  })
  test('read only: no pencil and no Add; a product without choices says so', () => {
    const body = html({ fabric: { source: 'catalog', status: 'confirmed', name: 'Silk' } }, false)
    assert.ok(!body.includes('aria-label="Edit') && !body.includes('Add a choice'))
    assert.ok(html(undefined, false).includes('No choices yet.'))
  })
})

describe('the builder wiring', () => {
  test('each product row shows the summary in its strip, opens the panel from there, and uploads swatch photos through the quotation picture path', () => {
    const row = read('src/components/quotations/ProductLine.tsx')
    assert.match(row, /aria-expanded=\{choicesOpen\}[^\n]*\n\s*<Palette[^>]*\/> Client choices <ChoicesSummary choices=\{l\.choices\} \/>/)
    assert.match(row, /\{choicesOpen && \(\s*<ChoicesPanel choices=\{l\.choices\}/)
    assert.match(read('src/components/quotations/BuilderScreen.tsx'), /onUploadSwatch=\{f => \(profile \? uploadPicture\(supabase, profile\.id, f\)/)
  })
  test('the builder holds which products have their choices open, so one bar over the list opens or closes them all; Copy to… is its dialog', () => {
    const b = read('src/components/quotations/BuilderScreen.tsx')
    assert.ok(b.includes('choicesOpen={chOpen.has(l.key)} onChoicesOpen={open => openChoices(l.key, open)}'))
    assert.ok(b.includes('{withChoices.length > 0 && (') && b.includes('{withChoices.length} of {pageLines.length} products'))
    for (const s of ['Open only “to confirm”', '>Open all<', '>Close all<', 'setChOpen(new Set(waitingChoices.map(l => l.key)))', '<CopyChoiceDialog lines={pageLines}']) assert.ok(b.includes(s), s)
    assert.ok(b.includes("onCopyChoice={editable && lines.length > 1 ?"), 'Copy to… only where there is another product and the page can be edited')
  })
  test('the client views draw the choices from step 2 on (migration 20270809000000): the document, the Excel sheet and the shared helpers, never the note', () => {
    assert.ok(read('src/components/quotations/QuotationDocument.tsx').includes('choiceRowsOf(doc.areas, doc.lines)'))
    assert.ok(read('src/lib/quotations/clientWorkbook.ts').includes('addChoicesSheet(wb, input)'))
    assert.ok(!read('src/lib/quotations/choicesDoc.ts').includes('.note'), 'the choice note is never read for the client')
  })
})
