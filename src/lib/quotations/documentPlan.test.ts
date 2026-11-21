/**
 * The premium client document's decisions (owner-approved 14 Nov 2026): the lead-time rules and their edges, amounts in words,
 * and which table rows and terms go on which A4 page. The pages drawn from this plan are read back in a real
 * browser (PDF page count equals the planned sheets, nothing overflows) when the document is built; here the plan itself.
 *
 * Run:
 *   npm run test:file -- src/lib/quotations/documentPlan.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  PROJECT_TYPES, compactAmount, countsRooms, countsSeats, documentFileName, groupsOf, leadTimeRule, numberInWords, planTablePages,
  planTermsPages, projectTypeLabel, roomsOf, rowUnits, rupeesInWords, summaryUnits, toProjectType, TERMS_PAGE_CHARS, TABLE_FIRST_UNITS, TABLE_NEXT_UNITS,
  THUMB_UNITS, lineUnits, noteLinesOf, type TablePage,
} from './documentPlan'
import { EXPECTATIONS, TERMS } from './terms'
import type { QuoteArea, QuoteLine } from './math'

const area = (key: string, multiplier = 1, name = key, unit_label = 'rooms'): QuoteArea => ({ key, name, style: '', multiplier, unit_label })
// A product has a picture unless a test says otherwise: most do, and a row without one is shorter.
const line = (n: number, areaKey: string | null, over: Partial<QuoteLine> = {}): QuoteLine => ({
  key: `l${n}`, area_key: areaKey, name: `Product ${n}`, size_text: '20 x 30', spec: '', material: 'Ash wood', finish: '', category: '',
  qty_mode: 'per_unit', qty: 1, unit_price: 1000, tax_rate: 18, image_path: 'u/p.jpg', is_optional: false, client_note: '', internal_note: '', ...over,
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

describe('products and prices: one table (owner, 18 Nov 2026)', () => {
  const keys = (pages: TablePage[]) => pages.flatMap(p => p.rows.filter(r => r.kind === 'line').map(r => (r as { line: QuoteLine }).line.key))
  const small = summaryUnits(2)
  test('a short quotation is one page: its room-type heading, its products and the summary under them', () => {
    const pages = planTablePages(groupsOf([area('a', 5)], lines(4, 'a')), small)
    assert.equal(pages.length, 1); assert.equal(pages[0].summary, true); assert.equal(pages[0].rows.length, 5)
  })
  test('room types do NOT start new pages: two small room types share one page', () => {
    const pages = planTablePages(groupsOf([area('a', 10), area('b', 20)], [...lines(2, 'a'), ...lines(1, 'b', 10)]), small)
    assert.equal(pages.length, 1)
    assert.deepEqual(pages[0].rows.map(r => r.kind === 'group' ? r.area.key : 'line'), ['a', 'line', 'line', 'b', 'line'])
  })
  test('no products still gives the summary page', () => assert.deepEqual(planTablePages([], 8), [{ rows: [], summary: true }]))
  test('a long quotation splits; every product, optional ones too, is on one page in the order typed; only the last page carries the summary', () => {
    const ls = [...lines(30, 'a'), line(35, 'a', { is_optional: true }), ...lines(20, 'b', 40), ...lines(3, null, 90)]
    const pages = planTablePages(groupsOf([area('a', 3), area('b', 4)], ls), summaryUnits(4))
    assert.ok(pages.length >= 5)
    assert.deepEqual(keys(pages), ls.map(l => l.key))
    assert.deepEqual(pages.map(p => p.summary), pages.map((_, i) => i === pages.length - 1))
  })
  test('a page that opens in the middle of a room type repeats its heading as "continued"', () => {
    const pages = planTablePages(groupsOf([area('a', 3)], lines(20, 'a')), small)
    assert.ok(pages.length >= 2)
    for (const p of pages.slice(1).filter(x => x.rows.length)) assert.deepEqual([p.rows[0].kind, p.rows[0].kind === 'group' && p.rows[0].continued], ['group', true])
    assert.ok(!(pages[0].rows[0].kind === 'group' && pages[0].rows[0].continued), 'the first heading is not "continued"')
  })
  test('a room-type heading is never the last row of a page', () => {
    for (let n = 3; n <= 24; n++) {
      const pages = planTablePages(groupsOf([area('a', 2), area('b', 2), area('c', 2)], [...lines(n, 'a'), ...lines(n, 'b', 100), ...lines(n, 'c', 200)]), small)
      for (const p of pages) if (p.rows.length) assert.notEqual(p.rows[p.rows.length - 1].kind, 'group', `n=${n}`)
    }
  })
  test('no page is planned past its room, so nothing runs off the A4 sheet', () => {
    const need = summaryUnits(6)
    for (const pic of [true, false]) for (const spec of ['', 'x'.repeat(90), 'y'.repeat(400)]) for (const n of [5, 12, 23, 40]) {
      const ls = Array.from({ length: n }, (_, i) => line(i, i < n / 2 ? 'a' : 'b', { image_path: pic || i % 3 === 0 ? 'u/p.jpg' : null, spec: i % 2 ? spec : '', name: i % 5 ? `Product ${i}` : 'Hand-carved Sheesham wood sofa three seater with arms' }))
      planTablePages(groupsOf([area('a', 4), area('b', 4)], ls), need).forEach((p, i) => {
        const used = p.rows.reduce((t, r) => t + rowUnits(r), 0) + (p.summary ? need : 0)
        assert.ok(used <= (i === 0 ? TABLE_FIRST_UNITS : TABLE_NEXT_UNITS), `${n} products, page ${i}: ${used}`)
      })
    }
  })
  test('when the totals do not fit under the last rows, they take a page of their own: no product is dragged over (owner, 21 Nov 2026)', () => {
    const pages = planTablePages(groupsOf([area('a', 2)], lines(7, 'a')), 80)
    assert.deepEqual(pages.map(p => [p.summary, p.rows.length]), [[false, 8], [true, 0]], 'every product stays on the first page')
    for (const huge of [200, 0, 199]) {
      const p = planTablePages(groupsOf([area('a', 2)], lines(9, 'a')), huge)
      assert.equal(p.filter(x => x.summary).length, 1); assert.equal(keys(p).length, 9)
    }
  })
  test('a row with a picture is never shorter than the picture; one without is shorter; long words cost more', () => {
    assert.ok(lineUnits(line(1, 'a')) >= THUMB_UNITS)
    assert.ok(lineUnits(line(1, 'a', { image_path: null })) < lineUnits(line(1, 'a')))
    assert.ok(lineUnits(line(1, 'a', { spec: 'x'.repeat(400) })) > lineUnits(line(1, 'a')))
    assert.ok(lineUnits(line(1, 'a', { image_path: null, name: 'A very long product name that wraps onto a second line' })) > lineUnits(line(1, 'a', { image_path: null })))
  })
  test('the summary grows with its sum rows; notes are counted in lines of about 85 characters', () => {
    assert.ok(summaryUnits(6) > summaryUnits(2))
    assert.ok(summaryUnits(2, 3) > summaryUnits(2) && summaryUnits(2, 0) === summaryUnits(2))
    assert.equal(noteLinesOf('Prices are ex-factory.\nSamples after the advance.', 'As per actual'), 3)
    assert.equal(noteLinesOf('x'.repeat(170), null), 2)
    assert.equal(noteLinesOf(null, null), 0)
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
