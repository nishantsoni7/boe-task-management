/**
 * The ERP line-items sheet: the ERP's own header, one Description column.
 *
 * Run:
 *   npx tsx --test src/lib/orders/erpLineItems.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import { strFromU8, unzipSync } from 'fflate'
import {
  ERP_LINE_ITEMS_HEADERS,
  buildErpLineItemsWorkbook,
  erpDescription,
  erpLineItemRows,
  erpLineItemsFileName,
} from './erpLineItems'
import { ERP_FROZEN_COLUMNS, erpRowHeightPoints, fitInBox, type ErpSheetImage } from './erpWorkbookImages'

const product = {
  orderProductCode: '524-BE0001', productName: 'Lounge chair', dimensions: '24 x 30 x 32 inches',
  material: 'Teak', customization: 'Rope weave', quantity: 12, costPerPiece: 4500,
}

describe('ERP line items', () => {
  test('the header is the ERP template, 23 columns in order', () => {
    assert.equal(ERP_LINE_ITEMS_HEADERS.length, 23)
    assert.equal(ERP_LINE_ITEMS_HEADERS[0], 'Item Type')
    assert.equal(ERP_LINE_ITEMS_HEADERS[3], 'Description')
    assert.equal(ERP_LINE_ITEMS_HEADERS[22], 'PO Allowed - Cord')
  })

  test('size, material and customization share the Description; dimension columns stay empty', () => {
    const rows = erpLineItemRows([product])
    assert.equal(rows.length, 2)
    assert.equal(rows[1][1], '')
    assert.equal(rows[1][2], 'Lounge chair')
    assert.equal(rows[1][3], 'Dimensions: 24 x 30 x 32 inches\nMaterial: Teak\nCustomization: Rope weave')
    assert.equal(rows[1][4], 12)
    assert.equal(rows[1][5], 4500)
    for (const i of [0, 1, 6, 7, 8, 9, 10, 11, 12, 22]) assert.equal(rows[1][i], '')
  })

  test('missing details are left out, not invented', () => {
    assert.equal(erpDescription({ dimensions: null, material: ' ', customization: 'Ivory' }), 'Customization: Ivory')
    const row = erpLineItemRows([{ ...product, orderProductCode: null, quantity: null, costPerPiece: null }])[1]
    assert.equal(row[1], '')
    assert.equal(row[4], '')
    assert.equal(row[5], '')
  })

  test('the workbook round-trips with the header on row 1', async () => {
    const bytes = await buildErpLineItemsWorkbook([product])
    const wb = XLSX.read(bytes, { type: 'array' })
    const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], { header: 1 })
    assert.deepEqual(rows[0], [...ERP_LINE_ITEMS_HEADERS])
    assert.ok(!rows[1][1])
    assert.equal(rows[1][2], 'Lounge chair')
  })

  test('the header is bold on grey and the cells wrap, so Description shows its lines', async () => {
    const files = unzipSync(await buildErpLineItemsWorkbook([product]))
    const styles = strFromU8(files['xl/styles.xml'])
    assert.ok(styles.includes('<b/>'))
    assert.match(styles, /FFDBDBDB/)
    assert.match(styles, /wrapText="1"/)
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml'])
    assert.match(sheet, /<c r="A1"[^>]* s="1"/)
    assert.match(sheet, /<c r="W1"[^>]* s="1"/)
    assert.match(sheet, /<c r="D2"[^>]* s="2"/)
  })

  test('file name', () => {
    assert.equal(erpLineItemsFileName('0524', 'Acme'), '0524 ERP line items.xlsx')
  })

  test('columns A to D are frozen even with no pictures', async () => {
    const sheet = strFromU8(unzipSync(await buildErpLineItemsWorkbook([product]))['xl/worksheets/sheet1.xml'])
    assert.equal(ERP_FROZEN_COLUMNS, 4)
    assert.match(sheet, /<pane xSplit="4" topLeftCell="E1" activePane="topRight" state="frozen"\/>/)
    assert.equal(/<drawing /.test(sheet), false, 'no picture, no drawing part')
  })
})

// A 1x1 PNG, enough to be a real picture part.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0))
const picture = (over: Partial<ErpSheetImage> = {}): ErpSheetImage => ({ bytes: PNG, width: 80, height: 100, ext: 'png', ...over })

describe('ERP pictures over the Item Type column (owner, 2026-10-27)', () => {
  const two = [product, { ...product, orderProductCode: '524-BE0002', productName: 'Side table' }]

  test('each product gets its picture anchored on column A of its own row; the cells stay empty', async () => {
    const files = unzipSync(await buildErpLineItemsWorkbook(two, [picture(), picture({ width: 110, height: 60 })]))
    const drawing = strFromU8(files['xl/drawings/drawing1.xml'])
    const anchors = drawing.match(/<xdr:oneCellAnchor>/g) ?? []
    assert.equal(anchors.length, 2)
    assert.match(drawing, /<xdr:from><xdr:col>0<\/xdr:col>[^]*?<xdr:row>1<\/xdr:row>/, 'first product on worksheet row 2 (index 1)')
    assert.match(drawing, /<xdr:row>2<\/xdr:row>/, 'second product on worksheet row 3')
    assert.match(drawing, /r:embed="rId1"/)
    assert.match(drawing, /r:embed="rId2"/)
    assert.ok(files['xl/media/image1.png'] && files['xl/media/image2.png'])
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml'])
    assert.match(sheet, /<c r="A2"[^>]*><v><\/v><\/c>/, 'Item Type cell is still empty')
  })

  test('the parts are wired together: sheet -> drawing -> pictures, with their content types', async () => {
    const files = unzipSync(await buildErpLineItemsWorkbook(two, [picture(), picture()]))
    assert.match(strFromU8(files['xl/worksheets/_rels/sheet1.xml.rels']), /Target="\.\.\/drawings\/drawing1\.xml"/)
    assert.match(strFromU8(files['xl/drawings/_rels/drawing1.xml.rels']), /Target="\.\.\/media\/image1\.png"/)
    assert.match(strFromU8(files['[Content_Types].xml']), /PartName="\/xl\/drawings\/drawing1\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.drawing\+xml"/)
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml'])
    assert.match(sheet, /<drawing r:id="rId1"\/><\/worksheet>$/)
  })

  test('a row with a picture is taller; a product without one is left alone', async () => {
    const files = unzipSync(await buildErpLineItemsWorkbook(two, [picture({ height: 100 }), null]))
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml'])
    assert.match(sheet, new RegExp(`<row r="2"[^>]* ht="${erpRowHeightPoints(100)}" customHeight="1">`))
    assert.equal(/<row r="3"[^>]*customHeight/.test(sheet), false)
    assert.equal((strFromU8(files['xl/drawings/drawing1.xml']).match(/<xdr:oneCellAnchor>/g) ?? []).length, 1)
  })

  test('the header words and order, and the data, are exactly what they were', async () => {
    const bytes = await buildErpLineItemsWorkbook(two, [picture(), picture()])
    const wb = XLSX.read(bytes, { type: 'array' })
    const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], { header: 1 })
    assert.deepEqual(rows[0], [...ERP_LINE_ITEMS_HEADERS])
    assert.equal(rows[1][2], 'Lounge chair')
    assert.equal(rows[2][2], 'Side table')
  })

  test('pictures are fitted inside the square and never enlarged', () => {
    assert.deepEqual(fitInBox(220, 110), { width: 110, height: 55 })
    assert.deepEqual(fitInBox(50, 40), { width: 50, height: 40 })
    assert.deepEqual(fitInBox(0, 0), { width: 110, height: 110 })
  })
})
