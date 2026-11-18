// The Excel of a quotation that the salesperson sends a client (owner, 18 Nov 2026: "make it more appealing with product images,
// so in case some client asks for Excel to edit the data, we should be able to do that"). Replaces the plain grid of 13 Nov.
//
// WHAT IT IS: one styled sheet that looks like the printed quotation (logo, details, a table with a picture beside each product,
// the totals) and still works as a spreadsheet. Amount, Subtotal, Discount, each GST line and the Total are LIVE FORMULAS, so a
// client can change a quantity, a rate, the discount, or set "Counted in total" to No, and everything below follows.
// Every formula cell also carries the value the app computed (computeTotals), so a viewer that does not calculate (a phone
// preview, a mail client) shows the same figures as the PDF, and the formulas repeat computeTotals' rounding step for step.
//
// LAYOUT (owner's corrections, same day): nothing is frozen; GST is shown only in the totals at the bottom, not on each product
// row; Qty is a plain number; Remarks is the last column, in its own colour; Name, Material and Remarks are narrow. The GST rate of
// each line still has to live somewhere for the GST formulas, so it sits in a HIDDEN helper column after Remarks.
//
// WHAT IT NEVER HAS: the Finish, the internal notes, a cost, the client's own phone or e-mail, a picture path. The salesperson's own
// name, role, phone and e-mail are on it, as on the PDF. Pictures are the ones the client sees (the logo mark on or off).

import type { Workbook } from 'exceljs'
import { computeTotals, type QuoteArea, type QuoteLine, type QuoteMoney } from './math'
import { DEFAULT_CLIENT_NOTE, EXPECTATIONS, EXPECTATIONS_TITLE, TERMS, type TermBlock } from './terms'

/** The first standard term, in the owner's words (18 Nov 2026). */
export const PRICE_TERM = 'Given prices are ex-factory. GST and Packing will be extra as applicable.'

export type WorkbookHead = {
  quoteNo: string
  clientName: string
  projectName: string
  issuedOn: string
  validUntilOn: string
  /** 'in' or 'cm': the heading of the size column. */
  unit: string
  transportNote: string
  /** The notes the client sees (never the internal notes). */
  notes: string
  /** The salesperson, as on the PDF. */
  preparedBy: { name: string; title: string; phone: string; email: string }
}

export type SheetPicture = { bytes: Uint8Array; width: number; height: number }
export type WorkbookInput = {
  head: WorkbookHead
  money: QuoteMoney
  areas: readonly QuoteArea[]
  lines: readonly QuoteLine[]
  /** By picture path. A path with no entry leaves that product's picture cell empty. */
  pictures: ReadonlyMap<string, SheetPicture>
  logo?: SheetPicture | null
}

export const BRAND = 'B9472E'
const SAND = 'F4EFE9'
const LINE = 'E4DED7'
const INK = '262B2B'
const MUTED = '6B706F'
/** Remarks: its own colour, so a client's eye finds it. */
const REMARKS_HEAD = '4A5658'
const REMARKS_BODY = 'EDF1F0'

/** The visible columns, left to right: A..J. Column K is the hidden GST helper. */
export const COLUMNS = ['No.', 'Picture', 'Product', 'Size', 'Material', 'Qty', 'Rate (₹)', 'Amount (₹)', 'Counted in total', 'Remarks'] as const
const WIDTHS = [5, 17.5, 22, 14, 16, 8, 13, 15, 11, 24, 8]
const COL = { no: 1, pic: 2, name: 3, size: 4, material: 5, qty: 6, rate: 7, amount: 8, counted: 9, remarks: 10, gst: 11 } as const
const LAST = COL.remarks

/** Indian grouping (12,34,567), rupees. */
export const RUPEES = '[>=10000000]"₹"##\\,##\\,##\\,##0;[>=100000]"₹"##\\,##\\,##0;"₹"##,##0'
const PCT = '0.##"%"'

const ROW_PICTURE = 88
const ROW_PLAIN = 36
const PIC_MAX_W = 112
const PIC_MAX_H = 108

// base64 works for ExcelJS in the browser and in Node alike (a Node Buffer does not exist in the browser).
function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
const imageType = (b: Uint8Array): 'png' | 'jpeg' => (b[0] === 0x89 && b[1] === 0x50 ? 'png' : 'jpeg')

/** The size a picture is drawn at: it fits the cell box, keeps its shape, and is never enlarged. */
export function fitPicture(w: number, h: number, maxW = PIC_MAX_W, maxH = PIC_MAX_H): { width: number; height: number } {
  if (!(w > 0 && h > 0)) return { width: maxW, height: maxH }
  const k = Math.min(1, maxW / w, maxH / h)
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) }
}

/** Lines of text a cell of this width (in characters) wraps to; used to give a row the height its words need. */
export function wrappedLines(text: string, widthChars: number): number {
  return text.split('\n').reduce((n, part) => n + Math.max(1, Math.ceil(part.length / Math.max(1, widthChars - 1))), 0)
}

const areaLabel = (a: QuoteArea) =>
  `${a.name}${a.style ? ` · ${a.style}` : ''}${a.multiplier > 1 ? ` × ${a.multiplier} ${a.unit_label}` : ''}`

const thin = { style: 'thin' as const, color: { argb: 'FF' + LINE } }
const box = { top: thin, left: thin, bottom: thin, right: thin }

/** The file name: the quotation number, which is a plain code (QT-NS-01006), kept safe for every file system. */
export function clientSheetFileName(quoteNo: string): string {
  const safe = quoteNo.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'quotation'
  return `${safe} quotation.xlsx`
}

/** The workbook, as bytes ready to save. */
export async function buildClientWorkbook(input: WorkbookInput): Promise<Uint8Array> {
  const mod = await import('exceljs')
  const ExcelJS = ((mod as unknown as { default?: typeof mod }).default ?? mod) as typeof mod
  const wb: Workbook = new ExcelJS.Workbook()
  wb.creator = 'Best of Exports'
  wb.title = `Quotation ${input.head.quoteNo}`
  wb.calcProperties.fullCalcOnLoad = true
  const ws = wb.addWorksheet('Quotation', {
    views: [{ showGridLines: false }], // nothing frozen (owner, 18 Nov 2026)
    properties: { defaultRowHeight: 20 },
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.2, footer: 0.3 } },
    headerFooter: { oddFooter: '&L&8Best of Exports&R&8Page &P of &N' },
  })
  WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w })
  ws.getColumn(COL.gst).hidden = true

  const { head, money, areas, lines } = input
  const t = computeTotals(money, areas, lines)

  // ── the title band and the details ─────────────────────────────────────────────────────────────────
  ws.getRow(1).height = 56
  if (input.logo) {
    const id = wb.addImage({ base64: toBase64(input.logo.bytes), extension: imageType(input.logo.bytes) })
    const f = fitPicture(input.logo.width, input.logo.height, 78, 52)
    ws.addImage(id, { tl: { col: 0.15, row: 0.06 }, ext: f })
  }
  ws.mergeCells(1, 3, 1, LAST)
  const title = ws.getCell(1, 3)
  title.value = 'QUOTATION'
  title.font = { name: 'Calibri', size: 26, bold: true, color: { argb: 'FF' + BRAND } }
  title.alignment = { horizontal: 'right', vertical: 'middle' }
  for (let c = 1; c <= LAST; c++) ws.getCell(1, c).border = { bottom: { style: 'medium', color: { argb: 'FF' + BRAND } } }

  const label = (r: number, c: number, text: string, to = c) => {
    if (to > c) ws.mergeCells(r, c, r, to)
    const cell = ws.getCell(r, c)
    cell.value = text
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF' + MUTED } }
    cell.alignment = { vertical: 'middle' }
  }
  const value = (r: number, c: number, text: string, to = c, bold = false) => {
    if (to > c) ws.mergeCells(r, c, r, to)
    const cell = ws.getCell(r, c)
    cell.value = text || '—'
    cell.font = { name: 'Calibri', size: 11, bold, color: { argb: 'FF' + INK } }
    cell.alignment = { vertical: 'middle', wrapText: true }
  }
  const p = head.preparedBy
  const contact = [p.phone, p.email].filter(Boolean).join('  ·  ')
  const left: [string, string, boolean][] = [['Quotation no.', head.quoteNo, true], ['Prepared for', head.clientName, true], ['Project', head.projectName, false], ['Date', head.issuedOn, false]]
  const right: [string, string, boolean][] = [['Valid until', head.validUntilOn, false], ['Prepared by', [p.name, p.title].filter(Boolean).join(', '), true], ['Contact', contact, false], ['Prices', 'In Indian rupees, GST as shown below', false]]
  left.forEach(([l, v, b], i) => { const r = 3 + i; ws.getRow(r).height = 20; label(r, 1, l, 2); value(r, 3, v, 4, b) })
  right.forEach(([l, v, b], i) => { const r = 3 + i; label(r, 5, l); value(r, 6, v, LAST, b) })

  // ── the table ────────────────────────────────────────────────────────────────────────────────────────
  const headRow = 8
  ws.getRow(headRow).height = 30
  COLUMNS.forEach((name, i) => {
    const c = ws.getCell(headRow, i + 1)
    c.value = i === COL.size - 1 ? `Size (${head.unit})` : name
    c.font = { name: 'Calibri', size: 10.5, bold: true, color: { argb: 'FFFFFFFF' } }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + (i === COL.remarks - 1 ? REMARKS_HEAD : BRAND) } }
    c.alignment = { horizontal: i >= COL.qty - 1 && i !== COL.remarks - 1 ? 'center' : 'left', vertical: 'middle', wrapText: true }
    c.border = box
  })
  ws.getCell(headRow, COL.gst).value = 'GST %' // hidden helper, for the GST formulas
  ws.pageSetup.printTitlesRow = `${headRow}:${headRow}`

  const known = new Set(areas.map(a => a.key))
  const groups: { label: string; lines: QuoteLine[] }[] = [
    ...areas.map(a => ({ label: areaLabel(a), lines: lines.filter(l => l.area_key === a.key) })),
    { label: '', lines: lines.filter(l => !l.area_key || !known.has(l.area_key)) },
  ].filter(g => g.lines.length > 0)

  let r = headRow
  let n = 0
  const firstRow = headRow + 1
  for (const g of groups) {
    if (g.label) {
      r++
      ws.mergeCells(r, 1, r, LAST)
      const gc = ws.getCell(r, 1)
      gc.value = g.label
      gc.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF' + INK } }
      gc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + SAND } }
      gc.alignment = { vertical: 'middle' }
      ws.getRow(r).height = 24
      for (let c = 1; c <= LAST; c++) ws.getCell(r, c).border = box
    }
    for (const l of g.lines) {
      r++
      n++
      const pic = l.image_path ? input.pictures.get(l.image_path) : undefined
      const opt = l.is_optional
      const nameText = opt ? `${l.name}\n(optional, not in the total)` : l.name
      const remarksText = [l.spec, l.client_note].filter(x => x.trim()).join(' · ')
      // the row is as tall as its tallest wrapped text needs (14 pt a line), and tall enough for the picture
      const words = Math.max(wrappedLines(nameText, WIDTHS[COL.name - 1]), wrappedLines(l.material, WIDTHS[COL.material - 1]), wrappedLines(l.size_text, WIDTHS[COL.size - 1]), wrappedLines(remarksText, WIDTHS[COL.remarks - 1]))
      ws.getRow(r).height = Math.max(pic ? ROW_PICTURE : ROW_PLAIN, 14 * words + 8)
      const font = (bold = false) => ({ name: 'Calibri', size: 10.5, bold, italic: opt, color: { argb: 'FF' + (opt ? MUTED : INK) } })
      const put = (c: number, v: string | number | { formula: string; result: number } | null, fmt?: string, align: 'left' | 'center' | 'right' = 'left', bold = false) => {
        const cell = ws.getCell(r, c)
        cell.value = v
        cell.font = font(bold)
        cell.alignment = { horizontal: align, vertical: 'middle', wrapText: true }
        cell.border = box
        if (fmt) cell.numFmt = fmt
      }
      put(COL.no, n, '0', 'center')
      put(COL.pic, null)
      put(COL.name, nameText, undefined, 'left', true)
      put(COL.size, l.size_text || null)
      put(COL.material, l.material || null)
      put(COL.qty, t.lineQty[l.key], 'General', 'center') // General: 56 reads 56, never "56."
      put(COL.rate, Number(l.unit_price) || 0, RUPEES, 'right')
      put(COL.amount, { formula: `ROUND(F${r}*G${r},0)`, result: t.lineTotal[l.key] }, RUPEES, 'right', true)
      put(COL.counted, opt ? 'No' : 'Yes', undefined, 'center')
      ws.getCell(r, COL.counted).dataValidation = { type: 'list', allowBlank: false, formulae: ['"Yes,No"'], showErrorMessage: true, errorTitle: 'Counted in total', error: 'Choose Yes or No.' }
      put(COL.remarks, remarksText || null)
      ws.getCell(r, COL.remarks).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + REMARKS_BODY } }
      ws.getCell(r, COL.gst).value = l.tax_rate // hidden helper
      if (pic) {
        const id = wb.addImage({ base64: toBase64(pic.bytes), extension: imageType(pic.bytes) })
        const f = fitPicture(pic.width, pic.height)
        // centred in the picture cell: column B is about 126 px wide, the row at least 117 px high
        ws.addImage(id, { tl: { col: 1 + Math.max(0, (126 - f.width) / 2 / 126), row: r - 1 + Math.max(0, (117 - f.height) / 2 / 117) }, ext: f })
      }
    }
  }
  const lastRow = r
  const rng = (col: string) => `$${col}$${firstRow}:$${col}$${lastRow}`

  // ── the totals: the only place GST appears ────────────────────────────────────────────────────────
  r += 2
  const total = (name: string, f: { formula: string; result: number } | number, opts: { bold?: boolean; pct?: number; strong?: boolean } = {}): number => {
    ws.mergeCells(r, COL.size, r, COL.qty)
    const lab = ws.getCell(r, COL.size)
    lab.value = name
    lab.font = { name: 'Calibri', size: opts.strong ? 12 : 10.5, bold: !!(opts.bold || opts.strong), color: { argb: 'FF' + INK } }
    lab.alignment = { horizontal: 'right', vertical: 'middle' }
    if (opts.pct !== undefined) {
      const pc = ws.getCell(r, COL.rate)
      pc.value = opts.pct
      pc.numFmt = PCT
      pc.font = { name: 'Calibri', size: 10.5, bold: true, color: { argb: 'FF' + BRAND } }
      pc.alignment = { horizontal: 'center', vertical: 'middle' }
      pc.border = box
    }
    const cell = ws.getCell(r, COL.amount)
    cell.value = f
    cell.numFmt = RUPEES
    cell.font = { name: 'Calibri', size: opts.strong ? 12.5 : 10.5, bold: !!(opts.bold || opts.strong), color: { argb: 'FF' + (opts.strong ? 'FFFFFF' : INK) } }
    cell.alignment = { horizontal: 'right', vertical: 'middle' }
    cell.border = box
    ws.getRow(r).height = opts.strong ? 28 : 21
    if (opts.strong) {
      for (let c = COL.size; c <= COL.amount; c++) ws.getCell(r, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + BRAND } }
      lab.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } }
    }
    return r
  }
  const A = 'H' // the amount column
  const subRow = total('Subtotal', { formula: `SUMIFS(${rng('H')},${rng('I')},"Yes")`, result: t.subtotal }, { bold: true })
  let pctRef = '0'
  let discRow = 0
  if (money.discount_pct > 0) {
    r++
    discRow = total('Less: Discount', { formula: `ROUND(${A}${subRow}*G${r}/100,0)`, result: t.discount }, { pct: Number(money.discount_pct) })
    pctRef = `$G$${discRow}`
  }
  const extraRows: number[] = []
  if (money.fabric_amount > 0) { r++; extraRows.push(total('Fabric', money.fabric_amount)) }
  if (money.packing_amount > 0) { r++; extraRows.push(total('Packing', money.packing_amount)) }
  const extrasRef = extraRows.map(x => `${A}${x}`).join('+')
  r++
  const taxableF = `${A}${subRow}${discRow ? `-${A}${discRow}` : ''}${extraRows.map(x => `+${A}${x}`).join('')}`
  const taxRow = total('Taxable value', { formula: taxableF, result: t.taxable }, { bold: true })

  const gstRows: number[] = []
  for (const g of t.gst) {
    const base = `ROUND(SUMIFS(${rng('H')},${rng('K')},${g.rate},${rng('I')},"Yes")*(1-${pctRef}/100),0)${g.rate === 18 && extraRows.length ? `+${extrasRef}` : ''}`
    r++; gstRows.push(total(`GST @${g.rate}%`, { formula: `ROUND((${base})*${g.rate}/100,0)`, result: g.gst }))
  }
  r++
  total('Total including GST', { formula: `${A}${taxRow}${gstRows.map(x => `+${A}${x}`).join('')}`, result: t.grand }, { strong: true })

  // ── transport and notes, then the way to use it ─────────────────────────────────────────────────────
  const note = (name: string, text: string) => {
    r += 2
    ws.mergeCells(r, 1, r, 2)
    label(r, 1, name)
    ws.mergeCells(r, 3, r, LAST)
    const c = ws.getCell(r, 3)
    c.value = text
    c.font = { name: 'Calibri', size: 10.5, color: { argb: 'FF' + INK } }
    c.alignment = { vertical: 'top', wrapText: true }
    ws.getRow(r).height = Math.max(20, 15 * Math.ceil(text.length / 100))
  }
  if (head.transportNote.trim()) note('Transport', head.transportNote.trim())
  // The standard note is already the first term below, so it is not printed twice.
  if (head.notes.trim() && head.notes.trim() !== DEFAULT_CLIENT_NOTE) note('Notes', head.notes.trim())
  // ── the standard terms (owner, 18 Nov 2026: they must be in the Excel too) ─────────────────────────
  const TEXT_CHARS = 130 // characters of 10.5 pt text that fit across A..J
  const termsBlock = (heading: string, items: readonly TermBlock[], lead?: string) => {
    r += 2
    ws.mergeCells(r, 1, r, LAST)
    const h = ws.getCell(r, 1)
    h.value = heading
    h.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF' + INK } }
    h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + SAND } }
    h.alignment = { vertical: 'middle', wrapText: true }
    ws.getRow(r).height = Math.max(24, 14.5 * Math.ceil(heading.length / TEXT_CHARS) + 8)
    const entries: { title: string; text: string; no: string }[] = [
      ...(lead ? [{ title: '', text: lead, no: '' }] : []),
      ...items.map((it, i) => ({ ...it, no: `${i + 1}. ` })),
    ]
    for (const e of entries) {
      r++
      ws.mergeCells(r, 1, r, LAST)
      const c = ws.getCell(r, 1)
      const font = { name: 'Calibri', size: 10.5, color: { argb: 'FF' + INK } }
      c.value = { richText: [...(e.title ? [{ font: { ...font, bold: true }, text: `${e.no}${e.title}: ` }] : []), { font: { ...font, bold: !e.title }, text: e.text }] }
      c.alignment = { vertical: 'top', wrapText: true }
      ws.getRow(r).height = Math.max(20, 14.5 * Math.ceil((e.no.length + e.title.length + 2 + e.text.length) / TEXT_CHARS) + 6)
    }
  }
  termsBlock('Terms and conditions', TERMS, PRICE_TERM)
  termsBlock(EXPECTATIONS_TITLE, EXPECTATIONS)
  r += 2
  ws.mergeCells(r, 1, r, LAST)
  const how = ws.getCell(r, 1)
  how.value = 'To change this quotation in Excel: edit Qty, Rate (₹), the discount % or “Counted in total”. Amounts and totals recalculate.'
  how.font = { name: 'Calibri', size: 9, italic: true, color: { argb: 'FF' + MUTED } }
  return new Uint8Array(await wb.xlsx.writeBuffer())
}
