// Price learning, piece 1: the forgiving PI reader. The grids are written the way real old PIs are laid out (the
// current template's headings, the older "Original price (INR)" heading, a US-dollar file, an extra price column, a
// different layout altogether). Names, sizes and prices are invented.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { contentPrint, dateOf, judge, orderFacts, readPiGrids, sameProject, subtotalMatches, type Cell } from './readPi'

const TODAY = new Date('2026-11-14T06:00:00Z')
const HEAD = ['Code', 'Name', 'Quantity', 'Dimension in inches & shape', 'Representative image', 'Material', 'Cost per piece (INR)', 'Total cost (INR)']
const pad = (n: number): Cell[][] => Array.from({ length: n }, () => [])

/** The current template: a header block, the column names, product rows, then the footer in other columns. */
const STANDARD: Cell[][] = [
  ...pad(18), ['', '', '', '', '', 'Date', 45700], ...pad(10),
  HEAD,
  ['A-1', 'King bed with headboard', 56, '78 x 84 x 42', null, 'Teak wood', 54800, 3068800],
  ['A-2', 'Bedside table, 2 drawers', 112, '20 x 16 x 22', null, 'Teak wood', 11400, 1276800],
  ['A-3', 'Writing desk', 56, '48 x 22 x 30', null, 'Teak wood and veneer', 19600, 1097600],
  ...pad(3),
  ['', '', '', '', '', 'Sub Total', '', 5443200],
  ['', '', '', '', '', 'Discount', '', 43200],
  ['', '', '', '', '', 'Grand Total', '', 5400000],
]

describe('reading the current PI layout', () => {
  const r = readPiGrids([{ name: 'Master', grid: STANDARD }], TODAY)

  test('finds the table by its column names and reads every line', () => {
    assert.equal(r.problem, null)
    assert.equal(r.headerRow, 30, 'the 1-based sheet row of the column names')
    assert.deepEqual(r.lines.map(l => [l.name, l.qty, l.price, l.total]), [
      ['King bed with headboard', 56, 54800, 3068800], ['Bedside table, 2 drawers', 112, 11400, 1276800], ['Writing desk', 56, 19600, 1097600]])
    assert.equal(r.lines[0].material, 'Teak wood')
    assert.equal(r.lines[0].size, '78 x 84 x 42')
    assert.equal(r.currency, 'INR')
  })

  test('proves itself against the file\'s own Sub Total, and reads the discount and the date', () => {
    assert.equal(r.sumOfLines, 5443200)
    assert.deepEqual(r.footer, { subtotal: 5443200, discount: 43200, grandTotal: 5400000 })
    assert.equal(subtotalMatches(r), true)
    assert.equal(r.piDate, '2025-02-12')
    assert.deepEqual(judge(r, true), { status: 'ready', reasons: [], toCheck: 0 })
  })

  test('order facts: pieces, distinct designs, value before GST after the lump-sum discount', () => {
    assert.deepEqual(orderFacts(r.lines, r.footer.discount), { pieces: 224, designs: 3, subtotal: 5443200, discount: 43200, valueBeforeGst: 5400000 })
  })
})

describe('older layouts', () => {
  test('"Original price (INR)", a sheet named "Master " and a lump of blank rows read the same', () => {
    const grid: Cell[][] = [...pad(3), ['Code', 'Name', 'Quantity', 'Dimensions / Shape', 'Representative Image', 'Material', 'Original Price (INR)', 'Total Cost (INR)'],
      ['1', 'Lounge chair', 24, '30 x 30 x 31', null, 'Mango wood', 12900, 309600], ...pad(30), ['', '', '', '', '', 'Sub Total', '', 309600]]
    const r = readPiGrids([{ name: 'Master ', grid: grid }], TODAY)
    assert.deepEqual(r.lines.map(l => [l.name, l.price]), [['Lounge chair', 12900]])
    assert.equal(subtotalMatches(r), true)
  })

  test('a quantity or a price left blank is worked out from the other two and flagged, never silent', () => {
    const grid: Cell[][] = [HEAD,
      ['1', 'Sofa, 2 seater', null, '62 x 30 x 32', null, 'Teak', 38500, 924000],
      ['2', 'Coffee table', 24, '30 x 18', null, 'Teak', null, 379200],
      ['3', 'Luggage rack', 56, '36 x 22 x 18', null, 'Mango', 4300, 240800]]
    const r = readPiGrids([{ name: 'Master', grid }], TODAY)
    assert.deepEqual(r.lines.map(l => [l.qty, l.price, l.flags]), [[24, 38500, ['qty_derived']], [24, 15800, ['price_derived']], [56, 4300, []]])
    assert.equal(judge(r, true).status, 'ready', 'a derived figure is exact arithmetic, so it is shown but does not block')
  })

  test('a second price column (an alternative offer) and a "Sample price" column are not the price', () => {
    const grid: Cell[][] = [['Code', 'Name', 'Quantity', 'Dimension in inches & shape', 'Representative image', 'Material', 'Cost per piece (INR)', 'Total cost (INR)', 'Sample price', 'Material suggested by us', 'Cost per piece (INR)', 'Total cost (INR)'],
      ['1', 'Dining chair', 40, '18 x 20 x 34', null, 'Mango', 6200, 248000, 9000, 'Teak', 7900, 316000]]
    const r = readPiGrids([{ name: 'Master', grid }], TODAY)
    assert.deepEqual(r.lines.map(l => [l.price, l.total]), [[6200, 248000]])
  })

  test('a different layout (S.No., Product image, Description, LxDxH, Qty, Price, Total) is read by its names', () => {
    const grid: Cell[][] = [['Proforma Invoice'], ['S.No.', 'Product Image', 'Description', 'LxDxH', 'Material', 'Qty', 'Price', 'Total', 'Fabric', 'Total Fabric', 'Remark'],
      [1, null, 'Arm chair', '28x28x32', 'Teak', 20, 9800, 196000, 'Velvet', 5000, 'Deliver in two lots'], [2, null, 'Bar stool', '16x16x30', 'Metal', 30, 4100, 123000, null, null, null]]
    const r = readPiGrids([{ name: 'Sheet1', grid }], TODAY)
    assert.deepEqual(r.lines.map(l => [l.name, l.qty, l.price]), [['Arm chair', 20, 9800], ['Bar stool', 30, 4100]])
    assert.equal(r.lines[0].customization, 'Deliver in two lots')
  })

  test('the sheet with the most lines wins; "Master" breaks a tie', () => {
    const one: Cell[][] = [HEAD, ['1', 'Bench', 4, '48 x 16 x 18', null, 'Teak', 9000, 36000]]
    const two: Cell[][] = [HEAD, ['1', 'Bench', 4, '48 x 16 x 18', null, 'Teak', 9000, 36000], ['2', 'Stool', 4, '14 x 14 x 18', null, 'Teak', 3000, 12000]]
    assert.equal(readPiGrids([{ name: 'Master', grid: one }, { name: 'Copy', grid: two }], TODAY).sheet, 'Copy')
    assert.equal(readPiGrids([{ name: 'Copy', grid: one }, { name: 'Master', grid: one }], TODAY).sheet, 'Master')
  })
})

describe('what is left out or sent for checking', () => {
  test('US-dollar prices are left out, with the reason', () => {
    const grid: Cell[][] = [['Code', 'Name', 'Quantity', 'Dimensions / Shape', 'Representative Image', 'Material', 'Cost per piece (USD)', 'Total cost (USD)'], ['1', 'Console', 10, '48 x 14 x 30', null, 'Mango', 220, 2200]]
    const r = readPiGrids([{ name: 'Master', grid }], TODAY)
    assert.equal(r.currency, 'USD')
    const v = judge(r, true)
    assert.equal(v.status, 'left_out')
    assert.match(v.reasons[0], /US dollars/)
  })

  test('no table, or a table without lines, is left out', () => {
    assert.equal(judge(readPiGrids([{ name: 'Notes', grid: [['Terms'], ['Pay 70% in advance']] }], TODAY), true).status, 'left_out')
    assert.equal(judge(readPiGrids([{ name: 'Master', grid: [HEAD, ['', '', '', '', '', '', '', '']] }], TODAY), true).status, 'left_out')
  })

  test('a sample piece is flagged and kept out of the order facts; a product called "Packing stool" is still a product', () => {
    const grid: Cell[][] = [HEAD, ['1', 'Lounge chair', 56, '30 x 30 x 31', null, 'Mango', 12900, 722400], ['2', 'Lounge chair, sample piece', 1, '30 x 30 x 31', null, 'Mango', 28000, 28000], ['3', 'Packing stool', 10, '14 x 14 x 16', null, 'Mango', 1800, 18000]]
    const r = readPiGrids([{ name: 'Master', grid }], TODAY)
    assert.deepEqual(r.lines.map(l => [l.name, l.sample]), [['Lounge chair', false], ['Lounge chair, sample piece', true], ['Packing stool', false]])
    assert.equal(orderFacts(r.lines.filter(l => !l.sample), null).pieces, 66)
  })

  test('a Sub Total that differs from the lines, an odd price and a missing date are sent for checking; a size we cannot place is only noted', () => {
    const grid: Cell[][] = [HEAD, ['1', 'Wall mirror', 56, 'length - 24" width- 1" height- 42"', null, 'Mango', 6100, 341600], ['2', 'Hook', 10, '2 x 3', null, 'Brass', 30, 300], ['', '', '', '', '', 'Sub Total', '', 400000]]
    const r = readPiGrids([{ name: 'Master', grid }], TODAY)
    assert.deepEqual(r.lines.map(l => l.flags), [['size_unreadable'], ['price_unusual']])
    assert.equal(subtotalMatches(r), false)
    const v = judge(r, false)
    assert.equal(v.status, 'check')
    assert.equal(v.toCheck, 3, 'one odd price, the Sub Total, the date: not the size')
    assert.equal(v.reasons.length, 3)
  })

  test('"Standard dimensions, seating height 18 in" is a size note, not a doubtful cell; a quantities-only list says so', () => {
    const chair: Cell[][] = [HEAD, ['1', 'Dining chair', 40, 'Standard dimensions (seating height 18")', null, 'Mango', 6200, 248000]]
    const r = readPiGrids([{ name: 'Master', grid: chair }], TODAY)
    assert.deepEqual(r.lines[0].flags, [])
    const bare: Cell[][] = [HEAD, ['1', 'Dining chair', 40, '18 x 20 x 34', null, 'Mango', null, 0], ['2', 'Bar stool', 12, '16 x 16 x 30', null, 'Metal', null, 0]]
    const q = readPiGrids([{ name: 'Master', grid: bare }], TODAY)
    assert.equal(q.unpricedRows, 2)
    assert.match(judge(q, true).reasons[0], /no prices filled in/)
  })
})

describe('dates, copies and revisions', () => {
  test('dates as Excel numbers and as people write them', () => {
    assert.equal(dateOf(45700, TODAY), '2025-02-12')
    assert.equal(dateOf('12/02/2025', TODAY), '2025-02-12')
    assert.equal(dateOf('12-2-25', TODAY), '2025-02-12')
    assert.equal(dateOf('12th Feb 2025', TODAY), '2025-02-12')
    assert.equal(dateOf('February 12, 2025', TODAY), '2025-02-12')
    assert.equal(dateOf('2025-02-12', TODAY), '2025-02-12')
    assert.equal(dateOf('31/02/2025', TODAY), null, 'a day that does not exist')
    assert.equal(dateOf('12/02/2031', TODAY), null, 'a date in the future')
    assert.equal(dateOf('TBC', TODAY), null)
  })

  test('the same lines in another order have the same fingerprint; different prices do not', async () => {
    const a = [{ name: 'Bench', qty: 4, price: 9000 }, { name: 'Stool', qty: 8, price: 3000 }]
    assert.equal(await contentPrint(a), await contentPrint([...a].reverse()))
    assert.notEqual(await contentPrint(a), await contentPrint([{ name: 'Bench', qty: 4, price: 9500 }, a[1]]))
  })

  test('two PIs of one project share most product names; unrelated ones do not', () => {
    const names = (...n: string[]) => n.map(name => ({ name }))
    const v1 = names('King bed', 'Bedside table', 'Desk', 'Chair', 'Wardrobe')
    const v2 = names('King bed', 'Bedside table', 'Desk', 'Chair', 'Wardrobe', 'Mirror')
    assert.equal(sameProject(v1, v2), true)
    assert.equal(sameProject(v1, names('Bar stool', 'Dining table', 'Bench', 'Sofa', 'Console')), false)
    assert.equal(sameProject(names('Bed', 'Desk'), names('Bed', 'Desk')), false, 'two shared names are not enough to call it one project')
  })
})
