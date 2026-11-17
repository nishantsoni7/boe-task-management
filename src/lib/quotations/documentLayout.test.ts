/**
 * The client document's layout, measured in the real render (headless Edge, the same A4 sheets the PDF uses), not guessed:
 *   - since 18 Nov 2026 the products and prices are ONE table: its row estimates and page budgets against the measured heights;
 *   - a lobby or restaurant does not count as rooms ("Forty-seven rooms" for 46, found in the render of 14 Nov 2026).
 *
 * Run: npm run test:file -- src/lib/quotations/documentLayout.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { TABLE_FIRST_UNITS, TABLE_NEXT_UNITS, isRoomUnit, leadTimeRule, nameLines, roomsOf, rowUnits, summaryUnits } from './documentPlan'
import type { QuoteArea, QuoteLine } from './math'

const area = (key: string, multiplier = 1, unit_label = 'rooms'): QuoteArea => ({ key, name: key, style: '', multiplier, unit_label })
const line = (n: number, areaKey: string | null, over: Partial<QuoteLine> = {}): QuoteLine => ({
  key: `l${n}`, area_key: areaKey, name: `Product ${n}`, size_text: '20 x 30', spec: '', material: 'Ash wood', finish: '', category: '',
  qty_mode: 'per_unit', qty: 1, unit_price: 1000, tax_rate: 18, image_path: 'u/p.jpg', is_optional: false, client_note: '', internal_note: '', ...over,
})

// MEASURED in the real A4 render of the one product table (headless Edge, print media, 18 Nov 2026), in page units (1% of the width).
const SPEC80 = 'Solid wood frame, cane headboard panel, slatted base for a mattress up to 8 in.'
const row = (over: Partial<QuoteLine> = {}) => line(1, 'a', { name: 'Bedside table', size_text: `6'0" x 6'6"`, material: 'Sheesham wood, hand-woven cane', ...over })

describe('the one product table, as measured (18 Nov 2026)', () => {
  test('a row is never planned shorter than the browser drew it', () => {
    const per = { kind: 'line', area: area('a', 40) } as const
    assert.ok(rowUnits({ ...per, line: row() }) >= 12.72, 'a picture row, size, material, "1 per room"')
    assert.ok(rowUnits({ ...per, line: row({ name: 'King bed with cane headboard', spec: SPEC80 }) }) >= 14.51, 'with two lines of remarks')
    assert.ok(rowUnits({ ...per, line: row({ image_path: null }) }) >= 10.9, 'the same row with no picture')
    assert.ok(rowUnits({ kind: 'group', area: area('a', 40) }) >= 6.37, 'a room-type heading')
  })
  test('and the planned pages stay inside the room the sheet really has (107.5 on the first page, 114.4 after it)', () => {
    assert.ok(TABLE_FIRST_UNITS <= 107.5 - 2)
    assert.ok(TABLE_NEXT_UNITS <= 114.4 - 2)
    assert.ok(summaryUnits(5) >= 51.3, 'the totals with five lines above the grand total measured 51.3')
  })
  test('a product name wraps where the browser wrapped it: 53 characters take two lines, 28 take one', () => {
    assert.equal(nameLines('Hand-carved Sheesham wood sofa three seater with arms'), 2)
    assert.equal(nameLines('King bed with cane headboard'), 1)
    assert.equal(nameLines(''), 1)
  })
  test('on a live quotation (18 Nov 2026) every name is planned with exactly the lines the browser drew', () => {
    // [characters, capitals, lines drawn] in a 41.4-unit product column
    const live: [number, number, number][] = [[13, 12, 1], [17, 15, 1], [24, 22, 1], [25, 1, 1], [37, 4, 1], [50, 7, 2], [56, 8, 2], [58, 8, 2], [62, 9, 2], [160, 16, 4]]
    for (const [len, caps, drawn] of live) assert.equal(nameLines('A'.repeat(caps) + 'a'.repeat(len - caps)), drawn, `${len} characters`)
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
