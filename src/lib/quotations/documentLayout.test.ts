/**
 * Three layout faults found by rendering a sample of the LIVE premium quotation (14 Nov 2026, 15 pages), fixed together:
 *   1. a half-empty product page: a name of 28 characters was planned as a two-line name, but it prints on one line;
 *   2. a product with no picture printed an empty white frame;
 *   3. a lobby or restaurant counted as rooms ("Forty-seven rooms" for 46).
 * The numbers below were MEASURED in the real render (headless Edge, the same A4 sheets the PDF uses), not guessed.
 *
 * Run: npm run test:file -- src/lib/quotations/documentLayout.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { NAME_LINE_CHARS, PICTURE_UNITS, PRODUCT_PAGE_UNITS, cardUnits, groupsOf, isRoomUnit, leadTimeRule, nameLines, planProductPages, roomsOf } from './documentPlan'
import type { QuoteArea, QuoteLine } from './math'

const area = (key: string, multiplier = 1, unit_label = 'rooms'): QuoteArea => ({ key, name: key, style: '', multiplier, unit_label })
const line = (n: number, areaKey: string | null, over: Partial<QuoteLine> = {}): QuoteLine => ({
  key: `l${n}`, area_key: areaKey, name: `Product ${n}`, size_text: '20 x 30', spec: '', material: 'Ash wood', finish: '', category: '',
  qty_mode: 'per_unit', qty: 1, unit_price: 1000, tax_rate: 18, image_path: 'u/p.jpg', is_optional: false, client_note: '', internal_note: '', ...over,
})

// [name, lines the browser drew at the real card width], from the render of 14 Nov 2026 (a card is 41 units wide, the name is set at 2.85 units).
const MEASURED: [string, number][] = [
  ['Bed', 1], ['Bench', 1], ['Wardrobe', 1], ['Floor lamp', 1], ['Writing desk', 1], ['Bedside table', 1], ['Luggage bench', 1], ['Cane lounge chair', 1],
  ['Reception counter', 1], ['Sofa, three seater', 1], ['King bed with cane', 1], ['Study table with lamp', 1], ['Chaise longue, velvet', 1],
  ['Wall mirror with frame', 1], ['Sofa cum bed, two seater', 1], ['Bar stool with cane seat', 1], ['Dining table, four seater', 1],
  ['Twin beds with back panel', 1], ['King bed with canopy frame', 1], ['Wardrobe with luggage rack', 1], ['Console table with drawers', 1],
  ['WARDROBE WITH LUGGAGE RACK', 2], ['Round dining table for six', 1], ['Lounge chair with footstool', 1], ['King bed with cane headboard', 1],
  ['Coffee table with marble top', 1], ['Chest of drawers with mirror', 1], ['KING BED WITH CANE HEADBOARD', 2], ['Rattan peacock chair with stand', 1],
  ['King bed with cane headboard and', 2], ['Outdoor lounge chair with cushion', 2], ['Bar stool with cane seat and brass', 2],
  ['Banquet chair, stackable, cane back', 2], ['Tv unit with open shelves and storage', 2], ['Upholstered headboard with side lights', 2],
  ['Executive writing desk with leather top', 2], ['Walnut finish four poster bed with canopy', 2], ['Dressing table with round mirror and stool', 2],
  ['Bookcase with glass doors and lower cabinet', 2], ['Hand-carved Sheesham wood sofa three seater with arms', 2],
]

describe('how many lines a product name takes (item 1)', () => {
  test('a name is never planned with FEWER lines than the browser drew, for every measured name', () => {
    for (const [name, drawn] of MEASURED) assert.ok(nameLines(name) >= drawn, `${name}: planned ${nameLines(name)}, drawn ${drawn}`)
  })
  test('and it is not generous either: only one measured name (31 characters, filling its line exactly) is planned a line too long', () => {
    const tooLong = MEASURED.filter(([name, drawn]) => nameLines(name) > drawn).map(([n]) => n)
    assert.deepEqual(tooLong, ['Rattan peacock chair with stand'])
  })
  test('the sample\'s 28-character name is ONE line (it was planned as two, which stranded half a page); capitals are wider', () => {
    assert.equal(nameLines('King bed with cane headboard'), 1)
    assert.equal(nameLines('KING BED WITH CANE HEADBOARD'), 2, 'the same words in capitals wrap')
    assert.equal(nameLines('WARDROBE WITH LUGGAGE RACK'), 2)
    assert.equal(NAME_LINE_CHARS, 30)
  })
  test('a very long name takes a third line, an empty one still takes one', () => {
    assert.equal(nameLines('a '.repeat(40)), 3)
    assert.equal(nameLines(''), 1)
  })
})

describe('the half-empty product page (item 1)', () => {
  // The sample's Deluxe Room: 8 products, one without a picture (the Wardrobe), a 28-character name with long remarks.
  const row = (n: number, name: string, size: string, material: string, spec: string, picture: boolean) =>
    line(n, 'deluxe', { name, size_text: size, material, spec, image_path: picture ? `p/${n}.jpg` : null })
  const deluxe = [
    row(1, 'King bed with cane headboard', `6'0" x 6'6"`, 'Sheesham wood, hand-woven cane', 'Solid wood frame, cane headboard panel, slatted base for a mattress up to 8 in.', true),
    row(2, 'Bedside table', `1'6" x 1'6" x 2'0"`, 'Sheesham wood', 'One drawer and an open shelf below.', true),
    row(3, 'Writing desk', `4'0" x 2'0" x 2'6"`, 'Sheesham wood, brass pulls', 'Two drawers, cable hole for a lamp.', true),
    row(4, 'Cane lounge chair', `2'2" x 2'4" x 2'8"`, 'Mango wood, cane', '', true),
    row(5, 'Luggage bench', '36 x 16 x 18', 'Sheesham wood', '', true),
    row(6, 'Wardrobe', `6'0" x 2'0" x 7'0"`, 'Plywood with laminate and veneer', 'Hanging rail, two shelves, soft-close doors.', false),
    row(7, 'Wall mirror with frame', '30 x 48', 'Mango wood frame', '', true),
    row(8, 'Floor lamp', '14 x 14 x 60', 'Wrought iron, cane shade', '', true),
  ]
  test('the sample\'s 8 products pack 4 + 4 on two pages (they printed 2 / 4 / 2 on three)', () => {
    const pages = planProductPages(groupsOf([area('deluxe', 40)], deluxe))
    assert.deepEqual(pages.map(p => p.lines.length), [4, 4])
  })
  test('a page never costs more than its budget, whatever mix of names, pictures and remarks (so nothing runs off the page)', () => {
    const pageUnits = (lines: QuoteLine[]) => {
      const rows: QuoteLine[][] = []
      for (let i = 0; i < lines.length; i += 2) rows.push(lines.slice(i, i + 2))
      return rows.reduce((t, r) => t + Math.max(...r.map(cardUnits)), 0) + 3 * (rows.length - 1)
    }
    const names = ['Bed', 'King bed with cane headboard', 'WARDROBE WITH LUGGAGE RACK', 'Hand-carved Sheesham wood sofa three seater with arms']
    const specs = ['', 'x'.repeat(80), 'y'.repeat(400)]
    let checked = 0
    for (const name of names) for (const spec of specs) for (const picture of [true, false]) {
      const lines = Array.from({ length: 11 }, (_, i) => line(i, 'a', { name: i % 3 === 0 ? name : `Product ${i}`, spec: i % 2 ? spec : '', image_path: picture || i % 4 === 0 ? 'u/p.jpg' : null }))
      for (const p of planProductPages(groupsOf([area('a', 10)], lines))) { assert.ok(pageUnits(p.lines) <= PRODUCT_PAGE_UNITS, `${name} / ${spec.length} / ${picture}: ${pageUnits(p.lines)}`); checked++ }
    }
    assert.ok(checked > 20)
  })
  test('the budget stays under the room a page really has for its cards (109.2 units measured), so a small under-count cannot overflow', () => {
    assert.ok(PRODUCT_PAGE_UNITS <= 109 - 4)
  })
})

describe('a product with no picture (item 2)', () => {
  test('its card leaves the picture and the gap under it out: 31.7 units, as measured (the frame is 41 x .74 = 30.3, the gap 1.4)', () => {
    const withPicture = cardUnits(line(1, 'a')), without = cardUnits(line(1, 'a', { image_path: null }))
    assert.ok(Math.abs(withPicture - without - PICTURE_UNITS) < 1e-9)
    assert.ok(Math.abs(PICTURE_UNITS - 31.74) < 0.1, 'the measured difference between a card with and without a picture is 31.74')
  })
  test('so a page of text-only cards holds more rows: six fit one page, six with pictures take two', () => {
    const plain = Array.from({ length: 6 }, (_, i) => line(i, 'a', { image_path: null }))
    assert.deepEqual(planProductPages(groupsOf([area('a', 10)], plain)).map(p => p.lines.length), [6])
    assert.deepEqual(planProductPages(groupsOf([area('a', 10)], plain.map(l => ({ ...l, image_path: 'u/p.jpg' })))).map(p => p.lines.length), [4, 2])
  })
  test('a row with one card of each costs the taller card (the picture one), as the browser lays it out', () => {
    const mixed = [line(1, 'a'), line(2, 'a', { image_path: null }), line(3, 'a'), line(4, 'a', { image_path: null })]
    assert.deepEqual(planProductPages(groupsOf([area('a', 10)], mixed)).map(p => p.lines.length), [4])
  })
})

describe('which room types count as rooms (item 3)', () => {
  test('room words: room, suite, villa, cottage, key, cabin, chalet, bungalow, tent, unit, apartment, singular or plural, any case; a blank counts as rooms', () => {
    for (const w of ['rooms', 'Room', 'SUITES', 'villa', 'Cottages', 'keys', 'cabin', 'chalets', 'bungalows', 'tents', 'units', 'apartments', ' rooms ', '', null, undefined]) assert.equal(isRoomUnit(w), true, String(w))
    for (const w of ['area', 'areas', 'hall', 'counter', 'spaces', 'nos', 'seats']) assert.equal(isRoomUnit(w), false, w)
  })
  test('the sample: 40 rooms + 6 rooms + a Lobby and Restaurant (unit "area", 1) = 46, not 47', () => {
    assert.equal(roomsOf([area('deluxe', 40), area('suite', 6), area('lobby', 1, 'area')]), 46)
  })
  test('the lead-time band follows: 30 rooms + a lobby is 10 weeks, not the 14 of 31 rooms; 100 + a lobby is 14, not 16', () => {
    assert.equal(leadTimeRule('hotel', roomsOf([area('a', 30), area('lobby', 1, 'area')]), null)?.weeks, 10)
    assert.equal(leadTimeRule('hotel', roomsOf([area('a', 100), area('lobby', 1, 'area')]), null)?.weeks, 14)
    assert.equal(leadTimeRule('resort', roomsOf([area('a', 30), area('b', 1)]), null)?.weeks, 14, 'a room type left on the unit "rooms" still counts')
  })
  test('suites and villas next to rooms all count; when NO room type uses a room word, every one counts as before', () => {
    assert.equal(roomsOf([area('a', 20), area('b', 6, 'suites'), area('c', 4, 'Villas'), area('d', 2, 'areas')]), 30)
    assert.equal(roomsOf([area('a', 3, 'areas'), area('b', 2, 'spaces')]), 5)
    assert.equal(roomsOf([{ multiplier: 2.7 }, { multiplier: -4 }, { multiplier: Number.NaN }]), 2, 'no unit given: counts, as before')
    assert.equal(roomsOf([]), 0)
  })
})
