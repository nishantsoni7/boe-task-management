/**
 * THE FABRIC & FINISH COST SHEET'S ARITHMETIC AND RULES (owner, 2026-10-29).
 *
 * Every figure the sheet shows is this module's; nothing on a screen computes
 * a total of its own. Pinned here: typed-over-sheet, the workbook's own
 * rounding to ₹10 and "as applicable", quantity driving the totals, the
 * comparison with the PI's stored lines, and what Edit PI takes from the sheet.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  AS_APPLICABLE_TEXT,
  compareWithPi,
  effective,
  effectiveFinish,
  finishFamilies,
  finishHeadings,
  lineApproval,
  lineFigures,
  parseFabricFinishData,
  parseTypedFigure,
  roundToTen,
  sheetCostsForEdit,
  sheetTotals,
  totalText,
  typedPayload,
  type FabricFinishLine,
  type LineValues,
} from './fabricFinishCost'

const values = (v: Partial<LineValues> = {}): LineValues => ({
  fabricMetresPerPiece: null, fabricPricePerMetre: null, packingCostPerPiece: null, packingType: null, finish: [], ...v,
})

const line = (seq: string, quantity: number, sheet: Partial<LineValues> | null, typed: Partial<LineValues> | null = null): FabricFinishLine => ({
  itemSequence: seq, itemId: null, productName: `Product ${seq}`, productCode: null, quantity, sortOrder: 0,
  sheet: sheet ? values(sheet) : null, typed: typed ? values(typed) : null, typedByName: null, typedAt: null,
})

describe('what counts per line', () => {
  test('a typed value wins over the sheet, and the sheet fills what was not typed', () => {
    const l = line('B001', 10, { fabricMetresPerPiece: 0.5, fabricPricePerMetre: 600, packingCostPerPiece: 300 }, { fabricPricePerMetre: 650 })
    assert.deepEqual(effective(l, 'fabricPricePerMetre'), { value: 650, source: 'typed' })
    assert.deepEqual(effective(l, 'fabricMetresPerPiece'), { value: 0.5, source: 'sheet' })
    assert.deepEqual(effective(l, 'packingType'), { value: null, source: 'none' })
  })

  test('metres, fabric and packing follow the quantity', () => {
    const l = line('B001', 25, { fabricMetresPerPiece: 0.75, fabricPricePerMetre: 650, packingCostPerPiece: 550 })
    const f = lineFigures(l)
    assert.equal(f.metres, 18.75)
    assert.equal(f.fabricAmount, 12187.5)
    assert.equal(f.packingAmount, 13750)
    assert.equal(f.blank, false)
    const revised = lineFigures({ ...l, quantity: 30 })
    assert.equal(revised.metres, 22.5)
    assert.equal(revised.fabricAmount, 14625)
    assert.equal(revised.packingAmount, 16500)
  })

  test('zero metres is no fabric money; metres without a price is a cost not yet known', () => {
    assert.equal(lineFigures(line('B001', 4, { fabricMetresPerPiece: 0 })).fabricAmount, 0)
    assert.equal(lineFigures(line('B001', 4, { fabricMetresPerPiece: 2 })).fabricAmount, null)
    assert.equal(lineFigures(line('B001', 4, null)).fabricAmount, null)
  })

  test('a line with nothing from the sheet and nothing typed is blank', () => {
    assert.equal(lineFigures(line('B001', 4, null)).blank, true)
    assert.equal(lineFigures(line('B001', 4, {})).blank, true)
    assert.equal(lineFigures(line('B001', 4, { packingCostPerPiece: 0 })).blank, false)
  })
})

describe('finish choices', () => {
  test('typed entries replace the sheet entry under the same heading and add new ones', () => {
    const l = line('B001', 1,
      { finish: [{ heading: 'Fabric Approval', value: 'PENDING', imagePath: null }, { heading: 'Wood Finish Approval', value: 'Walnut 50', imagePath: null }] },
      { finish: [{ heading: 'fabric approval', value: 'Tony 115', imagePath: 'submissions/x/fabric-finish/B001/abc.jpg' }, { heading: 'Seat Fabric', value: 'Fiamma', imagePath: null }] })
    assert.deepEqual(effectiveFinish(l).map(f => [f.entry.heading, f.entry.value, f.source]), [
      ['fabric approval', 'Tony 115', 'typed'],
      ['Wood Finish Approval', 'Walnut 50', 'sheet'],
      ['Seat Fabric', 'Fiamma', 'typed'],
    ])
  })

})

describe('what approved means (owner, 2026-10-30)', () => {
  const entry = (heading: string, value: string, imagePath: string | null = null) => ({ heading, value, imagePath })
  const FOUR = finishFamilies([])
  const PICTURE = 'submissions/x/fabric-finish/B001/abc.jpg'

  test('a PI with no headings tracks the usual four kinds', () => {
    assert.deepEqual(finishHeadings([]), ['Fabric Approval', 'Wood Finish Approval', 'Metal Finish', 'Marble/Rope Approval'])
    assert.deepEqual(FOUR, ['fabric', 'wood', 'metal', 'marble'])
  })

  test('nothing but PENDING and blanks is none', () => {
    assert.equal(lineApproval(line('B001', 1, { finish: [entry('Fabric Approval', 'PENDING')] }), FOUR).state, 'none')
    assert.equal(lineApproval(line('B001', 1, { finish: [] }), FOUR).state, 'none')
    assert.equal(lineApproval(line('B001', 1, null), FOUR).state, 'none')
  })

  test('one NA with the rest blank is only part of the way: the "1 of 33" on Roots & Rituals', () => {
    const l = line('BE0001', 20, { finish: [entry('Fabric Approval', 'NA'), entry('Marble/Rope Approval', 'NA')] })
    assert.equal(lineApproval(l, FOUR).state, 'partial')
  })

  test('every kind settled by a value, a picture or NA is approved', () => {
    const l = line('B001', 1, { finish: [
      entry('Fabric Approval', 'Tony 115'), entry('Wood Finish Approval', '', PICTURE),
      entry('Metal Finish', 'NA'), entry('Marble/Rope Approval', 'n/a'.toUpperCase()),
    ] })
    const approval = lineApproval(l, FOUR)
    assert.equal(approval.state, 'approved')
    assert.deepEqual(approval.cells.map(c => c.settled), [true, true, true, true])
  })

  test('headings of one kind count together: a blank Seat Fabric beside a filled Fabric 1 is not open', () => {
    const lines = [line('B001', 1, { finish: [entry('Fabric 1', 'Morocco 03'), entry('Wood Finish Approval', 'Acacia')] }),
      line('B002', 1, { finish: [entry('Fabric 1', 'Morocco 03'), entry('Fabric 2', 'Pirates 108'), entry('Seat Fabric', 'Morocco 07'), entry('Wood Finish Approval', 'Acacia')] })]
    const families = finishFamilies(lines)
    assert.deepEqual(families, ['fabric', 'wood'])
    assert.equal(lineApproval(lines[0], families).state, 'approved')
    assert.equal(lineApproval(lines[1], families).cells[0].entries.length, 3)
  })

  test('but a PENDING one is', () => {
    const lines = [line('B001', 1, { finish: [entry('Fabric 1', 'Morocco 03'), entry('Fabric 2', 'PENDING')] })]
    assert.equal(lineApproval(lines[0], finishFamilies(lines)).state, 'none')
  })

  test('a typed value settles what the sheet left open', () => {
    const l = line('B001', 1, { finish: [entry('Fabric Approval', 'PENDING')] }, { finish: [entry('Fabric Approval', 'Tony 115')] })
    assert.equal(lineApproval(l, ['fabric']).state, 'approved')
  })
})

describe('the totals, the workbook’s way', () => {
  test('ROUND(SUM, -1): to the nearest ten, halves away from zero', () => {
    assert.equal(roundToTen(12187.5), 12190)
    assert.equal(roundToTen(12184.99), 12180)
    assert.equal(roundToTen(5), 10)
    assert.equal(roundToTen(0), 0)
  })

  test('sums only the lines that carry a figure, rounds once, and says "as applicable" for nothing', () => {
    const t = sheetTotals([
      line('B001', 25, { fabricMetresPerPiece: 0.75, fabricPricePerMetre: 650, packingCostPerPiece: 550 }),
      line('B002', 4, { fabricMetresPerPiece: 0, packingCostPerPiece: 450 }),
      line('B003', 2, { packingCostPerPiece: 450 }),
      line('B004', 1, null),
    ])
    assert.equal(t.fabric.sum, 12187.5)
    assert.equal(t.fabric.rounded, 12190)
    assert.equal(t.fabric.counted, 2)
    assert.equal(t.packing.sum, 16450)
    assert.equal(t.packing.rounded, 16450)
    assert.equal(t.metres, 18.75)
    assert.equal(t.linesFilled, 3)
    assert.equal(t.lines, 4)
    const none = sheetTotals([line('B001', 25, { fabricMetresPerPiece: 0, packingCostPerPiece: 0 }), line('B002', 1, null)])
    assert.equal(none.fabric.rounded, null)
    assert.equal(none.packing.rounded, null)
    assert.equal(totalText(none.fabric, n => `₹${n}`), AS_APPLICABLE_TEXT)
    assert.equal(totalText(t.fabric, n => `₹${n}`), '₹12190')
  })

  test('metres with no price make the fabric total unknown, not zero', () => {
    const t = sheetTotals([line('B001', 10, { fabricMetresPerPiece: 1.5 }), line('B002', 2, { fabricMetresPerPiece: 1, fabricPricePerMetre: 500 })])
    assert.equal(t.fabric.unknown, 1)
    assert.equal(t.fabric.counted, 1)
    assert.equal(t.fabric.rounded, 1000)
  })
})

describe('against the PI’s own lines', () => {
  const sheet = sheetTotals([line('B001', 25, { fabricMetresPerPiece: 0.75, fabricPricePerMetre: 650, packingCostPerPiece: 550 })])

  test('matches when the PI states the same rounded figure', () => {
    const c = compareWithPi({ amount: 12190, meaning: 'numeric', text: null }, sheet.fabric)
    assert.equal(c.state, 'matches')
    assert.equal(c.difference, 0)
  })

  test('differs by the rounded difference after a quantity change', () => {
    const revised = sheetTotals([line('B001', 30, { fabricMetresPerPiece: 0.75, fabricPricePerMetre: 650 })])
    const c = compareWithPi({ amount: 12190, meaning: 'numeric', text: null }, revised.fabric)
    assert.equal(c.state, 'differs')
    assert.equal(c.difference, 2440)
  })

  test('nothing quoted on both sides is a match; "as applicable" words are kept', () => {
    const none = sheetTotals([line('B001', 1, null)])
    const dash = compareWithPi({ amount: 0, meaning: 'not_applicable', text: null }, none.fabric)
    assert.equal(dash.state, 'matches')
    assert.equal(dash.piWords, 'Not applicable')
    const words = compareWithPi({ amount: 0, meaning: 'text', text: 'as applicable' }, none.fabric)
    assert.equal(words.state, 'matches')
    assert.equal(words.piWords, 'as applicable')
    const quoted = compareWithPi({ amount: 0, meaning: 'not_applicable', text: null }, sheet.fabric)
    assert.equal(quoted.state, 'differs')
    assert.equal(quoted.difference, 12190)
  })

  test('an unknown sheet total compares as unknown', () => {
    const t = sheetTotals([line('B001', 10, { fabricMetresPerPiece: 1.5 })])
    assert.equal(compareWithPi({ amount: 100, meaning: 'numeric', text: null }, t.fabric).state, 'unknown')
  })
})

describe('what Edit PI takes from the sheet', () => {
  const lines = [
    line('B001', 25, { fabricMetresPerPiece: 0.75, fabricPricePerMetre: 650, packingCostPerPiece: 550 }),
    line('B002', 4, { fabricMetresPerPiece: 0, packingCostPerPiece: 450 }),
  ]

  test('recomputes both lines from the quantities the edit proposes', () => {
    const c = sheetCostsForEdit(lines, new Map([['B001', 30], ['B002', 4]]))
    assert.deepEqual(c, { fabric: 14630, packing: 18300, hasSheet: true })
  })

  test('a removed line drops out; a line without sheet data adds nothing', () => {
    const c = sheetCostsForEdit(lines, new Map([['B002', 4], ['B009', 3]]))
    assert.deepEqual(c, { fabric: 0, packing: 1800, hasSheet: true })
  })

  test('with no sheet data at all the PI keeps what it states', () => {
    assert.deepEqual(sheetCostsForEdit([line('B001', 1, null)], new Map([['B001', 1]])), { fabric: null, packing: null, hasSheet: false })
  })
})

describe('typed input', () => {
  test('blank is nothing typed, a bad number is refused, commas are allowed', () => {
    assert.equal(parseTypedFigure(''), null)
    assert.equal(parseTypedFigure('  '), null)
    assert.equal(parseTypedFigure('1,250'), 1250)
    assert.equal(parseTypedFigure('0.75'), 0.75)
    assert.ok(Number.isNaN(parseTypedFigure('-1') as number))
    assert.ok(Number.isNaN(parseTypedFigure('abc') as number))
    assert.ok(Number.isNaN(parseTypedFigure('1.2345') as number))
  })

  test('the payload carries nulls for blanks and keeps only finish entries with something in them', () => {
    const p = typedPayload({
      fabricMetresPerPiece: '0.5', fabricPricePerMetre: '', packingCostPerPiece: '450', packingType: ' BCF ',
      finish: [{ heading: 'Fabric Approval', value: 'Tony 115', imagePath: null }, { heading: 'Metal Finish', value: '', imagePath: null }],
    })
    assert.ok(p.ok)
    if (p.ok) {
      assert.deepEqual(p.values, {
        fabric_metres_per_piece: 0.5, fabric_price_per_metre: null, packing_cost_per_piece: 450, packing_type: 'BCF',
        finish: [{ heading: 'Fabric Approval', value: 'Tony 115', image_path: null, image_sha256: null }],
      })
    }
    const bad = typedPayload({ fabricMetresPerPiece: 'x', fabricPricePerMetre: '', packingCostPerPiece: '', packingType: '', finish: [] })
    assert.equal(bad.ok, false)
    const paise = typedPayload({ fabricMetresPerPiece: '', fabricPricePerMetre: '1.005', packingCostPerPiece: '', packingType: '', finish: [] })
    assert.equal(paise.ok, false)
  })
})

describe('the read function’s JSON', () => {
  test('lines follow the PI’s items in order, with sheet and typed values beside each', () => {
    const data = parseFabricFinishData({
      found: true,
      can_edit: true,
      submission: {
        id: 'pi-1', status: 'approved', order_id: 'o-1', order_status: 'running', display_number: '0539', client_name: 'Client',
        source_workbook_name: 'PI.xlsx', fabric_cost: '12190.00', fabric_cost_meaning: 'numeric', fabric_cost_text: null,
        packing_cost: '0', packing_cost_meaning: 'not_applicable', packing_cost_text: null, sheet_read_at: '2026-10-29T10:00:00Z',
      },
      items: [
        { item_sequence: 'B002', item_id: 'i2', product_name: 'Side table', source_product_code: '100-B002', quantity: '4.00', sort_order: 1 },
        { item_sequence: 'B001', item_id: 'i1', product_name: 'Chair', source_product_code: '100-B001', quantity: '25.00', sort_order: 0 },
      ],
      lines: [
        { item_sequence: 'B001', sheet: { fabric_metres_per_piece: '0.750', fabric_price_per_metre: '650.00', packing_cost_per_piece: null, packing_type: 'BCF', finish: [{ heading: 'Fabric Approval', value: 'PENDING' }] },
          typed: { fabric_metres_per_piece: null, fabric_price_per_metre: null, packing_cost_per_piece: '550.00', packing_type: null, finish: [] },
          typed_by_name: 'Nishant', typed_at: '2026-10-29T11:00:00Z', sheet_read_at: '2026-10-29T10:00:00Z' },
      ],
    })
    assert.ok(data)
    assert.equal(data.displayNumber, '0539')
    assert.equal(data.piFabricCost.amount, 12190)
    assert.equal(data.piPackingCost.meaning, 'not_applicable')
    assert.deepEqual(data.lines.map(l => l.itemSequence), ['B002', 'B001'])
    const chair = data.lines[1]
    assert.equal(chair.quantity, 25)
    assert.equal(chair.sheet?.fabricMetresPerPiece, 0.75)
    assert.equal(chair.typed?.packingCostPerPiece, 550)
    assert.equal(chair.typedByName, 'Nishant')
    assert.equal(data.lines[0].sheet, null, 'a line without a row has no sheet values')
    assert.equal(lineFigures(chair).packingAmount, 13750)
  })

  test('nothing found is null', () => {
    assert.equal(parseFabricFinishData({ found: false }), null)
    assert.equal(parseFabricFinishData(null), null)
  })
})
