/**
 * The ERP line-items sheet: the ERP's own header, one Description column.
 *
 * Run:
 *   npx tsx --test src/lib/orders/erpLineItems.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import {
  ERP_LINE_ITEMS_HEADERS,
  buildErpLineItemsWorkbook,
  erpDescription,
  erpLineItemRows,
  erpLineItemsFileName,
} from './erpLineItems'

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

  test('file name', () => {
    assert.equal(erpLineItemsFileName('0524', 'Acme'), '0524 ERP line items.xlsx')
  })
})
