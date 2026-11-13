// A saved quotation written as a BOE PI workbook (the "Master" sheet of the PI template), so it can go through
// the same Upload PI path as every other PI (src/app/api/orders/import/process-draft) and can be downloaded.
// The PI reader (src/lib/pi/layout.ts, masterSheetParser.ts) finds each block by its own labels and proves the
// footer by its arithmetic, so this writes the template's labels at the template's places: header block rows
// 20-28, column names on row 31, products from row 32, footer rows 115-122 (moved down when there are more than
// 80 products). The round trip is pinned by piWorkbook.test.ts against the real reader.

import type { Workbook } from 'exceljs'
import { lineQty, sizeWithUnit, type DimensionUnit, type QuoteArea, type QuoteLine, type QuoteMoney } from './math'

export const PI_FIRST_PRODUCT_ROW = 32
const TEMPLATE_SLOTS = 80
const TEMPLATE_FOOTER_FIRST_ROW = 115

export type PiWorkbookInput = {
  quoteNo: string
  clientName: string
  projectName: string | null
  contactPhone: string | null
  supplyState: string | null
  createdByName: string | null
  transportNote: string | null
  money: QuoteMoney
  /** The quotation's dimensions unit. Centimetres are written after bare sizes so the PI does not read them as inches; inches stay as typed. */
  dimensionUnit?: DimensionUnit
  areas: readonly QuoteArea[]
  lines: readonly QuoteLine[]
  /** The picture for each line's image_path, as JPEG bytes. */
  pictures: ReadonlyMap<string, Uint8Array>
  today?: Date
}

export type PiLine = {
  sequence: string
  name: string
  quantity: number
  dimensions: string
  material: string
  customization: string
  costPerPiece: number
  total: number
  imagePath: string | null
}

export type PiFigures = {
  lines: PiLine[]
  gross: number
  discount: number
  subtotal: number
  fabric: number
  packing: number
  total: number
  /** The single GST rate when every line shares one; null when rates are mixed. */
  gstRate: number | null
  gst: number
  grandTotal: number
}

export type ConversionProblem = { code: 'NO_LINES' | 'NAME_MISSING' | 'QTY_MISSING' | 'PRICE_MISSING' | 'PICTURE_MISSING'; lines: string[] }

const r2 = (n: number) => Math.round(n * 100) / 100

// base64 works for ExcelJS in the browser and in Node alike (a Node Buffer does not exist in the browser).
function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
const lineLabel = (line: QuoteLine, i: number) => line.name.trim() || `Product ${i + 1}`

/** The lines that go on the PI: optional lines are offers, not orders. */
export const piLines = (lines: readonly QuoteLine[]) => lines.filter(l => !l.is_optional)

/** What stops a quotation becoming a PI: the PI reader refuses a product without a name, quantity, price or picture. */
export function conversionProblems(areas: readonly QuoteArea[], lines: readonly QuoteLine[]): ConversionProblem[] {
  const ordered = piLines(lines)
  if (ordered.length === 0) return [{ code: 'NO_LINES', lines: [] }]
  const pick = (test: (l: QuoteLine) => boolean) => ordered.flatMap((l, i) => (test(l) ? [lineLabel(l, i)] : []))
  const problems: ConversionProblem[] = [
    { code: 'NAME_MISSING', lines: pick(l => !l.name.trim()) },
    { code: 'QTY_MISSING', lines: pick(l => lineQty(l, areas) <= 0) },
    { code: 'PRICE_MISSING', lines: pick(l => !(Number(l.unit_price) > 0)) },
    { code: 'PICTURE_MISSING', lines: pick(l => !l.image_path) },
  ]
  return problems.filter(p => p.lines.length > 0)
}

export function piFigures(input: Pick<PiWorkbookInput, 'money' | 'areas' | 'lines' | 'dimensionUnit'>): PiFigures {
  const ordered = piLines(input.lines)
  const lines: PiLine[] = ordered.map((l, i) => {
    const area = input.areas.find(a => a.key === l.area_key)
    const quantity = lineQty(l, input.areas)
    const costPerPiece = Number(l.unit_price) || 0
    return {
      sequence: `B${String(i + 1).padStart(3, '0')}`,
      name: area ? `${area.name} · ${l.name.trim()}` : l.name.trim(),
      quantity,
      dimensions: input.dimensionUnit === 'cm' ? sizeWithUnit(l.size_text, 'cm') : l.size_text.trim(),
      material: l.material.trim(),
      customization: [l.finish && `Finish: ${l.finish.trim()}`, l.spec.trim(), l.client_note.trim()].filter(Boolean).join(' · '),
      costPerPiece,
      total: r2(quantity * costPerPiece),
      imagePath: l.image_path,
    }
  })
  const gross = r2(lines.reduce((s, l) => s + l.total, 0))
  const pct = Math.min(100, Math.max(0, Number(input.money.discount_pct) || 0))
  const discount = Math.round((gross * pct) / 100)
  const subtotal = r2(gross - discount)
  const fabric = Math.max(0, Number(input.money.fabric_amount) || 0)
  const packing = Math.max(0, Number(input.money.packing_amount) || 0)
  const total = r2(subtotal + fabric + packing)
  // Fabric and packing are taxed at 18% (as on the quotation), so the rate is single only when every line is 18%
  // or there are no extras.
  const rates = new Set(ordered.map(l => Number(l.tax_rate)))
  if (fabric + packing > 0) rates.add(18)
  const gstRate = rates.size === 1 ? [...rates][0] : null
  let gst: number
  if (gstRate !== null) {
    gst = r2((total * gstRate) / 100)
  } else {
    // Mixed rates: each rate on its share of the discounted products, extras at 18%.
    const byRate = new Map<number, number>()
    ordered.forEach((l, i) => byRate.set(Number(l.tax_rate), (byRate.get(Number(l.tax_rate)) ?? 0) + lines[i].total))
    gst = r2([...byRate.entries()].reduce((s, [rate, sum]) => s + (sum * (1 - pct / 100) * rate) / 100, 0) + ((fabric + packing) * 18) / 100)
  }
  return { lines, gross, discount, subtotal, fabric, packing, total, gstRate, gst, grandTotal: r2(total + gst) }
}

/** The quotation as a PI workbook (.xlsx bytes). Every product must already have its picture in `pictures`. */
export async function buildPiWorkbook(input: PiWorkbookInput): Promise<Uint8Array> {
  // Loaded on demand, so the builder screen does not carry ExcelJS or the PI parser until someone uses them.
  const [mod, { TEMPLATE_HEADERS }] = await Promise.all([import('exceljs'), import('@/lib/pi/masterSheetParser')])
  const ExcelJS = ((mod as unknown as { default?: typeof mod }).default ?? mod) as typeof mod
  const wb: Workbook = new ExcelJS.Workbook()
  wb.creator = 'BOE One Quotations'
  const ws = wb.addWorksheet('Master')
  const f = piFigures(input)
  const shift = Math.max(0, f.lines.length - TEMPLATE_SLOTS)
  const set = (address: string, value: string | number | Date | null) => {
    if (value !== null && value !== '') ws.getCell(address).value = value
  }

  ws.columns = [12, 34, 10, 22, 16, 4, 20, 14, 16, 8, 40].map(width => ({ width }))
  ws.getColumn(10).hidden = true

  // Header block (labels beside their values, as the template).
  set('A18', `PI from quotation ${input.quoteNo}`)
  set('A20', 'Order no:-')
  set('F20', 'Date of Creation:'); set('G20', input.today ?? new Date())
  set('F21', 'Created By:'); set('G21', input.createdByName)
  set('A22', 'GST:')
  set('F22', 'Contact no:')
  set('A24', 'BILL TO:'); set('F24', 'SHIP TO:')
  set('A25', 'Name:'); set('B25', input.clientName.trim())
  set('F25', 'Name:'); set('G25', (input.projectName ?? '').trim() || input.clientName.trim())
  set('A26', 'Phone:'); set('B26', input.contactPhone); set('F26', 'Phone:'); set('G26', input.contactPhone)
  set('A27', 'GST:'); set('F27', 'GST:')
  set('A28', 'Billing Address:'); set('B28', input.supplyState)
  set('F28', 'Shipping Address:')
  set('G28', [input.projectName?.trim(), input.supplyState].filter(Boolean).join(', ') || null)

  for (const { cell, expected } of TEMPLATE_HEADERS) set(cell, expected)

  f.lines.forEach((l, i) => {
    const row = PI_FIRST_PRODUCT_ROW + i
    set(`A${row}`, l.sequence)
    set(`B${row}`, l.name)
    set(`C${row}`, l.quantity)
    set(`D${row}`, l.dimensions)
    set(`G${row}`, l.material)
    set(`H${row}`, l.costPerPiece)
    ws.getCell(`I${row}`).value = { formula: `C${row}*H${row}`, result: l.total }
    set(`J${row}`, l.sequence)
    set(`K${row}`, l.customization)
    ws.getRow(row).height = 60
    const bytes = l.imagePath ? input.pictures.get(l.imagePath) : undefined
    if (bytes) {
      const id = wb.addImage({ base64: toBase64(bytes), extension: 'jpeg' })
      ws.addImage(id, { tl: { col: 4.1, row: row - 1 + 0.1 }, ext: { width: 72, height: 72 } })
    }
  })

  // Footer: labels in G, amounts in I (I115 is always the discount).
  const row = (n: number) => n + shift
  const last = PI_FIRST_PRODUCT_ROW + Math.max(f.lines.length, TEMPLATE_SLOTS) - 1
  set(`G${row(TEMPLATE_FOOTER_FIRST_ROW)}`, 'Discount'); set(`I${row(115)}`, f.discount)
  set(`G${row(116)}`, 'Sub Total')
  ws.getCell(`I${row(116)}`).value = { formula: `SUM(I${PI_FIRST_PRODUCT_ROW}:I${last})-I${row(115)}`, result: f.subtotal }
  set(`G${row(117)}`, '(A) Total Fabric Cost (As per Actual)'); set(`I${row(117)}`, f.fabric)
  set(`G${row(118)}`, '(B) Total Packing Cost (As per Actual)'); set(`I${row(118)}`, f.packing)
  set(`G${row(119)}`, '(C) Transportation(As per Actual)'); set(`I${row(119)}`, input.transportNote?.trim() || 'As per actual')
  set(`G${row(120)}`, 'Total')
  ws.getCell(`I${row(120)}`).value = { formula: `I${row(116)}+I${row(117)}+I${row(118)}`, result: f.total }
  set(`G${row(121)}`, f.gstRate !== null ? `GST @ ${f.gstRate}%` : 'GST')
  ws.getCell(`I${row(121)}`).value = f.gstRate !== null
    ? { formula: `I${row(120)}*${f.gstRate / 100}`, result: f.gst }
    : f.gst
  set(`G${row(122)}`, 'Grand Total')
  ws.getCell(`I${row(122)}`).value = { formula: `I${row(120)}+I${row(121)}`, result: f.grandTotal }

  const out = await wb.xlsx.writeBuffer()
  return new Uint8Array(out as ArrayBuffer)
}
