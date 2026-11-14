/**
 * The premium client quotation document (owner-approved 14 Nov 2026; migration 20270717000000): the A4 pages the print page,
 * the client link and the saved PDF all draw. What is pinned here is what a client reads and what must never reach them; the
 * look is read back in a real browser when the document is built (PDF page count equals the planned sheets, nothing overflows,
 * the rupee sign renders, the phone view). The database side runs in supabase/tests/quotations_pglite.mjs.
 *
 * Run:
 *   npm run test:file -- src/components/quotations/clientDocument.test.tsx
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import '@/lib/testing/cssModuleStub'
import { QuotationDocument, type DocData } from './QuotationDocument'
import { EXPECTATIONS, TERMS } from '@/lib/quotations/terms'
import { PROOF, planProductPages, groupsOf } from '@/lib/quotations/documentPlan'
import { fetchQuotation, type Quotation } from '@/lib/quotations/api'
import type { QuoteArea, QuoteLine } from '@/lib/quotations/math'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const CSS = read('src/components/quotations/document.module.css')

const L = (n: number, area: string | null, name: string, over: Partial<QuoteLine> = {}): QuoteLine => ({
  key: `l${n}`, area_key: area, name, size_text: '83 × 68', spec: '', material: 'Ash wood', finish: 'WALNUT-FINISH-NEVER-PRINTED', category: '',
  qty_mode: 'per_unit', qty: 1, unit_price: 40000, tax_rate: 18, image_path: `p/${n}.jpg`, is_optional: false, client_note: '',
  internal_note: 'NEVER-SHOWN-INTERNAL', ...over,
})
const AREAS: QuoteArea[] = [
  { key: 'a', name: 'Boho room', style: 'Boho', multiplier: 56, unit_label: 'rooms' },
  { key: 'b', name: 'Suite', style: '', multiplier: 12, unit_label: 'rooms' },
]
const doc = (over: Partial<DocData> = {}): DocData => ({
  quote_no: 'QT-NS-01003', version_no: 2, issued_at: '2026-11-14T04:30:00Z', valid_days: 7, client_name: 'Aurora Hospitality Pvt Ltd',
  project_name: 'Aurora Boutique Resort', contact_name: null, salesperson: 'Nishant Soni', gst_mode: 'igst', discount_pct: 5, fabric_amount: 0,
  packing_amount: 120000, transport_note: 'As per actual', notes: 'Prices are ex-factory.',
  areas: AREAS, lines: [L(1, 'a', 'Ravello Chair', { qty: 2 }), L(2, 'a', 'Torino Chair'), L(3, 'b', 'Verona Chair', { is_optional: true })], ...over,
})
const html = (d: DocData) => renderToStaticMarkup(<QuotationDocument doc={d} pictureUrl={p => `https://img.example/${p}`} />)
const plain = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ')
/** Everything before the standard terms: the pages the salesperson's own data fills. */
const beforeTerms = (h: string) => h.slice(0, h.indexOf('aria-label="Terms and conditions"'))
const sheets = (h: string) => [...h.matchAll(/<section class="(?:sheet|sheet cover)" aria-label="([^"]+)"/g)].map(m => m[1])

describe('the pages', () => {
  const h = html(doc())
  test('cover, at a glance, our work, products, investment, terms and acceptance, then the standard terms', () => {
    // two room types (the second holds only an optional product) give two product pages; the notes and the optional box do not fit under
    // the total of this small quotation, so they take a last investment page
    assert.deepEqual(sheets(h), ['Cover', 'At a glance', 'Our work', 'The products', 'The products', 'The investment', 'The investment', 'Terms and acceptance', 'Terms and conditions', 'Terms and conditions'])
  })
  test('the page numbers run on from 02 without a gap, and the signing page is the one named on page 2', () => {
    const nums = [...h.matchAll(/<span>(\d\d)<\/span><\/div>/g)].map(m => Number(m[1]))
    assert.deepEqual(nums, [2, 3, 4, 5, 6, 7, 8, 9, 10])
    assert.equal(sheets(h).indexOf('Terms and acceptance') + 1, 8)
    assert.ok(plain(h).includes('sign on page 08'), 'the terms and acceptance page is page 8 here')
  })
  test('there is no Accept button: the document says how to approve (reply, or sign) and nothing on it is a control', () => {
    assert.ok(!/<button|<a /.test(h))
    assert.ok(plain(h).includes('Reply “Approved” to Nishant, or sign on page 08'))
  })
  test('the cover shows the project, the client, the number with its version, the date and the validity', () => {
    const t = plain(h)
    for (const x of ['Aurora Boutique Resort', 'Aurora Hospitality Pvt Ltd', 'QT-NS-01003 · v2 · 14 Nov 2026', '21 Nov 2026']) assert.ok(t.includes(x), x)
  })
  test('a quotation with no project is titled with the client', () => {
    assert.ok(plain(html(doc({ project_name: null }))).includes('Quotation Aurora Hospitality Pvt Ltd'))
  })
  test('every class the document uses is in its stylesheet', () => {
    const used = new Set([...read('src/components/quotations/QuotationDocument.tsx').matchAll(/\bd\.(\w+)/g)].map(m => m[1]))
    const defined = new Set([...CSS.matchAll(/\.([a-zA-Z_]\w*)/g)].map(m => m[1]))
    for (const c of used) assert.ok(defined.has(c), `.${c} is used but not defined`)
  })
})

describe('what the client never sees', () => {
  const h = html(doc())
  test('no internal note, and no Finish: the owner has dropped it from the quotation', () => {
    assert.ok(!h.includes('NEVER-SHOWN-INTERNAL')); assert.ok(!h.includes('WALNUT-FINISH-NEVER-PRINTED'))
    // the owner's standard terms (the PI sheet) use the word in their own titles; the product and price pages never do
    const body = plain(h.slice(h.indexOf('aria-label="The products"'), h.indexOf('aria-label="Terms and acceptance"')))
    assert.ok(!/Finish/i.test(body), 'no Finish on the product and price pages')
  })
  test('no client phone or e-mail, and no "Attn." line; a contact person prints only as a name under "Prepared for"', () => {
    const d = { ...doc({ contact_name: 'Rahul Mehta' }), contact_phone: '+91 99999 11111', client_email: 'buyer@aurora.example' } as DocData
    const t = html(d)
    assert.ok(!t.includes('99999') && !t.includes('buyer@aurora.example') && !t.includes('Attn'))
    assert.ok(plain(t).includes('Rahul Mehta'))
  })
  test('no cost or price-explanation data: the suggested price, its reasons and the limits are not in the document', () => {
    assert.ok(!/suggest|why this price|last ordered|margin|cost price/i.test(plain(h)))
  })
  test('no placeholder is ever printed, and no photograph of a client venue that has not allowed it', () => {
    assert.ok(!/Venue name|City ·|Lorem|undefined|\bnull\b|\bNaN\b/.test(plain(beforeTerms(h))))
    const files = readdirSync(join(process.cwd(), 'public/quotation/work'))
    assert.ok(files.length >= 10); assert.ok(!files.some(f => /geist|rest-9|rest_9/i.test(f)))
    for (const f of [...html(doc({ project_type: 'hotel' })).matchAll(/src="(\/quotation\/[^"]+)"/g)].map(m => m[1])) assert.ok(existsSync(join(process.cwd(), 'public', f)), f)
  })
})

describe('the salesperson', () => {
  test('name, mobile and e-mail print on page 2 and page 6; the button-like box on page 2 carries the WhatsApp number', () => {
    const t = plain(html(doc({ salesperson_phone: '+91 90000 00001', salesperson_email: 'nishant@boe.example' })))
    assert.equal(t.split('+91 90000 00001').length - 1, 3, 'page 2 box, page 2 person, page 6 person')
    assert.ok(t.includes('nishant@boe.example') && t.includes('Reply “Approved” to Nishant on WhatsApp'))
  })
  test('without a mobile or e-mail nothing is made up: no number, no "on WhatsApp"', () => {
    const t = plain(html(doc()))
    assert.ok(!/\+91|@/.test(t)); assert.ok(!t.includes('on WhatsApp')); assert.ok(t.includes('Reply to Nishant'))
  })
})

describe('project type and lead time', () => {
  test('a stored lead time prints on page 2 and in the timeline, and a missing one prints nothing', () => {
    const t = plain(html(doc({ project_type: 'hotel', lead_time_weeks: 14 })))
    assert.ok(t.includes('Lead time 14 weeks from the day we receive your advance.')); assert.ok(t.includes('Production 14 weeks'))
    const n = plain(html(doc()))
    assert.ok(!n.includes('Lead time')); assert.ok(n.includes('Production Made to order')); assert.ok(!/\d+ weeks/.test(n))
  })
  test('the Our work page follows the kind of venue: hotels and resorts, restaurants and cafés, or a mix', () => {
    for (const t of ['hotel', 'resort']) assert.ok(plain(html(doc({ project_type: t }))).includes('Our work · hotels and resorts'), t)
    for (const t of ['restaurant', 'cafe', 'brewery']) assert.ok(plain(html(doc({ project_type: t }))).includes('Our work · restaurants, cafés and breweries'), t)
    for (const t of [null, 'other', 'castle']) assert.ok(plain(html(doc({ project_type: t }))).includes('Our work Spaces people remember'), String(t))
  })
  test('the first figure follows the venue: rooms for a hotel, seats for a restaurant; the headline says it in words', () => {
    const hotel = plain(html(doc({ project_type: 'hotel' })))
    assert.ok(hotel.includes('Sixty-eight rooms, made in our own Jodhpur workshop.') && /\b68 Rooms\b/.test(hotel))
    const rest = plain(html(doc({ project_type: 'restaurant', seats: 320, areas: [], lines: doc().lines.map(l => ({ ...l, area_key: null })) })))
    assert.ok(rest.includes('Seating for 320 guests, made in our own Jodhpur workshop.') && /\b320 Seats\b/.test(rest))
  })
  test('a copy frozen before the migration (no type, seats or weeks) still prints, with no stray words', () => {
    const t = plain(html(doc({ project_type: undefined, seats: undefined, lead_time_weeks: undefined })))
    assert.ok(t.includes('Grand total')); assert.ok(!/undefined|\bnull\b|\bNaN\b/.test(plain(beforeTerms(html(doc({ project_type: undefined, seats: undefined, lead_time_weeks: undefined }))))))
  })
})

describe('the figures', () => {
  test('the headline total, the amount in words and the payment split match the totals', () => {
    const t = plain(html(doc({ discount_pct: 0, packing_amount: 0, fabric_amount: 0, lines: [L(1, 'a', 'Bed', { unit_price: 100000 })] })))
    // 1 per room × 56 rooms × ₹1,00,000 = ₹56,00,000 + 18% IGST = ₹66,08,000
    assert.ok(t.includes('Grand total ₹66,08,000')); assert.ok(t.includes('Rupees sixty-six lakh eight thousand only'))
    assert.ok(t.includes('₹66.1 Lakh, including GST') || t.includes('₹66.1 Lakh , including GST') || /₹66\.1 Lakh, including GST/.test(t))
    assert.ok(t.includes('70% Advance, on confirmation of the order') && t.includes('30% Before dispatch'))
  })
  test('IGST or CGST + SGST, line by line, exactly as before', () => {
    assert.ok(plain(html(doc())).includes('IGST (18%)'))
    const c = plain(html(doc({ gst_mode: 'cgst_sgst' })))
    assert.ok(c.includes('CGST (9%)') && c.includes('SGST (9%)') && !c.includes('IGST'))
  })
  test('an optional product is shown but out of the total, and listed under it', () => {
    const t = plain(html(doc()))
    assert.ok(t.includes('optional, not in the total')); assert.ok(t.includes('Optional, not in the total Verona Chair · 12 pieces'))
  })
  test('the proof numbers are the owner\'s own, and printed on page 2 and the Our work page', () => {
    const t = plain(html(doc()))
    for (const p of PROOF) assert.equal(t.split(p.label).length - 1, 2, p.label)
    assert.deepEqual(PROOF.map(p => p.value), ['2,500+', '4.5', '70K+'])
  })
})

describe('the full terms stay part of the quotation', () => {
  test('all 7 expectations and 23 terms are on the annex pages, word for word', () => {
    const t = plain(html(doc()))
    for (const x of [...EXPECTATIONS, ...TERMS]) assert.ok(t.includes(x.title.replace(/\s+/g, ' ').slice(0, 40)), x.title)
    assert.ok(t.includes('sole area of jurisdiction will be Jodhpur'))
  })
})

describe('many products', () => {
  test('a heavy quotation plans a page per room type and keeps every product and every price', () => {
    const lines = Array.from({ length: 60 }, (_, i) => L(i, i % 2 ? 'a' : 'b', `Product ${i}`, { spec: i % 5 === 0 ? 'x'.repeat(500) : '' }))
    const d = doc({ lines })
    const h = html(d)
    assert.equal(planProductPages(groupsOf(d.areas, d.lines)).flatMap(p => p.lines).length, 60)
    for (let i = 0; i < 60; i++) assert.ok(h.includes(`Product ${i}<`) || h.includes(`Product ${i} `), `Product ${i}`)
    assert.ok(sheets(h).length > 20)
  })
  test('a quotation with nothing in it still draws, with no product pages', () => {
    const h = html(doc({ lines: [], areas: [] }))
    assert.ok(!sheets(h).includes('The products')); assert.ok(sheets(h).includes('The investment'))
  })
})

describe('a product with no picture, and what counts as a room (render of 14 Nov 2026)', () => {
  test('a product with no picture prints its text only, with no empty frame; one with a picture keeps its frame', () => {
    const none = html(doc({ lines: [L(1, 'a', 'Wardrobe', { image_path: null })] }))
    assert.ok(!none.includes('class="ph"'), 'no empty white frame')
    assert.ok(plain(none).includes('Wardrobe') && plain(none).includes('Ash wood'), 'the text is all there')
    assert.ok(html(doc({ lines: [L(1, 'a', 'Wardrobe')] })).includes('class="ph"'), 'a picture keeps its frame')
  })
  test('the frame is drawn only around a picture: in the source, not as an always-present box with a conditional inside', () => {
    assert.match(read('src/components/quotations/QuotationDocument.tsx'), /\{l\.image_path \? <div className=\{d\.ph\}><Pic /)
  })
  test('a Lobby and Restaurant on the unit "area" is not a room: the headline says forty-six rooms, not forty-seven', () => {
    const areas: QuoteArea[] = [
      { key: 'a', name: 'Deluxe Room', style: 'Heritage', multiplier: 40, unit_label: 'rooms' },
      { key: 'b', name: 'Suite', style: 'Heritage', multiplier: 6, unit_label: 'rooms' },
      { key: 'c', name: 'Lobby and Restaurant', style: '', multiplier: 1, unit_label: 'area' },
    ]
    const t = plain(html(doc({ areas, lines: [L(1, 'a', 'Bed'), L(2, 'b', 'Sofa'), L(3, 'c', 'Reception counter')], project_type: 'resort', lead_time_weeks: 14 })))
    assert.ok(t.includes('Forty-six rooms'), 'the headline')
    assert.ok(!t.includes('Forty-seven'))
  })
})

describe('print and the saved PDF', () => {
  test('the sheet is A4 on paper, with no page margin, backgrounds kept, and one sheet per page', () => {
    for (const x of ['@page { size: A4; margin: 0; }', 'print-color-adjust: exact', 'width: 210mm', 'break-before: page']) assert.ok(CSS.includes(x), x)
  })
  test('the fonts are self-hosted files that exist, the rupee sign has a face of its own, and Gilda is only used with a fallback that has the rupee', () => {
    for (const f of [...CSS.matchAll(/url\('\.\/fonts\/([^']+)'\)/g)].map(m => m[1])) assert.ok(existsSync(join(process.cwd(), 'src/components/quotations/fonts', f)), f)
    assert.ok(/unicode-range: U\+20B9;/.test(CSS)); assert.ok(CSS.includes("--f-disp: 'BOE Doc Gilda', 'BOE Doc Poppins'"))
    assert.ok(!/fonts\.googleapis|fonts\.gstatic/.test(CSS), 'no font is fetched from a third party')
  })
  test('on a phone and a small tablet (up to 800 px) the pages reflow with normal-size type (the type scale is replaced, not shrunk)', () => {
    assert.ok(/@media screen and \(max-width: 800px\)/.test(CSS)); assert.ok(/--fs-body: 14\.5px/.test(CSS))
  })
  test('on a screen the smallest labels never go under 9.5 px, and on paper they keep the catalogue size', () => {
    assert.ok(/@media screen \{ \.sheet \{ --fs-micro: max\(9\.5px, calc\(1\.08 \* var\(--u\)\)\); \} \}/.test(CSS))
    assert.ok(CSS.indexOf('@media screen { .sheet { --fs-micro') < CSS.indexOf('@media screen and (max-width: 800px)'), 'the phone scale still wins')
  })
  test('the Download PDF bar is a touch-size button on a phone', () => {
    assert.ok(read('src/components/quotations/screens.module.css').includes('.barHint { display: none; } .btn { min-height: 44px; } }'))
  })
  test('Download PDF waits for the fonts and pictures, names the file after the quotation, and puts the title back', () => {
    const src = read('src/components/quotations/DocumentScreens.tsx')
    for (const x of ['Download PDF', 'document.fonts?.ready', 'i.decode()', 'document.title = fileName', "'afterprint'", 'documentFileName(', "i.loading = 'eager'", '20_000']) assert.ok(src.includes(x), x)
    assert.ok(!src.includes('Print or save as PDF'))
  })
  test('the print page and the client link give the document the same facts, including the salesperson\'s contact and the new fields', () => {
    const src = read('src/components/quotations/DocumentScreens.tsx')
    for (const x of ['salesperson_phone: x.owner_phone', 'salesperson_email: x.owner_email', 'project_type: x.header.project_type', 'lead_time_weeks: x.header.lead_time_weeks']) assert.ok(src.includes(x), x)
  })
})

describe('loading time', () => {
  test('only the logo on the cover loads at once; every product picture and project photograph waits until it is near the screen', () => {
    const h = html(doc({ project_type: 'hotel' }))
    const imgs = [...h.matchAll(/<img [^>]*>/g)].map(m => m[0])
    assert.ok(imgs.length >= 7)
    const logo = imgs.filter(i => i.includes('boe-logo.png'))
    assert.equal(logo.length, 1); assert.ok(!logo[0].includes('loading='), 'the cover logo is not deferred')
    for (const i of imgs.filter(i => !i.includes('boe-logo.png'))) assert.ok(i.includes('loading="lazy"') && i.includes('decoding="async"'), i)
  })
  test('the page weighs what it needs: the fonts are the five small latin and rupee files plus Gilda, nothing is fetched from another host', () => {
    const sizes = readdirSync(join(process.cwd(), 'src/components/quotations/fonts')).map(f => statSync(join(process.cwd(), 'src/components/quotations/fonts', f)).size)
    assert.ok(sizes.reduce((a, b) => a + b, 0) < 60 * 1024, 'all the document fonts together stay under 60 KB')
    const photos = readdirSync(join(process.cwd(), 'public/quotation/work')).map(f => statSync(join(process.cwd(), 'public/quotation/work', f)).size)
    assert.ok(Math.max(...photos) < 200 * 1024, 'no project photograph is over 200 KB')
  })
})

describe('the data behind it', () => {
  test('quotation_get returns the salesperson\'s mobile and e-mail, and the header carries project type, seats and lead time', async () => {
    const row = { id: 'q', quote_no: 'QT-1', status: 'draft', client_name: 'X', project_type: 'restaurant', seats: 220, lead_time_weeks: 10, lead_time_reason: null, dimension_unit: 'in', gst_mode: 'igst' }
    const s = { rpc: async () => ({ data: { quotation: row, owner_name: 'N', owner_phone: '+91 1', owner_email: 'n@x.example', may_edit: true, areas: [], lines: [], events: [] }, error: null }) }
    const q: Quotation = await fetchQuotation(s as never, 'q')
    assert.deepEqual([q.owner_phone, q.owner_email, q.header.project_type, q.header.seats, q.header.lead_time_weeks, q.header.lead_time_reason], ['+91 1', 'n@x.example', 'restaurant', 220, 10, ''])
    const old = await fetchQuotation({ rpc: async () => ({ data: { quotation: { ...row, project_type: null, seats: null, lead_time_weeks: null }, owner_name: null, may_edit: true, areas: [], lines: [], events: [] }, error: null }) } as never, 'q')
    assert.deepEqual([old.owner_phone, old.header.project_type, old.header.seats, old.header.lead_time_weeks], [null, '', null, null], 'before the migration: blanks, never undefined')
  })
})
