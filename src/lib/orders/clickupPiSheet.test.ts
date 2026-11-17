// The PI sheet of an old order (Draft Orders, orders 300 and up): which orders get it, which Excel
// comes first, what the page is given from a parsed workbook, and the words when there is no list.
// Everything here is invented; real orders are customer data and never enter the repository.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { piSheetApplies, piSheetCandidates, piSheetReason, piSheetViewOf, piSheetViewOfQuotation } from './clickupPiSheet'
import type { DraftFile } from './clickupDrafts'
import type { PiParseResult } from '@/lib/pi/types'
import type { QuotationSheet } from '@/lib/pi/quotationSheet'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r/g, '')

const file = (id: string, name: string, uploaded_at: string | null): DraftFile =>
  ({ id, name, uploaded_at, uploaded_by: 'Uploader One', size: 1000, sha256: '' })

const amount = (n: number | null, text: string | null = null) => ({ amount: n, text, zeroMeaning: null, cell: 'I1' })

/** Only what the view reads; the parser itself is covered in masterSheetParser.test.ts. */
function parsed(over: { products?: unknown[]; blocking?: { code: string; row: number; message: string }[]; commercial?: Record<string, unknown> } = {}) {
  return {
    ok: true,
    warnings: [],
    blockingIssues: over.blocking ?? [],
    data: {
      header: {
        sourceOrderNumber: '407', creationDate: { iso: '2026-09-30', text: '30-Sep-26', source: 'serial' }, createdBy: 'Salesperson One',
        billToName: 'Example Buyer Ltd', billToPhone: '9000000002', billingAddress: '1 Invented Road', shipToName: null, shipToPhone: null, shippingAddress: null,
      },
      products: over.products ?? [
        { row: 32, sourceProductCode: '407-B001', productName: 'Bed', quantity: 6, dimensions: 'King', material: 'Teak', costPerPiece: 47500, lineTotal: 285000, customization: null },
        { row: 33, sourceProductCode: '407-B002', productName: 'Sidetable', quantity: 12, dimensions: null, material: null, costPerPiece: 14800, lineTotal: 177600, customization: 'Single drawer' },
      ],
      commercial: {
        grossProductAmount: 462600, discount: 62600, discountLabel: 'Design Fees', subtotalAfterDiscount: amount(400000),
        fabricCost: amount(null), packingCost: amount(8000), transportation: amount(null, 'as applicable'), totalBeforeGst: amount(408000),
        gst: amount(73440), grandTotal: amount(481440), ...over.commercial,
      },
    },
  } as unknown as Extract<PiParseResult, { ok: true }>
}

describe('which orders get the list', () => {
  test('from order 300 up; below it, or with no number, the Excel stays a file', () => {
    for (const no of ['300', '528', '0300', '1200']) assert.equal(piSheetApplies(no), true, no)
    for (const no of ['299', '91', '', null, undefined, 'abc', '5x8', '12.5']) assert.equal(piSheetApplies(no as string | null), false, String(no))
  })
})

describe('which Excel comes first', () => {
  test('only .xlsx files, the newest upload first, a file with no date last', () => {
    const list = piSheetCandidates([
      file('a.xlsx', 'old.xlsx', '2026-01-01T00:00:00.000Z'),
      file('b.pdf', 'scan.pdf', '2026-12-01T00:00:00.000Z'),
      file('c.xlsx', 'undated.xlsx', null),
      file('d.xlsx', 'new.XLSX', '2026-06-01T00:00:00.000Z'),
      file('e.xls', 'ancient.xls', '2026-07-01T00:00:00.000Z'),
    ])
    assert.deepEqual(list.map(f => f.id), ['d.xlsx', 'a.xlsx', 'c.xlsx'])
  })
})

describe('what the page is given', () => {
  test('one line per product with its picture by sheet row, the customization and the size', () => {
    const v = piSheetViewOf(parsed(), new Map([[32, 'data:image/jpeg;base64,AAAA']]))
    assert.equal(v.lines.length, 2)
    assert.deepEqual(v.lines[0], { row: 32, code: '407-B001', name: 'Bed', quantity: 6, size: 'King', material: 'Teak', rate: 47500, total: 285000, customization: null, picture: 'data:image/jpeg;base64,AAAA' })
    assert.equal(v.lines[1].customization, 'Single drawer')
    assert.equal(v.lines[1].picture, null)
    assert.equal(v.missingPictures, 1)
  })

  test('empty template rows are not lines', () => {
    const v = piSheetViewOf(parsed({ products: [
      { row: 32, sourceProductCode: 'x', productName: 'Bed', quantity: 1, dimensions: null, material: null, costPerPiece: 100, lineTotal: 100, customization: null },
      { row: 33, sourceProductCode: 'y', productName: null, quantity: null, dimensions: null, material: null, costPerPiece: null, lineTotal: 0, customization: null },
    ] }), new Map())
    assert.deepEqual(v.lines.map(l => l.row), [32])
  })

  test('the totals are in rupees with Indian grouping, words stay words, empty ones are left out', () => {
    const v = piSheetViewOf(parsed(), new Map())
    assert.deepEqual(v.totals, [
      { label: 'Products', value: '₹4,62,600' },
      { label: 'Design Fees', value: '₹62,600' },
      { label: 'Subtotal', value: '₹4,00,000' },
      { label: 'Packing', value: '₹8,000' },
      { label: 'Transport', value: 'as applicable' },
      { label: 'Total before GST', value: '₹4,08,000' },
      { label: 'GST', value: '₹73,440' },
      { label: 'Grand total', value: '₹4,81,440' },
    ])
  })

  test('who, when and for whom, from the header', () => {
    const v = piSheetViewOf(parsed(), new Map())
    assert.equal(v.piNo, '407')
    assert.match(v.date ?? '', /^30 Sept? 2026$/)
    assert.equal(v.salesperson, 'Salesperson One')
    assert.deepEqual(v.billTo, { name: 'Example Buyer Ltd', phone: '9000000002', address: '1 Invented Road' })
  })

  test('picture and item-number problems are not problems; a missing price or footer is, in plain words', () => {
    const v = piSheetViewOf(parsed({ blocking: [
      { code: 'PRODUCT_IMAGE_REQUIRED', row: 32, message: 'x' },
      { code: 'PRODUCT_ITEM_SEQUENCE_MISSING', row: 32, message: 'x' },
      { code: 'PRODUCT_COST_INVALID', row: 33, message: 'long upload wording' },
      { code: 'PRODUCT_COST_INVALID', row: 33, message: 'long upload wording' },
      { code: 'FOOTER_NOT_FOUND', row: 122, message: 'upload the PI again' },
    ] }), new Map())
    assert.deepEqual(v.problems, ['Row 33 has no valid price.', 'The totals block could not be found, so no totals are shown.'])
  })

  test('many problems are cut to six and say how many more', () => {
    const blocking = Array.from({ length: 9 }, (_v, i) => ({ code: 'PRODUCT_NAME_MISSING', row: 40 + i, message: '' }))
    const v = piSheetViewOf(parsed({ blocking }), new Map())
    assert.equal(v.problems.length, 7)
    assert.equal(v.problems[6], '…and 3 more.')
  })
})

describe("a quotation's Excel in the same card", () => {
  const quotation = (over: Partial<QuotationSheet> = {}): QuotationSheet => ({
    title: 'Invented Cafe Project', client: 'Example Client', date: '2026-01-02', ref: 'QT-XX-00001', orderNo: '900',
    lines: [
      { row: 7, code: '900-BE001', name: 'Two Seater Table', description: 'Acacia wood', quantity: 10, unitPrice: 8600, total: 86000, notes: 'Frame size to be confirmed', image: null },
      { row: 8, code: null, name: 'Stool', description: null, quantity: 4, unitPrice: 1500, total: 6000, notes: null, image: null },
    ],
    totals: [{ label: 'Subtotal', amount: 92000 }, { label: 'Discount', amount: -2000 }, { label: 'Grand Total', amount: 106200 }],
    footnotes: ['Packing extra - 5000/-'], problems: [], ...over,
  })

  test('a PI sheet says kind pi, a quotation says kind quotation, with its title, ref and client', () => {
    assert.equal(piSheetViewOf(parsed(), new Map()).kind, 'pi')
    const v = piSheetViewOfQuotation(quotation(), new Map([[7, 'data:image/jpeg;base64,AAAA']]))
    assert.equal(v.kind, 'quotation')
    assert.equal(v.title, 'Invented Cafe Project')
    assert.equal(v.piNo, 'QT-XX-00001')
    assert.equal(v.billTo.name, 'Example Client')
    assert.equal(v.salesperson, null)
  })

  test('the description, unit price and notes ride in the size, rate and customization places; the picture is by row', () => {
    const v = piSheetViewOfQuotation(quotation(), new Map([[7, 'data:image/jpeg;base64,AAAA']]))
    assert.deepEqual(v.lines[0], { row: 7, code: '900-BE001', name: 'Two Seater Table', quantity: 10, size: 'Acacia wood', material: null, rate: 8600, total: 86000, customization: 'Frame size to be confirmed', picture: 'data:image/jpeg;base64,AAAA' })
    assert.equal(v.lines[1].picture, null)
    assert.equal(v.missingPictures, 1)
  })

  test("the totals are the sheet's own, as printed, a discount with its minus before the rupee sign", () => {
    const v = piSheetViewOfQuotation(quotation(), new Map())
    assert.deepEqual(v.totals, [{ label: 'Subtotal', value: '₹92,000' }, { label: 'Discount', value: '-₹2,000' }, { label: 'Grand Total', value: '₹1,06,200' }])
    assert.deepEqual(v.footnotes, ['Packing extra - 5000/-'])
  })
})

describe('the words when there is no list', () => {
  test('a quotation or dispatch sheet, an export or odd layout, and anything else', () => {
    assert.match(piSheetReason([{ code: 'MASTER_SHEET_MISSING' }]), /no PI or Quotation sheet/)
    assert.match(piSheetReason([{ code: 'TEMPLATE_FINGERPRINT_MISMATCH' }]), /dollars or euros/)
    assert.match(piSheetReason([{ code: 'NO_PRODUCT_ROWS' }]), /no product rows/)
    assert.match(piSheetReason([{ code: 'INVALID_ZIP' }]), /could not be read/)
  })
})

describe('the pi-sheet route', () => {
  const route = read('src/app/api/orders/clickup-drafts/[id]/pi-sheet/route.ts')

  test('it asks the Administrator first and only reads: nothing is written to the database or to storage', () => {
    assert.ok(route.indexOf('requireDraftsAdmin()') > 0)
    assert.ok(route.indexOf('requireDraftsAdmin()') < route.indexOf('.from('), 'the guard comes before the table')
    assert.ok(route.indexOf('requireDraftsAdmin()') < route.indexOf('.storage'), 'the guard comes before storage')
    for (const write of ['.insert(', '.update(', '.upsert(', '.delete(', '.upload(', '.remove(']) assert.equal(route.includes(write), false, write)
  })

  test('a workbook with no Master tab goes to the quotation reader, and only then', () => {
    const at = route.indexOf('readQuotationWorkbook(bytes)')
    assert.ok(at > route.indexOf('MASTER_SHEET_MISSING'), 'the quotation reader is tried only when the Master tab is missing')
    assert.ok(route.includes('piSheetViewOfQuotation('))
  })

  test('it reads in old-order mode, only for orders the rule names, and builds the path from ids', () => {
    assert.ok(route.includes('{ oldOrder: true }'))
    assert.ok(route.includes('piSheetApplies('))
    assert.ok(route.includes('draftFilePath('))
    assert.ok(route.includes('isFileId(wanted)'), 'a file asked for is checked before use')
  })

  test('the upload path of a new PI stays strict: nothing else passes the option', () => {
    for (const path of ['src/app/api/orders/import/process-draft/route.ts', 'src/app/api/orders/bdpi/import/route.ts', 'src/app/orders/import/page.tsx']) {
      assert.equal(read(path).includes('oldOrder: true'), false, path)
    }
  })
})
