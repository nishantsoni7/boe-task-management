/**
 * The Excel of a quotation for the client ("Download Excel" in the Share card; styled, with pictures, editable: owner, 18 Nov 2026).
 * Reads the generated file back with ExcelJS, so it checks the file itself.
 * Run: npm run test:file -- src/lib/quotations/clientWorkbook.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import ExcelJS from 'exceljs'
import { COLUMNS, PRICE_TERM, buildClientWorkbook, clientSheetFileName, fitPicture, wrappedLines, type SheetPicture, type WorkbookHead, type WorkbookInput } from './clientWorkbook'
import { computeTotals, type QuoteArea, type QuoteLine, type QuoteMoney } from './math'
import { DEFAULT_CLIENT_NOTE, EXPECTATIONS, EXPECTATIONS_TITLE, TERMS } from './terms'

const area = (over: Partial<QuoteArea> = {}): QuoteArea => ({ key: 'a', name: 'Boho room', style: 'Boho', multiplier: 56, unit_label: 'rooms', ...over })
const line = (over: Partial<QuoteLine> = {}): QuoteLine => ({
  key: 'l1', area_key: 'a', name: 'Bed', size_text: '83 × 68 × 18', spec: 'Walnut headboard', material: 'Ash wood', finish: 'NEVER-IN-THE-SHEET', category: '',
  qty_mode: 'per_unit', qty: 1, unit_price: 56000, tax_rate: 18, image_path: null, is_optional: false, client_note: 'Delivered assembled',
  internal_note: 'NEVER-IN-THE-SHEET-INTERNAL', ...over,
})
const money = (over: Partial<QuoteMoney> = {}): QuoteMoney => ({ gst_mode: 'igst', discount_pct: 0, fabric_amount: 0, packing_amount: 0, ...over })
const head = (over: Partial<WorkbookHead> = {}): WorkbookHead => ({
  quoteNo: 'QT-NS-01006', clientName: 'Babylon Resort', projectName: 'Resort, Shamshabad', issuedOn: '12 Nov 2026', validUntilOn: '19 Nov 2026', unit: 'in',
  transportNote: '', notes: 'Prices are ex-factory.',
  preparedBy: { name: 'Nishant Soni', title: 'Director', phone: '+91 98765 43210', email: 'sales@example.com' }, ...over,
})

let picture: SheetPicture
const pic = async (): Promise<SheetPicture> => {
  if (picture) return picture
  const bytes = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 120, g: 90, b: 60 } } }).jpeg().toBuffer()
  return (picture = { bytes: new Uint8Array(bytes), width: 300, height: 200 })
}

async function make(over: Partial<WorkbookInput> = {}) {
  const input: WorkbookInput = { head: head(), money: money(), areas: [area()], lines: [line()], pictures: new Map(), ...over }
  const bytes = await buildClientWorkbook(input)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(bytes as unknown as ArrayBuffer)
  return { ws: wb.getWorksheet('Quotation')!, input }
}
const text = (v: ExcelJS.CellValue): string => (v && typeof v === 'object' && 'formula' in v ? '' : v === null || v === undefined ? '' : String(v))
const num = (v: ExcelJS.CellValue): number | undefined => (v && typeof v === 'object' && 'formula' in v ? ((v.result as number | undefined) ?? 0) : typeof v === 'number' ? v : undefined)
const HEADER_ROW = 8
/** The product rows: those with a number in column A. */
const products = (ws: ExcelJS.Worksheet) => { const out: ExcelJS.Row[] = []; ws.eachRow((row, r) => { if (r > HEADER_ROW && typeof row.getCell(1).value === 'number') out.push(row) }); return out }
/** The totals: label in column D (merged to F), value in column H. */
const totalOf = (ws: ExcelJS.Worksheet, label: string): ExcelJS.CellValue | undefined => {
  let found: ExcelJS.CellValue | undefined
  ws.eachRow(row => { if (text(row.getCell(4).value) === label) found = row.getCell(8).value })
  return found
}
const everything = (ws: ExcelJS.Worksheet) => { const all: string[] = []; ws.eachRow(row => row.eachCell(c => all.push(JSON.stringify(c.value)))); return all.join(' ') }

describe('the client Excel: what is in it', () => {
  test('the title band, the details, and the table headings with the size unit', async () => {
    const { ws } = await make()
    assert.equal(text(ws.getCell(1, 3).value), 'QUOTATION')
    const details = JSON.stringify([3, 4, 5, 6].map(r => [text(ws.getCell(r, 1).value), text(ws.getCell(r, 3).value), text(ws.getCell(r, 5).value), text(ws.getCell(r, 6).value)]))
    for (const s of ['Quotation no.', 'QT-NS-01006', 'Prepared for', 'Babylon Resort', 'Resort, Shamshabad', '12 Nov 2026', 'Valid until', '19 Nov 2026', 'Nishant Soni, Director', '+91 98765 43210  ·  sales@example.com']) assert.ok(details.includes(s), s)
    assert.deepEqual(COLUMNS.map((_, i) => text(ws.getCell(HEADER_ROW, i + 1).value)), COLUMNS.map((c, i) => (i === 3 ? 'Size (in)' : c)))
    assert.equal(text((await make({ head: head({ unit: 'cm' }) })).ws.getCell(HEADER_ROW, 4).value), 'Size (cm)')
  })
  test('nothing is frozen, there are no gridlines, and the page is landscape A4 fitted to one page wide', async () => {
    const { ws } = await make()
    const v = ws.views[0] as { state?: string; ySplit?: number; xSplit?: number; showGridLines?: boolean }
    assert.ok(v.state !== 'frozen' && !v.ySplit && !v.xSplit, 'no frozen pane')
    assert.equal(v.showGridLines, false)
    assert.equal(ws.pageSetup.orientation, 'landscape')
    assert.equal(ws.pageSetup.fitToWidth, 1)
  })
  test('a product row reads like the printed quotation, and the amount is a live formula carrying the app’s value', async () => {
    const { ws } = await make()
    const [row] = products(ws)
    assert.deepEqual([1, 3, 4, 5, 6, 7, 9, 10].map(c => row.getCell(c).value),
      [1, 'Bed', '83 × 68 × 18', 'Ash wood', 56, 56000, 'Yes', 'Walnut headboard · Delivered assembled'])
    const amount = row.getCell(8).value as { formula: string; result: number }
    assert.equal(amount.formula, `ROUND(F${row.number}*G${row.number},0)`)
    assert.equal(amount.result, 56 * 56000)
  })
  test('never the Finish, the internal note, a picture path, or the client’s phone or e-mail', async () => {
    const { ws } = await make({ lines: [line({ image_path: 'u/secret-path.jpg' })] })
    const all = everything(ws)
    // the line's Finish value and internal note are both marked NEVER-IN-THE-SHEET (the word Finish itself is in the standard terms)
    for (const secret of ['NEVER-IN-THE-SHEET', 'secret-path']) assert.ok(!all.includes(secret), secret)
    assert.ok(!Object.keys(head()).some(k => /^contact|internal/i.test(k)), 'the sheet is not given a client contact or an internal note')
  })
  test('products with no room type come last; optional ones are named so, shown as "No" in "Counted in total" and left out of the subtotal', async () => {
    const lines = [line({ key: 'x', area_key: null, name: 'Loose chair', unit_price: 1000, qty_mode: 'fixed', qty: 3 }), line({ key: 'o', name: 'Mirror', is_optional: true, unit_price: 5000, qty_mode: 'fixed', qty: 1 }), line()]
    const { ws } = await make({ lines })
    const rows = products(ws)
    assert.deepEqual(rows.map(r => text(r.getCell(3).value).split('\n')[0]), ['Mirror', 'Bed', 'Loose chair'])
    assert.equal(text(rows[0].getCell(3).value), 'Mirror\n(optional, not in the total)')
    assert.deepEqual(rows.map(r => r.getCell(9).value), ['No', 'Yes', 'Yes'])
    assert.equal(num(totalOf(ws, 'Subtotal')), 56 * 56000 + 3000)
  })
  test('room types are heading rows across the table', async () => {
    const { ws } = await make({ areas: [area(), area({ key: 'b', name: 'Lobby', style: '', multiplier: 1 })], lines: [line(), line({ key: 'l2', area_key: 'b', name: 'Sofa' })] })
    const heads: string[] = []
    ws.eachRow((row, r) => { if (r > HEADER_ROW && typeof row.getCell(1).value === 'string') heads.push(row.getCell(1).value as string) })
    assert.deepEqual(heads.filter(h => /room|Lobby/.test(h)), ['Boho room · Boho × 56 rooms', 'Lobby'])
  })
})

describe('the client Excel: the layout corrections of 18 Nov 2026', () => {
  test('GST is not on the product rows: no GST column is visible, the rate is a hidden helper, and GST appears only as lines in the totals', async () => {
    const lines = [line(), line({ key: 'm', name: 'Mirror', qty_mode: 'fixed', qty: 2, unit_price: 5000, tax_rate: 12 })]
    const { ws } = await make({ lines })
    const visibleHeaders = COLUMNS.map((_, i) => text(ws.getCell(HEADER_ROW, i + 1).value))
    assert.ok(!visibleHeaders.some(h => /GST/.test(h)), 'no GST heading among the visible columns')
    assert.equal(ws.getColumn(11).hidden, true, 'the helper column is hidden')
    for (const row of products(ws)) for (let c = 1; c <= 10; c++) assert.ok(![12, 18].includes(row.getCell(c).value as number), `row ${row.number} column ${c} shows no GST rate`)
    assert.deepEqual(products(ws).map(r => r.getCell(11).value), [18, 12], 'each line keeps its rate in the hidden helper')
    assert.ok(totalOf(ws, 'GST @18%') !== undefined && totalOf(ws, 'GST @12%') !== undefined, 'GST lines are at the bottom')
  })
  test('a quantity is a plain number: 56 reads 56, never "56."', async () => {
    const { ws } = await make({ lines: [line({ qty_mode: 'fixed', qty: 56 }), line({ key: 'b', qty_mode: 'fixed', qty: 2.5 })] })
    const rows = products(ws)
    assert.deepEqual(rows.map(r => r.getCell(6).value), [56, 2.5])
    // General is Excel's default (read back as unset): no format with a decimal point to leave a dot after 56
    assert.ok(rows.every(r => !r.getCell(6).numFmt || r.getCell(6).numFmt === 'General'))
  })
  test('Remarks is the last column, in its own colour', async () => {
    const { ws } = await make()
    assert.equal(text(ws.getCell(HEADER_ROW, 10).value), 'Remarks')
    const fill = (c: ExcelJS.Cell) => (c.fill as ExcelJS.FillPattern).fgColor?.argb
    assert.notEqual(fill(ws.getCell(HEADER_ROW, 10)), fill(ws.getCell(HEADER_ROW, 9)), 'the Remarks heading is another colour')
    const [row] = products(ws)
    assert.notEqual(fill(row.getCell(10)), fill(row.getCell(9)), 'and so are its cells')
  })
  test('Name, Material and Remarks are narrower than before (30, 22, 32)', async () => {
    const { ws } = await make()
    assert.ok(ws.getColumn(3).width! < 30 && ws.getColumn(5).width! < 22 && ws.getColumn(10).width! < 32)
  })
  test('a row is as tall as its words need', () => {
    assert.equal(wrappedLines('short', 22), 1)
    assert.equal(wrappedLines('a'.repeat(50), 22), 3)
    assert.equal(wrappedLines('one\ntwo', 22), 2)
  })
})

describe('the client Excel: pictures', () => {
  test('one picture per product that has one, plus the logo; a product with no picture, or whose picture was not loaded, has none', async () => {
    const p = await pic()
    const lines = [line({ image_path: 'p1' }), line({ key: 'l2', name: 'Table', image_path: 'p2' }), line({ key: 'l3', name: 'Chair', image_path: 'missing' }), line({ key: 'l4', name: 'Pouf' })]
    const { ws } = await make({ lines, pictures: new Map([['p1', p], ['p2', p]]), logo: p })
    assert.equal(ws.getImages().length, 3, 'two products + the logo')
    const rows = products(ws)
    assert.deepEqual(rows.map(r => r.height), [88, 88, 36, 36], 'a taller row where there is a picture')
  })
  test('a picture fits its box, keeps its shape and is never enlarged', () => {
    assert.deepEqual(fitPicture(300, 200), { width: 112, height: 75 })
    assert.deepEqual(fitPicture(200, 600), { width: 36, height: 108 })
    assert.deepEqual(fitPicture(50, 40), { width: 50, height: 40 })
    assert.deepEqual(fitPicture(0, 0), { width: 112, height: 108 })
  })
})

describe('the client Excel: the totals are the builder\'s totals, and live', () => {
  const areas = [area()]
  const lines = [line(), line({ key: 'm', name: 'Mirror', qty_mode: 'fixed', qty: 2, unit_price: 5000, tax_rate: 12 })]
  test('every total carries computeTotals’ value: subtotal, discount, fabric and packing, taxable value, GST and the grand total', async () => {
    const m = money({ discount_pct: 5, fabric_amount: 120000, packing_amount: 30000 })
    const t = computeTotals(m, areas, lines)
    const { ws } = await make({ money: m, areas, lines })
    assert.equal(num(totalOf(ws, 'Subtotal')), t.subtotal)
    assert.equal(num(totalOf(ws, 'Less: Discount')), t.discount)
    assert.equal(num(totalOf(ws, 'Fabric')), 120000)
    assert.equal(num(totalOf(ws, 'Packing')), 30000)
    assert.equal(num(totalOf(ws, 'Taxable value')), t.taxable)
    assert.equal(num(totalOf(ws, 'Total including GST')), t.grand)
    const gst = t.gst.reduce((s, g) => s + (num(totalOf(ws, `GST @${g.rate}%`)) ?? 0), 0)
    assert.equal(gst, t.gstTotal)
    assert.equal(products(ws).reduce((s, r) => s + (num(r.getCell(8).value) ?? 0), 0), t.subtotal, 'the product amounts add up to the subtotal')
  })
  test('the totals are formulas, so a client who edits a quantity, a rate or the discount sees them follow', async () => {
    const { ws } = await make({ money: money({ discount_pct: 5, fabric_amount: 120000 }), areas, lines })
    for (const label of ['Subtotal', 'Less: Discount', 'Taxable value', 'GST @18%', 'GST @12%', 'Total including GST']) {
      const v = totalOf(ws, label) as { formula?: string } | undefined
      assert.ok(v && typeof v.formula === 'string', `${label} is a formula`)
    }
    assert.match((totalOf(ws, 'Subtotal') as { formula: string }).formula, /^SUMIFS\(\$H\$\d+:\$H\$\d+,\$I\$\d+:\$I\$\d+,"Yes"\)$/)
    assert.match((totalOf(ws, 'GST @18%') as { formula: string }).formula, /SUMIFS\(.+,\$K\$\d+:\$K\$\d+,18,/)
    let pctRow: ExcelJS.Row | undefined
    ws.eachRow(row => { if (text(row.getCell(4).value) === 'Less: Discount') pctRow = row })
    assert.equal(pctRow!.getCell(7).value, 5, 'the discount % is a cell to change')
  })
  test('"Counted in total" is a Yes/No list', async () => {
    const { ws } = await make({ lines })
    for (const row of products(ws)) {
      const dv = row.getCell(9).dataValidation
      assert.ok(dv && dv.type === 'list' && dv.formulae?.[0] === '"Yes,No"', `row ${row.number}`)
    }
  })
  test('GST is one line per rate, "GST @18%", whatever the delivery state: never split into CGST, SGST or IGST (owner, 18 Nov 2026)', async () => {
    for (const mode of ['cgst_sgst', 'igst'] as const) {
      const { ws } = await make({ money: money({ gst_mode: mode }), areas, lines })
      assert.ok(totalOf(ws, 'GST @18%') !== undefined && totalOf(ws, 'GST @12%') !== undefined, mode)
      assert.ok(!/CGST|SGST|IGST/.test(everything(ws)), `${mode}: no split`)
    }
  })
  test('no discount, fabric or packing row when there is none; transport and the client notes follow, internal notes never', async () => {
    const plain = (await make({ areas, lines })).ws
    for (const l of ['Less: Discount', 'Fabric', 'Packing']) assert.equal(totalOf(plain, l), undefined, l)
    const withNotes = (await make({ areas, lines, head: head({ transportNote: 'As per actual' }) })).ws
    const all = everything(withNotes)
    assert.ok(all.includes('As per actual') && all.includes('Prices are ex-factory.'))
  })
  test('the standard terms are at the bottom: the owner’s sentence first, then every term and every expectation, word for word', async () => {
    const { ws } = await make({ head: head({ notes: DEFAULT_CLIENT_NOTE }) })
    const all = everything(ws)
    assert.ok(all.includes(PRICE_TERM), 'Given prices are ex-factory. GST and Packing will be extra as applicable.')
    for (const t of TERMS) assert.ok(all.includes(JSON.stringify(t.title).slice(1, -1)) && all.includes(JSON.stringify(t.text).slice(1, -1)), t.title)
    for (const t of EXPECTATIONS) assert.ok(all.includes(JSON.stringify(t.title).slice(1, -1)), t.title)
    assert.ok(all.includes('Terms and conditions') && all.includes(JSON.stringify(EXPECTATIONS_TITLE).slice(1, -1)))
    assert.ok(all.indexOf('Terms and conditions') > all.indexOf('Total including GST'), 'below the totals')
    assert.equal(all.split(DEFAULT_CLIENT_NOTE).length - 1, 0, 'the standard note is not printed a second time as a Notes row')
  })
})

describe('the client Excel: the generated file against the app, across setups', () => {
  // The totals cells carry the value the app computed; this pins that for several shapes of quotation (the formulas themselves were
  // recalculated by a formula engine when this was built: 0 differences over 6 setups, see the changelog).
  const setups: [string, QuoteMoney, QuoteLine[]][] = [
    ['igst, no extras', money(), [line({ qty: 2.5, unit_price: 12345 }), line({ key: '2', tax_rate: 5, unit_price: 777 }), line({ key: '3', tax_rate: 0, unit_price: 5000, qty_mode: 'fixed', qty: 3 })]],
    ['igst with a discount', money({ discount_pct: 7.5 }), [line({ unit_price: 99999 }), line({ key: '2', tax_rate: 28, unit_price: 123457 })]],
    ['cgst/sgst, discount, fabric, packing', money({ gst_mode: 'cgst_sgst', discount_pct: 12.5, fabric_amount: 250000, packing_amount: 18000 }), [line({ unit_price: 1234567 }), line({ key: '2', tax_rate: 12, unit_price: 3331 })]],
  ]
  for (const [name, m, ls] of setups) {
    test(name, async () => {
      const t = computeTotals(m, [area()], ls)
      const { ws } = await make({ money: m, lines: ls })
      assert.equal(num(totalOf(ws, 'Subtotal')), t.subtotal)
      assert.equal(num(totalOf(ws, 'Taxable value')), t.taxable)
      assert.equal(num(totalOf(ws, 'Total including GST')), t.grand)
    })
  }
})

describe('the file name', () => {
  test('is the quotation number plus the word quotation, safe for any file system', () => {
    assert.equal(clientSheetFileName('QT-NS-01006'), 'QT-NS-01006 quotation.xlsx')
    assert.equal(clientSheetFileName('  QT/NS:01 006 '), 'QT-NS-01-006 quotation.xlsx')
    assert.equal(clientSheetFileName('///'), 'quotation quotation.xlsx')
  })
})

describe('the wiring', () => {
  test('the builder downloads through the browser helper with the pictures the client sees, and says when some were left out', () => {
    const b = readFileSync('src/components/quotations/BuilderScreen.tsx', 'utf8')
    assert.ok(b.includes("import('@/lib/quotations/clientWorkbookDownload')"))
    assert.ok(b.includes('srcOf: picSrc'))
    assert.ok(b.includes('could not be loaded and'))
    assert.ok(!b.includes('expenseReimbursementExport'), 'the old plain writer is no longer used for the quotation')
  })
})
