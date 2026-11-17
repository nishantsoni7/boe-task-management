// The Quotation tab of an old order's Excel (the app's own quotation export), read for display.
// Every workbook here is built in process from invented names, quantities and prices: no real
// quotation, client or picture is committed (the repository is public). Offline and pure.
//
// Run: npx tsx --test src/lib/pi/quotationSheet.test.ts

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { zipSync } from 'fflate'
import { readQuotationWorkbook } from './quotationSheet'
import { parseBoePiWorkbook } from './masterSheetParser'

type Cell = string | number | null
const bytesOf = (s: string) => new TextEncoder().encode(s)
const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const letters = (i: number) => String.fromCharCode(65 + i)
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8])

function book(rows: Cell[][], opts: { tab?: string; pictures?: { col: number; row: number }[] } = {}): Uint8Array {
  const sheetData = rows.map((cells, r) => {
    const cs = cells.flatMap((v, c) => v === null ? [] : [typeof v === 'number'
      ? `<c r="${letters(c)}${r + 1}"><v>${v}</v></c>`
      : `<c r="${letters(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`])
    return `<row r="${r + 1}">${cs.join('')}</row>`
  }).join('')
  const pictures = opts.pictures ?? []
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheetData>${sheetData}</sheetData>${pictures.length ? '<drawing r:id="rIdDraw"/>' : ''}</worksheet>`
  const anchors = pictures.map((p, i) =>
    `<xdr:twoCellAnchor><xdr:from><xdr:col>${p.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${p.row - 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
    + `<xdr:to><xdr:col>${p.col + 1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${p.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`
    + `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 1}" name="Picture ${i + 1}"/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rIdImg${i}"/></xdr:blipFill></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`).join('')
  const parts: Record<string, Uint8Array> = {
    '[Content_Types].xml': bytesOf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`),
    '_rels/.rels': bytesOf(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': bytesOf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(opts.tab ?? 'Quotation')}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': bytesOf(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    'xl/worksheets/sheet1.xml': bytesOf(sheetXml),
    'xl/sharedStrings.xml': bytesOf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>`),
  }
  if (pictures.length) {
    parts['xl/worksheets/_rels/sheet1.xml.rels'] = bytesOf(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDraw" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`)
    parts['xl/drawings/drawing1.xml'] = bytesOf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`)
    parts['xl/drawings/_rels/drawing1.xml.rels'] = bytesOf(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${pictures.map((_p, i) => `<Relationship Id="rIdImg${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${i + 1}.png"/>`).join('')}</Relationships>`)
    pictures.forEach((_p, i) => { parts[`xl/media/image${i + 1}.png`] = PNG })
  }
  return zipSync(parts)
}

const HEADER: Cell[] = ['Code', 'Image', 'Product Name', 'Description', 'Quantity', 'Unit Price', 'Total', 'Notes']
const FULL: Cell[][] = [
  ['Invented Cafe Project'],
  ['Client: Example Client'],
  ['Date: 2026-01-02'],
  ['Ref: QT-XX-00001'],
  [],
  HEADER,
  ['900-BE001', null, 'Two Seater Table', 'Acacia wood 34x34x30', 10, 8600, 86000, 'Frame size to be confirmed'],
  ['900-BE002', null, 'Stool', 'Round, 18 inches', 4, 1500, 6000, null],
  [null, null, null, null, null, 'Subtotal:', 92000],
  [null, null, null, null, null, 'Discount:', -2000],
  [null, null, null, null, null, 'Tax (18%):', 16200],
  [null, null, null, null, null, 'Grand Total:', 106200],
  ['Packing extra - 5000/-'],
]

const ok = async (bytes: Uint8Array) => {
  const r = await readQuotationWorkbook(bytes)
  assert.equal(r.ok, true, r.ok ? '' : `refused: ${r.reason}`)
  if (!r.ok) throw new Error('unreachable')
  return r.data
}

describe('the Quotation tab as a list', () => {
  test('the header block, the lines, the totals as printed and the note under them', async () => {
    const q = await ok(book(FULL))
    assert.deepEqual([q.title, q.client, q.date, q.ref], ['Invented Cafe Project', 'Example Client', '2026-01-02', 'QT-XX-00001'])
    assert.equal(q.lines.length, 2)
    assert.deepEqual({ ...q.lines[0], image: null }, {
      row: 7, code: '900-BE001', name: 'Two Seater Table', description: 'Acacia wood 34x34x30', quantity: 10, unitPrice: 8600, total: 86000, notes: 'Frame size to be confirmed', image: null,
    })
    assert.equal(q.lines[1].notes, null)
    assert.deepEqual(q.totals, [
      { label: 'Subtotal', amount: 92000 }, { label: 'Discount', amount: -2000 }, { label: 'Tax (18%)', amount: 16200 }, { label: 'Grand Total', amount: 106200 },
    ])
    assert.deepEqual(q.footnotes, ['Packing extra - 5000/-'])
    assert.deepEqual(q.problems, [])
  })

  test('a sheet that is a quotation is not a PI: the strict reader says the Master tab is missing', async () => {
    const r = await parseBoePiWorkbook(book(FULL), { oldOrder: true })
    assert.equal(r.ok === false && r.errors[0].code, 'MASTER_SHEET_MISSING')
  })

  test('with no code column and the order number in the next cell', async () => {
    const rows: Cell[][] = [
      [null, 'Invented Flat, City'],
      [null, 'Order no:-', 470],
      [null, 'Client: Example Client'],
      [],
      ['Image', 'Product Name', 'Description', 'Quantity', 'Unit Price', 'Total', 'Notes'],
      [null, 'Wardrobe', 'Large unit', 1, 167200, 167200],
      [null, null, null, null, 'Subtotal:', 167200],
    ]
    const q = await ok(book(rows))
    assert.equal(q.title, 'Invented Flat, City')
    assert.equal(q.orderNo, '470')
    assert.equal(q.lines[0].code, null)
    assert.equal(q.lines[0].name, 'Wardrobe')
    assert.equal(q.lines[0].unitPrice, 167200)
  })

  test('two "Image" headings: the first is the code, the second the picture (order 469 prints it so)', async () => {
    const rows: Cell[][] = [
      ['Invented Hotel'],
      [],
      ['Image', 'Image', 'Product Name', 'Description', 'Quantity', 'Unit Price', 'Total', 'Notes'],
      ['469-BE001', null, 'Table Base', 'MS base plate', 6, 12600, 75600],
      [null, null, null, null, null, 'Subtotal:', 75600],
    ]
    const q = await ok(book(rows, { pictures: [{ col: 1, row: 4 }] }))
    assert.equal(q.lines[0].code, '469-BE001')
    assert.ok(q.lines[0].image, 'the picture is found in the second Image column')
    assert.equal(q.lines[0].image?.format, 'png')
  })

  test('each line gets the picture anchored on its own row in the Image column, and only that one', async () => {
    const q = await ok(book(FULL, { pictures: [{ col: 1, row: 7 }, { col: 4, row: 8 }] }))
    assert.ok(q.lines[0].image, 'row 7 has its picture')
    assert.equal(q.lines[1].image, null, 'a picture over the Quantity column is not a product picture')
  })

  test('the sheet is checked against its own arithmetic and the figures are kept as printed', async () => {
    const rows = FULL.map(r => [...r])
    rows[6][6] = 85000
    rows[8][6] = 99999
    const q = await ok(book(rows))
    assert.equal(q.lines[0].total, 85000, 'the printed line total is kept')
    assert.deepEqual(q.problems, ['Row 7: quantity × unit price does not equal the line total.', 'The printed subtotal does not equal the sum of the lines.'])
    assert.equal(q.totals[0].amount, 99999)
  })

  test('a tab named "quotation " is accepted, whatever its case or trailing space', async () => {
    assert.equal((await ok(book(FULL, { tab: 'quotation ' }))).lines.length, 2)
  })

  test('what is refused, and why', async () => {
    const why = async (bytes: Uint8Array) => { const r = await readQuotationWorkbook(bytes); return r.ok ? 'ok' : r.reason }
    assert.equal(await why(book(FULL, { tab: 'Master' })), 'NO_QUOTATION_TAB')
    assert.equal(await why(book([['Invented'], ['Client: X']])), 'NO_HEADER_ROW')
    assert.equal(await why(book([HEADER, [null, null, null, null, null, 'Subtotal:', 0]])), 'NO_LINES')
    assert.equal(await why(new Uint8Array([1, 2, 3, 4])), 'UNREADABLE')
  })
})
