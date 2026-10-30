/**
 * THE TWO SHEETS BESIDE THE MASTER — "Packing cost and Fabric Cost" and
 * "Fabric and Finish" — read by their headings, matched to the Master's
 * products by code, and reported (never guessed) when absent or re-headed.
 *
 * Synthetic workbooks, built here with fflate the way masterSheetParser.test
 * builds its own: a workbook.xml declaring the sheets, one worksheet part per
 * sheet with inline strings, numbers and formula cells carrying cached results
 * (the shape Excel saves for a sheet whose product columns are formulas over
 * the Master). No real PI is used.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { zipSync } from 'fflate'

import { openPiArchive } from './workbookReader'
import {
  COST_SHEET_NAME,
  FINISH_SHEET_NAME,
  matchFabricFinishSheets,
  readFabricFinishSheets,
  type FabricFinishSheets,
} from './fabricFinishSheets'
import type { PiProduct } from './types'

const enc = new TextEncoder()
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

type Cell =
  | { kind: 'text'; value: string }
  | { kind: 'num'; value: number }
  | { kind: 'formulaText'; formula: string; value: string }
  | { kind: 'formulaNum'; formula: string; value: number }
  | { kind: 'formulaNoCache'; formula: string }

const text = (value: string): Cell => ({ kind: 'text', value })
const num = (value: number): Cell => ({ kind: 'num', value })
const fText = (formula: string, value: string): Cell => ({ kind: 'formulaText', formula, value })
const fNum = (formula: string, value: number): Cell => ({ kind: 'formulaNum', formula, value })
const noCache = (formula: string): Cell => ({ kind: 'formulaNoCache', formula })

function cellXml(address: string, cell: Cell): string {
  switch (cell.kind) {
    case 'text': return `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${esc(cell.value)}</t></is></c>`
    case 'num': return `<c r="${address}"><v>${cell.value}</v></c>`
    case 'formulaText': return `<c r="${address}" t="str"><f>${esc(cell.formula)}</f><v>${esc(cell.value)}</v></c>`
    case 'formulaNum': return `<c r="${address}"><f>${esc(cell.formula)}</f><v>${cell.value}</v></c>`
    case 'formulaNoCache': return `<c r="${address}"><f>${esc(cell.formula)}</f></c>`
  }
}

function sheetXml(cells: Record<string, Cell>, drawing = false): string {
  const rows = new Map<number, string[]>()
  for (const [address, cell] of Object.entries(cells)) {
    const row = Number(/\d+$/.exec(address)?.[0])
    const list = rows.get(row) ?? []
    list.push(cellXml(address, cell))
    rows.set(row, list)
  }
  const body = [...rows.entries()].sort((a, b) => a[0] - b[0])
    .map(([r, cs]) => `<row r="${r}">${cs.join('')}</row>`).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheetData>${body}</sheetData>${drawing ? '<drawing r:id="rId1"/>' : ''}</worksheet>`
}

/** A picture anchored at a 0-based cell, pointing at a relationship of the drawing. */
const anchor = (col: number, row: number, rel: string) =>
  `<xdr:oneCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
  + `<xdr:pic><xdr:blipFill><a:blip r:embed="${rel}"/></xdr:blipFill></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3])
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** The drawing, its media and its links, for the sheet at the given position. */
function drawingParts(position: number, anchors: string[], media: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const parts: Record<string, Uint8Array> = {
    [`xl/worksheets/_rels/sheet${position}.xml.rels`]: enc.encode(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="${REL}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`),
    'xl/drawings/drawing1.xml': enc.encode(
      `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}">`
      + `${anchors.join('')}</xdr:wsDr>`),
    'xl/drawings/_rels/drawing1.xml.rels': enc.encode(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + Object.keys(media).map((name, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/image" Target="../media/${name}"/>`).join('')
      + `</Relationships>`),
  }
  for (const [name, bytes] of Object.entries(media)) parts[`xl/media/${name}`] = bytes
  return parts
}

/** A workbook whose sheets are the given name → cells, in that order. */
function workbook(sheets: Record<string, Record<string, Cell>>, extra: Record<string, Uint8Array> = {}): Uint8Array {
  const names = Object.keys(sheets)
  const parts: Record<string, Uint8Array> = {
    '[Content_Types].xml': enc.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
      + `<Default Extension="xml" ContentType="application/xml"/>`
      + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
      + `</Types>`),
    '_rels/.rels': enc.encode(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
      + `</Relationships>`),
    'xl/workbook.xml': enc.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
      + `<sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': enc.encode(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + names.map((_n, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).reverse().join('')
      + `</Relationships>`),
    'xl/sharedStrings.xml': enc.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"></sst>`),
  }
  names.forEach((n, i) => {
    parts[`xl/worksheets/sheet${i + 1}.xml`] = enc.encode(sheetXml(sheets[n], `xl/worksheets/_rels/sheet${i + 1}.xml.rels` in extra))
  })
  return zipSync({ ...parts, ...extra })
}

async function read(sheets: Record<string, Record<string, Cell>>, extra: Record<string, Uint8Array> = {}): Promise<FabricFinishSheets> {
  const opened = await openPiArchive(workbook(sheets, extra))
  assert.ok(opened.ok, 'the synthetic archive opens')
  return readFabricFinishSheets(opened.archive.entries)
}

// ── Fixtures shaped like the template ─────────────────────────────────────────

const COST_HEADINGS: Record<string, Cell> = {
  A1: text('Code'), B1: text('Name'), C1: text('Quantity'), D1: text('Dimension in inches\n& Shape'),
  E1: text('Representative Image'), G1: text('Material'), H1: text('Fabric Per pc'), I1: text('Total fabric'),
  J1: text('Fabric price per meter'), K1: text('Total Fabric Amount'), L1: text('Packing cost/pc'),
  M1: text('Total packing cost'), N1: text('Packing Type:\n(BCF: Bubble, Foam, Corrugate)\nOR (CB: Carton Box)'),
}

/** Row `r` of the cost sheet, as the template's formulas cache it for Master row r + 30. */
function costRow(r: number, v: { code: string | null; qty: number; metres?: Cell; price?: Cell; packing?: Cell; type?: Cell }): Record<string, Cell> {
  const m = r + 30
  const row: Record<string, Cell> = {
    [`A${r}`]: v.code === null ? fNum(`Master!A${m}`, 0) : fText(`Master!A${m}`, v.code),
    [`B${r}`]: fText(`Master!B${m}`, v.qty > 0 ? 'A product' : '0'),
    [`C${r}`]: fNum(`Master!C${m}`, v.qty),
    [`G${r}`]: fText(`IF(Master!G${m}<>"",Master!G${m}," ")`, 'Acacia wood'),
    [`I${r}`]: fNum(`H${r}*C${r}`, 0),
    [`K${r}`]: fNum(`J${r}*I${r}`, 0),
    [`M${r}`]: fNum(`L${r}*C${r}`, 0),
  }
  if (v.metres) row[`H${r}`] = v.metres
  if (v.price) row[`J${r}`] = v.price
  if (v.packing) row[`L${r}`] = v.packing
  if (v.type) row[`N${r}`] = v.type
  return row
}

const FINISH_HEADINGS: Record<string, Cell> = {
  A1: text('Code'), B1: text('Name'), C1: text('Quantity'), D1: text('Dimensions / Shape'), E1: text('Representative Image'),
  G1: text('Fabric Approval'), H1: text('Wood Finish Approval'), I1: text('Metal Finish'), J1: text('Marble/Rope Approval'),
}

function finishRow(r: number, v: { code: string | null; qty: number; specs?: Record<string, Cell> }): Record<string, Cell> {
  const m = r + 30
  return {
    [`A${r}`]: v.code === null ? fNum(`Master!A${m}`, 0) : fText(`Master!A${m}`, v.code),
    [`C${r}`]: fNum(`Master!C${m}`, v.qty),
    ...(v.specs ?? {}),
  }
}

const MASTER: Record<string, Cell> = { A31: text('Code'), B31: text('Name') }

const TEMPLATE = {
  Master: MASTER,
  [COST_SHEET_NAME]: {
    ...COST_HEADINGS,
    ...costRow(2, { code: '100-B001', qty: 25, metres: num(0.75), price: num(650), packing: num(550), type: text('BCF') }),
    ...costRow(3, { code: '100-B002', qty: 4, metres: num(0), packing: num(450) }),
    ...costRow(4, { code: '100-B003', qty: 2, metres: noCache('X4'), price: text('1,250'), packing: num(450), type: text(' Carton and Carret ') }),
    // The template's untouched rows: Master cells blank, cached as 0.
    ...costRow(5, { code: null, qty: 0, packing: num(3500) }),
  },
  [FINISH_SHEET_NAME]: {
    ...FINISH_HEADINGS,
    ...finishRow(2, { code: '100-B001', qty: 25, specs: { G2: text('Gaurika Fabric – MOROCCO'), H2: text('Acacia natural'), I2: text('NA'), J2: text('NA') } }),
    ...finishRow(3, { code: '100-B002', qty: 4, specs: { G3: text('PENDING'), H3: text('PENDING'), I3: text('PENDING'), J3: text('PENDING') } }),
    ...finishRow(4, { code: '100-B003', qty: 2, specs: { H4: text('Matt black PU') } }),
    ...finishRow(5, { code: null, qty: 0 }),
  },
}

const product = (row: number, code: string | null, seq: string | null, quantity = 1): PiProduct => ({
  row, sourceProductCode: code, productName: 'A product', quantity, dimensions: null, material: null,
  costPerPiece: 100, lineTotal: 100 * quantity, itemSequence: seq, customization: null,
  representativeImage: null, customizationImages: [],
})

// ── The cost sheet ────────────────────────────────────────────────────────────

describe('the "Packing cost and Fabric Cost" sheet', () => {
  test('reads the per-product values beside their headings, rows with a quantity only', async () => {
    const out = await read(TEMPLATE)
    assert.ok(out.cost.found)
    assert.equal(out.cost.headingRow, 1)
    assert.equal(out.cost.lines.length, 3, 'the untouched template row (quantity 0) is not a line')
    const [a, b, c] = out.cost.lines
    assert.deepEqual(a, {
      sheetRow: 2, code: '100-B001', quantity: 25,
      fabricMetresPerPiece: 0.75, fabricPricePerMetre: 650, packingCostPerPiece: 550, packingType: 'BCF',
    })
    assert.equal(b.fabricMetresPerPiece, 0, 'a typed zero is zero, not blank')
    assert.equal(b.fabricPricePerMetre, null, 'a blank price is blank')
    assert.equal(b.packingType, null)
    assert.equal(c.fabricMetresPerPiece, null, 'a formula with no cached result is not a figure')
    assert.equal(c.fabricPricePerMetre, 1250, 'a number typed as text with a thousands separator still reads')
    assert.equal(c.packingType, 'Carton and Carret', 'surrounding whitespace is trimmed')
  })

  test('is reported, not guessed, when it is absent', async () => {
    const out = await read({ Master: MASTER, [FINISH_SHEET_NAME]: TEMPLATE[FINISH_SHEET_NAME] })
    assert.equal(out.cost.found, false)
    if (out.cost.found === false) {
      assert.equal(out.cost.reason, 'missing')
      assert.match(out.cost.detail, /Packing cost and Fabric Cost/)
    }
    assert.ok(out.finish.found, 'the other sheet is still read')
  })

  test('is reported when a heading it needs is not there', async () => {
    const renamed = { ...TEMPLATE[COST_SHEET_NAME], H1: text('Fabric / pc') }
    const out = await read({ ...TEMPLATE, [COST_SHEET_NAME]: renamed })
    assert.equal(out.cost.found, false)
    if (out.cost.found === false) {
      assert.equal(out.cost.reason, 'headings')
      assert.match(out.cost.detail, /"Fabric Per pc" was not found/)
    }
  })

  test('finds its headings further down when a title was added above them', async () => {
    const moved: Record<string, Cell> = { A1: text('Costing for Order 100') }
    for (const [address, cell] of Object.entries(TEMPLATE[COST_SHEET_NAME])) {
      const m = /^([A-Z]+)(\d+)$/.exec(address) as RegExpExecArray
      moved[`${m[1]}${Number(m[2]) + 2}`] = cell
    }
    const out = await read({ ...TEMPLATE, [COST_SHEET_NAME]: moved })
    assert.ok(out.cost.found)
    assert.equal(out.cost.headingRow, 3)
    assert.equal(out.cost.lines.length, 3)
    assert.equal(out.cost.lines[0].sheetRow, 4)
  })

  test('matches the sheet name without regard to case or stray spaces', async () => {
    const out = await read({ Master: MASTER, 'packing cost and fabric cost ': TEMPLATE[COST_SHEET_NAME] })
    assert.ok(out.cost.found)
    assert.equal(out.cost.lines.length, 3)
  })

  test('a negative figure is not a figure', async () => {
    const sheet = { ...TEMPLATE[COST_SHEET_NAME], ...costRow(2, { code: '100-B001', qty: 25, metres: num(-1), packing: num(550) }) }
    const out = await read({ ...TEMPLATE, [COST_SHEET_NAME]: sheet })
    assert.ok(out.cost.found)
    assert.equal(out.cost.lines[0].fabricMetresPerPiece, null)
  })
})

// ── The finish sheet ──────────────────────────────────────────────────────────

describe('the "Fabric and Finish" sheet', () => {
  test('keeps every typed choice under its own heading, in column order', async () => {
    const out = await read(TEMPLATE)
    assert.ok(out.finish.found)
    assert.equal(out.finish.lines.length, 3)
    assert.deepEqual(out.finish.lines[0].specs, [
      { heading: 'Fabric Approval', value: 'Gaurika Fabric – MOROCCO' },
      { heading: 'Wood Finish Approval', value: 'Acacia natural' },
      { heading: 'Metal Finish', value: 'NA' },
      { heading: 'Marble/Rope Approval', value: 'NA' },
    ])
    assert.deepEqual(out.finish.lines[1].specs.map(s => s.value), ['PENDING', 'PENDING', 'PENDING', 'PENDING'],
      'PENDING is kept as the sheet wrote it; what it means is decided later')
    assert.deepEqual(out.finish.lines[2].specs, [{ heading: 'Wood Finish Approval', value: 'Matt black PU' }],
      'blank cells are no choice at all')
  })

  test('takes whatever headings the sheet carries, and leaves a formula column out', async () => {
    const own = {
      ...FINISH_HEADINGS,
      F1: text('Material'), G1: text('Fabric 1'), H1: text('Fabric 2'), I1: text('Wood Finish Approval'),
      J1: text('Metal Finish'), K1: text('Marble/Rope Approval'), L1: text('Seat Fabric'),
      ...finishRow(2, { code: '100-B001', qty: 31, specs: {
        F2: fText('Master!G32', 'Acacia Wood & Upholstery'),
        G2: text('Gaurika – MOROCCO Sr. 6'), H2: text('Aartex Pirates 108'), I2: text('Acacia Natural'),
        J2: text('NA'), K2: text('NA'), L2: text('Gaurika – FIAMMA'),
      } }),
    }
    const out = await read({ ...TEMPLATE, [FINISH_SHEET_NAME]: own })
    assert.ok(out.finish.found)
    assert.deepEqual(out.finish.lines[0].specs.map(s => s.heading),
      ['Fabric 1', 'Fabric 2', 'Wood Finish Approval', 'Metal Finish', 'Marble/Rope Approval', 'Seat Fabric'])
  })

  test('is reported when absent or re-headed', async () => {
    const absent = await read({ Master: MASTER, [COST_SHEET_NAME]: TEMPLATE[COST_SHEET_NAME] })
    assert.equal(absent.finish.found, false)
    const reheaded = await read({ ...TEMPLATE, [FINISH_SHEET_NAME]: { ...TEMPLATE[FINISH_SHEET_NAME], E1: text('Picture') } })
    assert.equal(reheaded.finish.found, false)
    if (reheaded.finish.found === false) assert.equal(reheaded.finish.reason, 'headings')
  })
})

// ── Matching to the Master's products ─────────────────────────────────────────

describe('matching sheet rows to the Master products', () => {
  test('pairs by product code, wherever the row sits, and by row offset only when neither side has a code', async () => {
    const sheets = await read(TEMPLATE)
    // The Master lists B002 before B001 (rows swapped), and a third product with no code at row 34.
    const products = [product(32, '100-B002', 'B002', 4), product(33, '100-B001', 'B001', 25), product(34, null, 'B003', 2)]
    const sheetsWithBlankCode: FabricFinishSheets = {
      ...sheets,
      cost: { ...sheets.cost, lines: sheets.cost.lines.map(l => (l.sheetRow === 4 ? { ...l, code: null } : l)) },
    }
    const m = matchFabricFinishSheets(sheetsWithBlankCode, products)
    assert.equal(m.products[0].cost?.sheetRow, 3, 'B002 found its row by code')
    assert.equal(m.products[1].cost?.sheetRow, 2, 'B001 found its row by code')
    assert.equal(m.products[2].cost?.sheetRow, 4, 'the code-less product took the code-less row at its template offset')
    assert.equal(m.products[0].finish?.sheetRow, 3)
    assert.equal(m.products[1].finish?.sheetRow, 2)
    assert.equal(m.products[2].finish, null, 'the finish row at 4 carries a code the Master does not, so it is not assumed')
    assert.deepEqual(m.unmatched, [{ sheet: 'finish', sheetRow: 4, code: '100-B003' }])
  })

  test('a product with no row on a sheet simply has none', async () => {
    const sheets = await read(TEMPLATE)
    const m = matchFabricFinishSheets(sheets, [product(32, '100-B001', 'B001', 25), product(36, '100-B009', 'B009', 1)])
    assert.equal(m.products[1].cost, null)
    assert.equal(m.products[1].finish, null)
    assert.equal(m.unmatched.length, 4, 'the two rows for B002 and B003 on each sheet match nothing')
  })

  test('one sheet row serves one product, even when two products print the same code', async () => {
    const sheets = await read(TEMPLATE)
    const m = matchFabricFinishSheets(sheets, [product(32, '100-B001', 'B001', 25), product(33, '100-B001', 'B002', 25)])
    assert.equal(m.products[0].cost?.sheetRow, 2)
    assert.equal(m.products[1].cost, null)
  })
})

describe('approval pictures on the "Fabric and Finish" sheet', () => {
  const FINISH: Record<string, Cell> = {
    A1: text('Code'), B1: text('Name'), C1: text('Quantity'), D1: text('Dimensions'), E1: text('Representative Image'),
    G1: text('Fabric Approval'), H1: text('Wood Finish Approval'), I1: text('Metal Finish'),
    A2: fText("Master!A32", '359-B001'), B2: fText("Master!B32", 'Chair'), C2: fNum("Master!C32", 4),
    G2: text('Tony 115'), H2: text('PENDING'),
  }
  const specsOf = async (anchors: string[], media: Record<string, Uint8Array>) => {
    const sheets = await read({ [FINISH_SHEET_NAME]: FINISH }, drawingParts(1, anchors, media))
    assert.equal(sheets.finish.found, true)
    return sheets.finish.lines[0].specs
  }

  test('a picture joins the text in its own cell, and stands alone in a blank one', async () => {
    const specs = await specsOf([anchor(6, 1, 'rId1'), anchor(8, 1, 'rId2')], { 'image1.png': PNG, 'image2.png': PNG })
    assert.deepEqual(specs.map(s => [s.heading, s.value, s.picture?.extension ?? null]), [
      ['Fabric Approval', 'Tony 115', 'png'],
      ['Wood Finish Approval', 'PENDING', null],
      ['Metal Finish', '', 'png'],
    ])
  })

  test('the product picture beside them is not an approval picture', async () => {
    const specs = await specsOf([anchor(4, 1, 'rId1')], { 'image1.png': PNG })
    assert.ok(specs.every(s => !s.picture))
  })

  test('a picture under no heading, or in a format the key cannot hold, is left out and the text stays', async () => {
    const specs = await specsOf([anchor(5, 1, 'rId1'), anchor(6, 1, 'rId2')], { 'image1.png': PNG, 'image2.gif': GIF })
    assert.deepEqual(specs.map(s => [s.heading, s.value, s.picture ?? null]), [
      ['Fabric Approval', 'Tony 115', null],
      ['Wood Finish Approval', 'PENDING', null],
    ])
  })

  test('a sheet with no drawing reads exactly as before', async () => {
    const sheets = await read({ [FINISH_SHEET_NAME]: FINISH })
    assert.deepEqual(sheets.finish.lines[0].specs, [
      { heading: 'Fabric Approval', value: 'Tony 115' },
      { heading: 'Wood Finish Approval', value: 'PENDING' },
    ])
  })
})
