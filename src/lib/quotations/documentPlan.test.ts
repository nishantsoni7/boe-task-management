/**
 * The premium client document's decisions (owner-approved 14 Nov 2026): the lead-time rules and their edges, amounts in words,
 * and which products, price rows and terms go on which A4 page. The pages drawn from this plan are read back in a real
 * browser (PDF page count equals the planned sheets, nothing overflows) when the document is built; here the plan itself.
 *
 * Run:
 *   npm run test:file -- src/lib/quotations/documentPlan.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  PROJECT_TYPES, cardUnits, compactAmount, countsRooms, countsSeats, documentFileName, groupsOf, leadTimeRule, numberInWords, planInvestmentPages,
  OPTIONAL_LISTED, planProductPages, planTermsPages, projectTypeLabel, roomsOf, rupeesInWords, summaryUnits, toProjectType, PRODUCT_PAGE_UNITS, TERMS_PAGE_CHARS,
} from './documentPlan'
import { EXPECTATIONS, TERMS } from './terms'
import type { QuoteArea, QuoteLine } from './math'

const area = (key: string, multiplier = 1, name = key): QuoteArea => ({ key, name, style: '', multiplier, unit_label: 'rooms' })
const line = (n: number, areaKey: string | null, over: Partial<QuoteLine> = {}): QuoteLine => ({
  key: `l${n}`, area_key: areaKey, name: `Product ${n}`, size_text: '20 x 30', spec: '', material: 'Ash wood', finish: '', category: '',
  qty_mode: 'per_unit', qty: 1, unit_price: 1000, tax_rate: 18, image_path: null, is_optional: false, client_note: '', internal_note: '', ...over,
})
const lines = (n: number, areaKey: string | null, from = 0) => Array.from({ length: n }, (_, i) => line(from + i, areaKey))

describe('project types', () => {
  test('six kinds of venue; rooms count for hotel and resort, seats for restaurant, cafe and brewery, nothing for other', () => {
    assert.deepEqual(PROJECT_TYPES.map(([k]) => k), ['hotel', 'resort', 'restaurant', 'cafe', 'brewery', 'other'])
    assert.deepEqual(PROJECT_TYPES.filter(([k]) => countsRooms(k)).map(([k]) => k), ['hotel', 'resort'])
    assert.deepEqual(PROJECT_TYPES.filter(([k]) => countsSeats(k)).map(([k]) => k), ['restaurant', 'cafe', 'brewery'])
    assert.equal(toProjectType('castle'), null); assert.equal(toProjectType(''), null); assert.equal(toProjectType('cafe'), 'cafe')
    assert.equal(projectTypeLabel('cafe'), 'Café'); assert.equal(projectTypeLabel('nope'), '')
  })
  test('the migration and the code list the same project types', () => {
    const sql = readFileSync('supabase/migrations/20270717000000_quotation_document_fields.sql', 'utf8')
    for (const [k] of PROJECT_TYPES) assert.ok(sql.includes(`'${k}'`), k)
  })
})

describe('lead time, from the advance (owner, 13 Nov 2026)', () => {
  test('a hotel by rooms: up to 30 → 10 weeks, 31 to 100 → 14, more than 100 → 16 (the lower band keeps its edge)', () => {
    const w = (rooms: number) => leadTimeRule('hotel', rooms, null)?.weeks
    assert.deepEqual([1, 29, 30, 31, 56, 99, 100, 101, 500].map(w), [10, 10, 10, 14, 14, 14, 14, 16, 16])
  })
  test('a resort follows the hotel rows', () => {
    for (const r of [12, 30, 31, 100, 101]) assert.equal(leadTimeRule('resort', r, null)?.weeks, leadTimeRule('hotel', r, null)?.weeks)
  })
  test('a restaurant by seats: up to 200 → 8 weeks (also below 50), 201 to 500 → 10, more than 500 → 12; cafe and brewery follow it', () => {
    for (const t of ['restaurant', 'cafe', 'brewery'] as const) {
      assert.deepEqual([10, 49, 50, 200, 201, 500, 501, 2000].map(s => leadTimeRule(t, 0, s)?.weeks), [8, 8, 8, 8, 10, 10, 12, 12], t)
    }
  })
  test('rooms do not move a restaurant and seats do not move a hotel', () => {
    assert.equal(leadTimeRule('restaurant', 500, 100)?.weeks, 8)
    assert.equal(leadTimeRule('hotel', 20, 5000)?.weeks, 10)
  })
  test('other, no type, no rooms or no seats print nothing', () => {
    assert.equal(leadTimeRule('other', 100, 100), null); assert.equal(leadTimeRule(null, 100, 100), null)
    assert.equal(leadTimeRule('hotel', 0, null), null); assert.equal(leadTimeRule('restaurant', 0, null), null); assert.equal(leadTimeRule('restaurant', 0, 0), null)
  })
  test('the basis says what the rule used, for the builder', () => {
    assert.equal(leadTimeRule('hotel', 56, null)?.basis, 'Hotel, 56 rooms (31 to 100 rooms)')
    assert.equal(leadTimeRule('brewery', 0, 640)?.basis, 'Brewery, 640 seats (more than 500 seats)')
  })
  test('rooms are the sum of the room-type multipliers', () => {
    assert.equal(roomsOf([area('a', 18), area('b', 56)]), 74); assert.equal(roomsOf([]), 0)
    assert.equal(roomsOf([{ multiplier: 2.7 }, { multiplier: -4 }, { multiplier: Number.NaN }]), 2)
  })
})

describe('amounts and counts in words (Indian grouping)', () => {
  test('numbers', () => {
    assert.equal(numberInWords(0), 'zero'); assert.equal(numberInWords(56), 'fifty-six'); assert.equal(numberInWords(100), 'one hundred')
    assert.equal(numberInWords(100000), 'one lakh'); assert.equal(numberInWords(6325036), 'sixty-three lakh twenty-five thousand thirty-six')
    assert.equal(numberInWords(10000000), 'one crore'); assert.equal(numberInWords(19), 'nineteen'); assert.equal(numberInWords(21), 'twenty-one')
  })
  test('rupees: "and" goes before the last group, nothing is invented for a round figure', () => {
    assert.equal(rupeesInWords(6325036), 'Rupees sixty-three lakh twenty-five thousand and thirty-six only')
    assert.equal(rupeesInWords(23812164), 'Rupees two crore thirty-eight lakh twelve thousand and one hundred sixty-four only')
    assert.equal(rupeesInWords(1000), 'Rupees one thousand only'); assert.equal(rupeesInWords(100), 'Rupees one hundred only')
    assert.equal(rupeesInWords(1234), 'Rupees one thousand and two hundred thirty-four only'); assert.equal(rupeesInWords(0), 'Rupees zero only')
  })
  test('the headline number: lakh, crore, or rupees', () => {
    assert.deepEqual(compactAmount(6325036), { value: '63.3', unit: 'Lakh' })
    assert.deepEqual(compactAmount(23812164), { value: '2.38', unit: 'Crore' })
    assert.deepEqual(compactAmount(45000), { value: '45,000', unit: 'Rupees' })
    assert.deepEqual(compactAmount(9999999), { value: '1', unit: 'Crore' }, '99.99 lakh rounds up to one crore, not to 100 lakh')
  })
  test('the saved file is named after the quotation and the project, with nothing a file name cannot hold', () => {
    assert.equal(documentFileName('QT-NS-01003', 'Aurora Boutique Resort', 'Aurora Hospitality'), 'QT-NS-01003 Aurora Boutique Resort')
    assert.equal(documentFileName('QT-NS-01003', null, 'Client / "A": B?'), 'QT-NS-01003 Client A B')
    assert.ok(documentFileName('QT-X', 'x'.repeat(300), 'c').length <= 90)
  })
})

describe('product pages', () => {
  const flat = (pages: ReturnType<typeof planProductPages>) => pages.flatMap(p => p.lines.map(l => l.key))
  test('four ordinary products fill a page (2 × 2); the fifth starts the next, marked as continued', () => {
    const pages = planProductPages(groupsOf([area('a', 56)], lines(5, 'a')))
    assert.deepEqual(pages.map(p => p.lines.length), [4, 1]); assert.deepEqual(pages.map(p => p.continued), [false, true])
  })
  test('every room type starts its own page, and the page names its room type', () => {
    const areas = [area('a', 10), area('b', 20)]
    const pages = planProductPages(groupsOf(areas, [...lines(2, 'a'), ...lines(2, 'b', 10)]))
    assert.deepEqual(pages.map(p => [p.area?.key, p.lines.length]), [['a', 2], ['b', 2]])
  })
  test('products with no room type come last, on their own pages', () => {
    const pages = planProductPages(groupsOf([area('a')], [...lines(1, 'a'), ...lines(1, null, 5), line(9, 'gone')]))
    assert.deepEqual(pages.map(p => p.area?.key ?? null), ['a', null]); assert.equal(pages[1].lines.length, 2)
  })
  test('every product is on exactly one page, in the order it was typed', () => {
    const ls = [...lines(9, 'a'), ...lines(7, 'b', 20)]
    assert.deepEqual(flat(planProductPages(groupsOf([area('a'), area('b')], ls))), ls.map(l => l.key))
  })
  test('long remarks cost room: a 1,600-character remark takes a page of its own, and two long ones do not share a row', () => {
    const long = (n: number) => line(n, 'a', { spec: 'x'.repeat(1600) })
    assert.ok(cardUnits(long(1)) > PRODUCT_PAGE_UNITS - 3)
    assert.deepEqual(planProductPages(groupsOf([area('a')], [long(1), line(2, 'a'), line(3, 'a')])).map(p => p.lines.length), [1, 2])
    const mid = (n: number) => line(n, 'a', { spec: 'y'.repeat(400) })
    assert.deepEqual(planProductPages(groupsOf([area('a')], [mid(1), mid(2), mid(3), mid(4), mid(5)])).map(p => p.lines.length), [2, 2, 1], 'two rows of 400-character remarks do not fit one page')
  })
  test('a longer name and longer material count for more than a short one', () => {
    assert.ok(cardUnits(line(1, 'a', { name: 'A very long product name that wraps' })) > cardUnits(line(1, 'a')))
    assert.ok(cardUnits(line(1, 'a', { material: 'm'.repeat(120) })) > cardUnits(line(1, 'a')))
  })
  test('no lines, no pages', () => assert.deepEqual(planProductPages([]), []))
})

describe('price table pages', () => {
  const keys = (pages: ReturnType<typeof planInvestmentPages>) => pages.flatMap(p => p.rows.filter(r => r.kind === 'line').map(r => (r as { line: QuoteLine }).line.key))
  const small = summaryUnits({ sumRows: 2, optionalLines: 0, noteLines: 0 })
  test('a short quotation is one page with its summary', () => {
    const pages = planInvestmentPages(groupsOf([area('a', 5)], lines(4, 'a')), small)
    assert.equal(pages.length, 1); assert.deepEqual([pages[0].summary, pages[0].extras], [true, true]); assert.equal(pages[0].rows.length, 5, 'a room-type heading and four products')
  })
  test('no products still gives the summary page', () => assert.deepEqual(planInvestmentPages([], { main: 8, extras: 0 }), [{ rows: [], summary: true, extras: true }]))
  test('a long quotation splits; every product is on one page in order; only the last page carries the summary', () => {
    const ls = [...lines(30, 'a'), ...lines(20, 'b', 40)]
    const pages = planInvestmentPages(groupsOf([area('a', 3), area('b', 4)], ls), { main: 8, extras: 3 })
    assert.ok(pages.length >= 4)
    assert.deepEqual(keys(pages), ls.map(l => l.key))
    assert.deepEqual(pages.map(p => p.summary), pages.map((_, i) => i === pages.length - 1))
  })
  test('a room-type heading is never the last row of a page', () => {
    for (let n = 10; n <= 40; n++) {
      const pages = planInvestmentPages(groupsOf([area('a', 2), area('b', 2), area('c', 2)], [...lines(n, 'a'), ...lines(n, 'b', 100), ...lines(n, 'c', 200)]), { main: 8, extras: 3 })
      for (const p of pages) if (p.rows.length) assert.notEqual(p.rows[p.rows.length - 1].kind, 'group', `n=${n}`)
    }
  })
  test('optional products are not rows of the table', () => {
    const ls = [line(1, 'a'), line(2, 'a', { is_optional: true }), line(3, 'a')]
    assert.deepEqual(keys(planInvestmentPages(groupsOf([area('a', 2)], ls), small)), ['l1', 'l3'])
    assert.deepEqual(planInvestmentPages(groupsOf([area('a')], [line(1, 'a', { is_optional: true })]), small), [{ rows: [], summary: true, extras: true }])
  })
  test('a summary that does not fit under the last rows goes on a page of its own', () => {
    const pages = planInvestmentPages(groupsOf([area('a', 2)], lines(14, 'a')), { main: 12, extras: 0 })
    assert.deepEqual(pages.map(p => [p.rows.length, p.summary]), [[15, false], [0, true]])
  })
  test('notes and optional boxes too long to sit under the summary get a last page; nothing loops or is lost', () => {
    const need = summaryUnits({ sumRows: 4, optionalLines: 20, noteLines: 20 })
    assert.ok(need.main + need.extras > 17)
    const pages = planInvestmentPages(groupsOf([area('a', 2)], lines(3, 'a')), need)
    assert.deepEqual(pages.map(p => [p.summary, p.extras]), [[true, false], [false, true]])
    assert.deepEqual(keys(pages), ['l0', 'l1', 'l2'])
    // however large the figures, the plan ends and the summary appears exactly once
    for (const huge of [{ main: 40, extras: 40 }, { main: 0, extras: 99 }, { main: 99, extras: 0 }]) {
      const p = planInvestmentPages(groupsOf([area('a', 2)], lines(9, 'a')), huge)
      assert.equal(p.filter(x => x.summary).length, 1); assert.equal(keys(p).length, 9)
    }
  })
  test('the summary grows with its sum rows, optional products and notes', () => {
    const base = summaryUnits({ sumRows: 2, optionalLines: 0, noteLines: 0 })
    assert.ok(summaryUnits({ sumRows: 6, optionalLines: 0, noteLines: 0 }).main > base.main)
    assert.ok(summaryUnits({ sumRows: 2, optionalLines: 3, noteLines: 0 }).extras > summaryUnits({ sumRows: 2, optionalLines: 1, noteLines: 0 }).extras)
    assert.ok(summaryUnits({ sumRows: 2, optionalLines: 0, noteLines: 4 }).extras > summaryUnits({ sumRows: 2, optionalLines: 0, noteLines: 1 }).extras)
    assert.equal(base.extras, 0)
    assert.equal(summaryUnits({ sumRows: 2, optionalLines: 500, noteLines: 0 }).extras, summaryUnits({ sumRows: 2, optionalLines: OPTIONAL_LISTED + 1, noteLines: 0 }).extras, 'only the listed ones take room')
  })
})

describe('terms pages', () => {
  const blocks = [{ heading: 'What we expect', items: EXPECTATIONS }, { heading: 'Terms and Conditions', items: TERMS }]
  test('all 7 expectations and 23 terms are on the pages, once each, in order, in at least one page', () => {
    const pages = planTermsPages(blocks)
    assert.ok(pages.length >= 1)
    assert.deepEqual(pages.flat().flatMap(s => s.items.map(i => i.title)), [...EXPECTATIONS, ...TERMS].map(t => t.title))
  })
  test('a heading is printed once, with the first of its terms, and a page never starts empty', () => {
    const pages = planTermsPages(blocks)
    assert.deepEqual(pages.flat().filter(s => s.heading).map(s => s.heading), ['What we expect', 'Terms and Conditions'])
    for (const p of pages) { assert.ok(p.length > 0); for (const s of p) assert.ok(s.items.length > 0) }
  })
  test('no page carries much more than the budget', () => {
    for (const p of planTermsPages(blocks)) {
      const chars = p.flatMap(s => s.items).reduce((t, i) => t + i.text.length + i.title.length + 90, 0)
      assert.ok(chars <= TERMS_PAGE_CHARS + 1200, String(chars))
    }
  })
})
