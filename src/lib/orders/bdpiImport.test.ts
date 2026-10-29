import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { PiParseResult, PiProduct, PiProductImage } from '@/lib/pi/types'
import { bdpiFromWorkbook, bdpiPicturePath, describeBdpiError } from './bdpiImport'
import { itemDetails, parsePlanData } from './paymentPlan'
import { activeOrdersNav } from '@/lib/navigation/moduleNav'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')

const img = (format: PiProductImage['format'], row: number): PiProductImage => ({
  role: 'representative', row, part: `xl/media/image${row}.png`, bytes: new Uint8Array([1, 2, 3]), byteLength: 3,
  format, mimeType: format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : null,
  extension: format, anchorKind: 'oneCellAnchor', anchorFromCol: 4, anchorFromRow: row - 1,
})

const product = (over: Partial<PiProduct>): PiProduct => ({
  row: 32, sourceProductCode: 'SF-03', productName: 'Sofa', quantity: 4, dimensions: '80 x 36 in', material: 'Teak',
  costPerPiece: 16500, lineTotal: 66000, itemSequence: 'B012', customization: null,
  representativeImage: img('png', 32), customizationImages: [], ...over,
})

const amount = (a: number | null, text: string | null = null) => ({ amount: a, text, zeroMeaning: null, cell: 'I1' })

const workbook = (over: { products?: PiProduct[]; blocking?: { code: string; row?: number }[]; b20?: string | null } = {}): PiParseResult => ({
  ok: true,
  blockingIssues: (over.blocking ?? []).map(b => ({ code: b.code, row: b.row ?? null, cell: null, message: 'x' })) as never,
  warnings: [],
  data: {
    template: {} as never,
    header: {
      sourceOrderNumber: over.b20 === undefined ? ' 412 ' : over.b20, creationDate: null, createdBy: 'Asha', boeGst: null, contactNumber: null,
      billToName: 'Rivoli Hotels', billToPhone: null, billToGst: null, billingAddress: null,
      shipToName: null, shipToPhone: null, shipToGst: null, shippingAddress: null,
      orderConfirmationDate: null, dispatchCommitment: null,
    },
    products: over.products ?? [product({}), product({ row: 33, itemSequence: 'B013', productName: 'Chair', quantity: 10, costPerPiece: 2000, lineTotal: 20000, representativeImage: img('jpeg', 33) })],
    commercial: {
      discount: 0, discountLabel: null, subtotalAfterDiscount: amount(86000), fabricCost: amount(null, 'as per selection'),
      packingCost: amount(4000), transportation: amount(2000), totalBeforeGst: amount(92000), gst: amount(16560),
      grandTotal: amount(108560), grossProductAmount: 86000, expectedSubtotal: 86000,
    },
    piTerms: { fabricResponsibility: 'client', commercialTermsNote: 'Prices ex-works.' },
    representativeImages: [],
    customizationImages: [],
    fabricFinish: {
      cost: { found: true, headingRow: 3, lines: [
        { sheetRow: 4, code: 'SF-03', quantity: 4, fabricMetresPerPiece: 6.5, fabricPricePerMetre: 450, packingCostPerPiece: 800, packingType: 'BCF' },
      ] },
      finish: { found: true, headingRow: 3, lines: [
        { sheetRow: 4, code: 'SF-03', quantity: 4, specs: [{ heading: 'Fabric', value: 'Velvet Royal Blue' }, { heading: 'Wood Finish', value: 'Walnut' }] },
      ] },
    },
  },
})

test('a good workbook becomes a BDPI with the complete details the owner asked for', () => {
  const r = bdpiFromWorkbook(workbook(), { workbookName: 'Old PI 412.xlsx' })
  assert.equal(r.ok, true)
  if (!r.ok) return
  const p = r.payload
  assert.equal(p.old_order_no, '412')
  assert.equal(p.client_name, 'Rivoli Hotels')
  assert.equal(p.fabric_responsibility, 'client')
  assert.equal(p.commercial_terms_note, 'Prices ex-works.')
  assert.equal(p.commercial.total_before_gst, 92000)
  assert.equal(p.commercial.packing_cost, 4000)
  assert.equal(p.commercial.fabric_cost, null)
  assert.equal(p.commercial.fabric_cost_text, 'as per selection')
  assert.equal(p.items.length, 2)
  const sofa = p.items[0]
  assert.deepEqual([sofa.item_sequence, sofa.quantity, sofa.rate, sofa.dimensions, sofa.material], ['B012', 4, 16500, '80 x 36 in', 'Teak'])
  assert.deepEqual([sofa.fabric_metres_per_piece, sofa.fabric_price_per_metre, sofa.packing_cost_per_piece, sofa.packing_type], [6.5, 450, 800, 'BCF'])
  assert.deepEqual(sofa.finish_specs, [{ heading: 'Fabric', value: 'Velvet Royal Blue' }, { heading: 'Wood Finish', value: 'Walnut' }])
  assert.deepEqual(p.items[1].finish_specs, [])
  assert.equal(r.pictures.length, 2)
})

test('what is typed wins over the workbook', () => {
  const r = bdpiFromWorkbook(workbook(), { oldOrderNo: 'OLD-77', clientName: 'Someone Else' })
  assert.ok(r.ok && r.payload.old_order_no === 'OLD-77' && r.payload.client_name === 'Someone Else')
})

test('no old order number anywhere is refused with a plain sentence', () => {
  const r = bdpiFromWorkbook(workbook({ b20: null }), {})
  assert.equal(r.ok, false)
  assert.ok(!r.ok && /old order number/.test(r.reason))
})

test('a missing picture or item sequence is tolerated; a missing price is not', () => {
  const tolerant = bdpiFromWorkbook(workbook({
    products: [product({ itemSequence: null, representativeImage: null })],
    blocking: [{ code: 'PRODUCT_IMAGE_REQUIRED', row: 32 }, { code: 'PRODUCT_ITEM_SEQUENCE_MISSING', row: 32 }],
  }), {})
  assert.ok(tolerant.ok)
  if (tolerant.ok) {
    assert.equal(tolerant.payload.items[0].item_sequence, 'R32')
    assert.equal(tolerant.pictures.length, 0)
    assert.ok(tolerant.notes.some(n => /no picture/.test(n)))
  }
  const strict = bdpiFromWorkbook(workbook({ blocking: [{ code: 'PRODUCT_COST_INVALID', row: 33 }] }), {})
  assert.equal(strict.ok, false)
  assert.ok(!strict.ok && /PRODUCT_COST_INVALID/.test(strict.reason))
})

test('an unstorable picture is left out and said so; duplicate sequences stay unique', () => {
  const r = bdpiFromWorkbook(workbook({
    products: [product({ representativeImage: img('gif', 32) }), product({ row: 33, itemSequence: 'B012' })],
  }), {})
  assert.ok(r.ok)
  if (r.ok) {
    assert.deepEqual(r.payload.items.map(i => i.item_sequence), ['B012', 'B012-R33'])
    assert.equal(r.pictures.length, 1)
    assert.ok(r.notes.some(n => /cannot be stored/.test(n)))
  }
})

test('pictures are stored under the BDPI, with a safe name', () => {
  assert.equal(bdpiPicturePath('abc', 'B 01/2', { format: 'jpeg' }), 'bdpi/abc/items/B_01_2.jpg')
})

test('the database refusals read as plain sentences', () => {
  assert.match(describeBdpiError('BDPI_OLD_ORDER_EXISTS: 412'), /already exists/)
  assert.match(describeBdpiError('PAYMENT_PLAN_FORBIDDEN'), /access/)
})

test('a BDPI read is understood by the same plan code, with its line details', () => {
  const data = parsePlanData({
    found: true, has_pi: true, kind: 'bdpi',
    order: { id: 'b1', display_number: 'BDPI-0001', client_name: 'Rivoli', old_order_no: '412', fabric_responsibility: 'client' },
    pi: { total_before_gst: 92000, gst_amount: 16560, grand_total: 108560, billing_percentage: null },
    items: [{ item_sequence: 'B012', product_name: 'Sofa', quantity: 4, rate: 16500, dimensions: '80 x 36 in',
      finish_specs: [{ heading: 'Fabric', value: 'Velvet' }], fabric_metres_per_piece: 6.5, fabric_price_per_metre: 450 }],
    plan: null, lots: [], finance: {},
  })
  assert.ok(data)
  assert.equal(data.kind, 'bdpi')
  assert.equal(data.oldOrderNo, '412')
  assert.equal(data.displayNumber, 'BDPI-0001')
  assert.deepEqual(data.items[0].details, ['Size: 80 x 36 in', 'Fabric: Velvet', 'Fabric: 6.5 m per piece at ₹450/m'])
  assert.deepEqual(itemDetails({}), [])
})

test('the sidebar lights Old orders for the list and each record', () => {
  assert.equal(activeOrdersNav('/orders/bdpi'), 'bdpi')
  assert.equal(activeOrdersNav('/orders/bdpi/123'), 'bdpi')
  assert.equal(activeOrdersNav('/orders/all'), 'confirmed')
})

test('the migration keeps the tables closed and every door gated', () => {
  const sql = read('supabase/migrations/20270502000000_order_payment_plan_bdpi.sql')
  for (const t of ['bdpi_records', 'bdpi_items', 'bdpi_payment_plans']) {
    assert.match(sql, new RegExp(`revoke all on public\\.${t} from anon, authenticated`))
  }
  for (const fn of ['create_bdpi', 'bdpi_attach_files', 'bdpi_list', 'bdpi_payment_plan_read', 'bdpi_payment_plan_save', 'bdpi_dispatch_lot_save', 'bdpi_dispatch_lot_mark_dispatched']) {
    const start = sql.indexOf(`create or replace function public.${fn}(`)
    assert.ok(start >= 0, fn)
    assert.match(sql.slice(start, sql.indexOf('\n$$;', start)), /perform public\.bdpi_payment_plan_assert\(/, `${fn} asks the gate`)
  }
  assert.match(sql, /legacy_order_no = v\.old_order_no/)
  assert.doesNotMatch(sql, /create policy/i)
})

test('the routes ask the database as the person before the service role touches a file', () => {
  const upload = read('src/app/api/orders/bdpi/import/route.ts')
  assert.ok(upload.indexOf("rpc('create_bdpi'") < upload.indexOf('adminClient()'))
  const pics = read('src/app/api/orders/bdpi/[id]/pictures/route.ts')
  assert.ok(pics.indexOf("rpc('bdpi_payment_plan_read'") < pics.indexOf('adminClient()'))
  const del = read('src/app/api/orders/bdpi/[id]/delete/route.ts')
  assert.ok(del.indexOf("rpc('delete_bdpi'") < del.indexOf('adminClient()'))
})
