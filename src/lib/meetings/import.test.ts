/**
 * Spreadsheet parsing, validation and (order + SKU) matching.
 *
 * The two things this suite exists to hold:
 *
 *   * the preview must be TRUE. If it says "2 rows will be added, 1 updated",
 *     the import must do exactly that — which means the matching here has to
 *     use the same normalisation the database's generated `sku_key` /
 *     `order_number_key` columns use (`upper(btrim(...))`).
 *   * a bad row is REPORTED, not silently dropped and not fatal to the file.
 *
 * Run:
 *   npx tsx --test src/lib/meetings/import.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  IMPORT_TEMPLATE_COLUMNS, IMPORT_TEMPLATE_HEADERS,
  buildImportPreview, parseSheetDate, parseOrderType, summarizeImportMatches,
  type RawSheetRow,
} from './import'

/** A complete, valid row keyed by the template's own headers. */
const sheetRow = (over: Partial<Record<string, unknown>> = {}): RawSheetRow => ({
  'Order Number': '2041',
  'Order Type': 'New Order',
  'Customer': 'Leela Hotel',
  'Expected Dispatch Date': '2026-09-15',
  'SKU': 'BOE-CH-118',
  'Product Name': 'Chesterfield Armchair',
  'Quantity': 4,
  'Current Stage': 'Polishing',
  'Current Update': 'Frames done',
  'Issue': 'Fabric shade pending',
  'Responsible Department': 'Operations',
  'Next Follow-up Date': '2026-08-12',
  ...over,
}) as RawSheetRow

describe('the template', () => {
  test('declares exactly the twelve BOE columns, in order', () => {
    assert.deepEqual([...IMPORT_TEMPLATE_HEADERS], [
      'Order Number', 'Order Type', 'Customer', 'Expected Dispatch Date',
      'SKU', 'Product Name', 'Quantity', 'Current Stage',
      'Current Update', 'Issue', 'Responsible Department', 'Next Follow-up Date',
    ])
  })

  test('only order number, SKU and product name are required', () => {
    const required = IMPORT_TEMPLATE_COLUMNS.filter(c => c.required).map(c => c.field)
    assert.deepEqual(required, ['order_number', 'sku', 'product_name'])
  })
})

describe('parseSheetDate', () => {
  test('accepts ISO', () => {
    assert.equal(parseSheetDate('2026-08-12'), '2026-08-12')
    assert.equal(parseSheetDate('2026-8-5'), '2026-08-05')
  })

  test('reads DD/MM/YYYY the Indian way, not the American way', () => {
    // 03/04 is 3 April. Reading it as 4 March would move a follow-up by a month.
    assert.equal(parseSheetDate('03/04/2026'), '2026-04-03')
    assert.equal(parseSheetDate('3-4-2026'), '2026-04-03')
    assert.equal(parseSheetDate('12.08.2026'), '2026-08-12')
  })

  test('reads a real Date cell at its UTC day', () => {
    assert.equal(parseSheetDate(new Date(Date.UTC(2026, 7, 12))), '2026-08-12')
  })

  test('reads an Excel serial number', () => {
    // 45000 → 2023-03-15 on Excel's 1899-12-30 epoch.
    assert.equal(parseSheetDate(45000), '2023-03-15')
  })

  test('an empty cell is null, not an error', () => {
    assert.equal(parseSheetDate(''), null)
    assert.equal(parseSheetDate(null), null)
    assert.equal(parseSheetDate(undefined), null)
  })

  test('rejects an impossible date rather than rolling it forward', () => {
    // 31/02 must not silently become 3 March.
    assert.equal(parseSheetDate('31/02/2026'), null)
    assert.equal(parseSheetDate('2026-13-01'), null)
    assert.equal(parseSheetDate('next monday'), null)
  })
})

describe('parseOrderType', () => {
  test('accepts the label, the key and common casings', () => {
    assert.equal(parseOrderType('New Order'), 'new_order')
    assert.equal(parseOrderType('new_order'), 'new_order')
    assert.equal(parseOrderType('NEW'), 'new_order')
    assert.equal(parseOrderType('Repair Order'), 'repair_order')
    assert.equal(parseOrderType('repair'), 'repair_order')
  })

  test('an empty cell and an unknown word are both null', () => {
    assert.equal(parseOrderType(''), null)
    assert.equal(parseOrderType('Sample'), null)
  })
})

describe('buildImportPreview — wrong file', () => {
  test('a file missing a required header imports nothing and says which', () => {
    const preview = buildImportPreview([{ 'Order Number': '2041', 'Customer': 'X' } as RawSheetRow])
    assert.deepEqual(preview.missingHeaders, ['SKU', 'Product Name'])
    assert.equal(preview.valid.length, 0)
    // Not 200 identical row errors — the problem is the file, said once.
    assert.equal(preview.errors.length, 0)
  })

  test('extra columns are reported but ignored, not fatal', () => {
    const preview = buildImportPreview([sheetRow({ 'Salesperson': 'Ravi' })])
    assert.deepEqual(preview.missingHeaders, [])
    assert.equal(preview.valid.length, 1)
    assert.equal(preview.unknownHeaders.length, 1)
  })

  test('headers are matched ignoring case, spacing and the hyphen', () => {
    const preview = buildImportPreview([{
      'order number': '2041', 'sku': 'A-1', 'Product_Name': 'Chair',
      'next followup date': '2026-08-12',
    } as RawSheetRow])
    assert.deepEqual(preview.missingHeaders, [])
    assert.equal(preview.valid.length, 1)
    assert.equal(preview.valid[0].next_follow_up_date, '2026-08-12')
  })
})

describe('buildImportPreview — rows', () => {
  test('a complete row parses into exactly what the RPC receives', () => {
    const preview = buildImportPreview([sheetRow()])
    assert.deepEqual(preview.errors, [])
    assert.deepEqual(preview.valid[0], {
      order_number: '2041',
      order_type: 'new_order',
      customer_name: 'Leela Hotel',
      expected_dispatch_date: '2026-09-15',
      sku: 'BOE-CH-118',
      product_name: 'Chesterfield Armchair',
      quantity: 4,
      current_stage: 'Polishing',
      latest_update: 'Frames done',
      issue: 'Fabric shade pending',
      // Departments are stored as their Control Center key, always lower case.
      responsible_department: 'operations',
      next_follow_up_date: '2026-08-12',
    })
  })

  test('an entirely blank row is skipped silently — a trailing row is not an error', () => {
    const preview = buildImportPreview([
      sheetRow(),
      { 'Order Number': '', 'SKU': '', 'Product Name': '', 'Customer': null } as RawSheetRow,
    ])
    assert.equal(preview.valid.length, 1)
    assert.deepEqual(preview.errors, [])
  })

  test('a missing required value is reported against its spreadsheet row number', () => {
    const preview = buildImportPreview([
      sheetRow(),
      sheetRow({ 'SKU': '' }),
    ])
    assert.equal(preview.valid.length, 1)
    assert.equal(preview.errors.length, 1)
    // Header is row 1, so the second data row is row 3 in Excel.
    assert.equal(preview.errors[0].rowNumber, 3)
    assert.match(preview.errors[0].message, /SKU is required/)
  })

  test('a bad row does not abort the file — the good rows still import', () => {
    const preview = buildImportPreview([
      sheetRow({ 'SKU': 'A-1' }),
      sheetRow({ 'SKU': 'A-2', 'Next Follow-up Date': 'sometime next week' }),
      sheetRow({ 'SKU': 'A-3' }),
    ])
    assert.deepEqual(preview.valid.map(r => r.sku), ['A-1', 'A-3'])
    assert.equal(preview.errors.length, 1)
    assert.match(preview.errors[0].message, /not a valid date/)
  })

  test('every problem in one row is reported together, not one per upload', () => {
    const preview = buildImportPreview([
      sheetRow({ 'SKU': '', 'Quantity': 'four', 'Order Type': 'Sample' }),
    ])
    assert.equal(preview.errors.length, 1)
    const message = preview.errors[0].message
    assert.match(message, /SKU is required/)
    assert.match(message, /not a number/)
    assert.match(message, /New Order or Repair Order/)
  })

  test('two rows for the same order and SKU: the second is refused, not silently applied', () => {
    // Without this the second row would overwrite the first inside one import
    // and the user would never know which value survived.
    const preview = buildImportPreview([
      sheetRow({ 'SKU': 'A-1', 'Current Update': 'first' }),
      sheetRow({ 'SKU': ' a-1 ', 'Current Update': 'second' }),
    ])
    assert.equal(preview.valid.length, 1)
    assert.equal(preview.valid[0].latest_update, 'first')
    assert.match(preview.errors[0].message, /Duplicate of row 2/)
  })

  test('the same SKU under a different order is not a duplicate', () => {
    const preview = buildImportPreview([
      sheetRow({ 'Order Number': '2041', 'SKU': 'A-1' }),
      sheetRow({ 'Order Number': '2042', 'SKU': 'A-1' }),
    ])
    assert.equal(preview.valid.length, 2)
    assert.deepEqual(preview.errors, [])
  })

  test('a blank optional cell becomes null rather than an empty string', () => {
    const preview = buildImportPreview([sheetRow({
      'Customer': '', 'Current Stage': null, 'Issue': '   ',
      'Quantity': '', 'Next Follow-up Date': '',
    })])
    const row = preview.valid[0]
    assert.equal(row.customer_name, null)
    assert.equal(row.current_stage, null)
    assert.equal(row.issue, null)
    assert.equal(row.quantity, null)
    assert.equal(row.next_follow_up_date, null)
  })

  test('an omitted Order Type is null, so the RPC applies the meeting type', () => {
    const preview = buildImportPreview([sheetRow({ 'Order Type': '' })])
    assert.equal(preview.valid[0].order_type, null)
  })

  test('orderCount counts distinct orders, not rows', () => {
    const preview = buildImportPreview([
      sheetRow({ 'Order Number': '2041', 'SKU': 'A-1' }),
      sheetRow({ 'Order Number': '2041', 'SKU': 'A-2' }),
      sheetRow({ 'Order Number': ' 2042 ', 'SKU': 'A-1' }),
    ])
    assert.equal(preview.valid.length, 3)
    assert.equal(preview.orderCount, 2)
  })
})

describe('summarizeImportMatches', () => {
  const rows = buildImportPreview([
    sheetRow({ 'Order Number': '2041', 'SKU': 'A-1' }),
    sheetRow({ 'Order Number': '2041', 'SKU': 'A-2' }),
    sheetRow({ 'Order Number': '2042', 'SKU': 'A-1' }),
  ]).valid

  test('splits the rows into updates and additions', () => {
    const summary = summarizeImportMatches(rows, [{ orderNumber: '2041', sku: 'A-1' }])
    assert.deepEqual(summary, { updates: 1, additions: 2 })
  })

  test('matching normalises case and whitespace, exactly as the database does', () => {
    // The database matches on upper(btrim(...)) generated columns. A preview
    // that used raw strings would promise "new" and then produce an update.
    const summary = summarizeImportMatches(rows, [{ orderNumber: ' 2041 ', sku: 'a-1' }])
    assert.deepEqual(summary, { updates: 1, additions: 2 })
  })

  test('nothing existing means everything is an addition', () => {
    assert.deepEqual(summarizeImportMatches(rows, []), { updates: 0, additions: 3 })
  })

  test('an existing line absent from the sheet is never counted as a deletion', () => {
    // There is no deletion path at all. A line in the meeting but not in the
    // file keeps its history and its linked task, and the summary says nothing
    // about it.
    const summary = summarizeImportMatches(rows, [
      { orderNumber: '2041', sku: 'A-1' },
      { orderNumber: '9999', sku: 'GONE' },
    ])
    assert.deepEqual(summary, { updates: 1, additions: 2 })
  })
})
