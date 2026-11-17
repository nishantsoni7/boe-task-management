// ── OLD ORDERS: THE QUOTATION TAB OF A CLICKUP EXCEL ───────────────────────────
//
// Nine old orders (469 to 530) were never a PI: their Excel is the app's own
// quotation export, a single tab "Quotation". Read for DISPLAY only (Draft
// Orders, orders 300 and up); nothing is saved.
//
// The layout, from the real files (checked on the ClickUp backup, 2026-11-17):
//   a header block (title; "Client: ..."; "Date: ..."; "Ref: ..."; sometimes
//   "Order no ..."), then ONE header row (Product Name, Description, Quantity,
//   Unit Price, Total, Notes, with an optional Code column and an Image column),
//   then the lines, then the printed totals (Subtotal, Discount, Tax, Grand Total)
//   and sometimes a free-text note ("Packing extra - 25000/-").
//
// Rules: every column is found by its heading; a line is a row with a quantity and
// a unit price; the printed totals are kept AS PRINTED and never recomputed (a
// sheet's own grand total can include an extra that is only a note); where the
// sheet disagrees with its own arithmetic that is reported in words, not repaired.
// A sheet with two "Image" headings has the code under the first (order 469).

import { harvestProductImages, resolveDrawingPart } from './drawingAnchors'
import {
  normalizeLabel,
  OLD_ORDER_MAX_WORKBOOK_BYTES,
  openPiArchive,
  partText,
  readSharedStrings,
  readSheet,
  resolveSheetPart,
  type PiCell,
} from './workbookReader'
import type { PiProductImage } from './types'

export type QuotationLine = {
  /** 1-based worksheet row. */
  row: number
  code: string | null
  name: string | null
  description: string | null
  quantity: number
  unitPrice: number
  total: number | null
  notes: string | null
  image: PiProductImage | null
}

export type QuotationTotal = { label: string; amount: number }

export type QuotationSheet = {
  title: string | null
  client: string | null
  date: string | null
  ref: string | null
  orderNo: string | null
  lines: QuotationLine[]
  totals: QuotationTotal[]
  /** Free-text rows under the lines that are not a total ("Packing extra - 25000/-"). */
  footnotes: string[]
  /** Where the sheet disagrees with its own arithmetic, in words. */
  problems: string[]
}

export type QuotationRead =
  | { ok: true; data: QuotationSheet }
  | { ok: false; reason: 'NO_QUOTATION_TAB' | 'NO_HEADER_ROW' | 'NO_LINES' | 'UNREADABLE' }

const MAX_HEADER_ROW = 80
const MAX_ROWS = 2000
const MAX_COL = 14

const textOf = (c: PiCell | undefined): string | null => {
  if (!c) return null
  if (c.type === 'string' && c.text !== null) return c.text.replace(/\s+/g, ' ').trim() || null
  if (c.type === 'number' && c.number !== null) return String(c.number)
  return null
}

const numberOf = (c: PiCell | undefined): number | null => {
  if (!c) return null
  if (c.type === 'number') return c.number
  if (c.type === 'string' && c.text !== null) {
    const n = Number(c.text.replace(/[,\s₹]/g, ''))
    return Number.isFinite(n) && c.text.trim() !== '' ? n : null
  }
  return null
}

const FOOTER = /^(sub ?total|discount|tax|gst|grand total|total)\b/

export async function readQuotationWorkbook(bytes: Uint8Array): Promise<QuotationRead> {
  const opened = await openPiArchive(bytes, OLD_ORDER_MAX_WORKBOOK_BYTES)
  if (!opened.ok) return { ok: false, reason: 'UNREADABLE' }
  const { entries } = opened.archive

  let resolution = resolveSheetPart(entries, 'Quotation')
  if (!resolution.ok && resolution.reason === 'MASTER_SHEET_MISSING') {
    const declared = resolution.sheetNames.find(n => normalizeLabel(n) === 'quotation')
    if (declared !== undefined) resolution = resolveSheetPart(entries, declared)
  }
  if (!resolution.ok) return { ok: false, reason: 'NO_QUOTATION_TAB' }
  const xml = partText(entries, resolution.part)
  if (!xml) return { ok: false, reason: 'UNREADABLE' }

  const sheet = readSheet(xml, readSharedStrings(entries))
  const byRow = new Map<number, PiCell[]>()
  for (const c of sheet.cells.values()) {
    if (c.row > MAX_ROWS || c.col > MAX_COL) continue
    ;(byRow.get(c.row) ?? byRow.set(c.row, []).get(c.row)!).push(c)
  }
  for (const list of byRow.values()) list.sort((a, b) => a.col - b.col)
  const rows = [...byRow.keys()].sort((a, b) => a - b)

  // ── The header row, and each column by its heading ──
  const headerRow = rows.find(r => r <= MAX_HEADER_ROW && (() => {
    const heads = (byRow.get(r) ?? []).map(c => normalizeLabel(textOf(c) ?? ''))
    return heads.includes('product name') && heads.includes('quantity') && heads.includes('unit price')
  })())
  if (headerRow === undefined) return { ok: false, reason: 'NO_HEADER_ROW' }

  const cols: Record<string, number> = {}
  const images: number[] = []
  for (const c of byRow.get(headerRow) ?? []) {
    const h = normalizeLabel(textOf(c) ?? '')
    if (h === 'image') images.push(c.col)
    else if (h === 'product name') cols.name = c.col
    else if (h === 'description') cols.description = c.col
    else if (h === 'quantity') cols.quantity = c.col
    else if (h === 'unit price') cols.unitPrice = c.col
    else if (h === 'total') cols.total = c.col
    else if (h === 'notes') cols.notes = c.col
    else if (h === 'code' || h === 'item code' || h === 'code no') cols.code = c.col
  }
  // Order 469 prints "Image | Image" over the code and the picture: the first is the code.
  if (cols.code === undefined && images.length >= 2) cols.code = images[0]
  const imageCol = images.length > 0 ? images[images.length - 1] : undefined

  // ── The block above the header ──
  const head: Pick<QuotationSheet, 'title' | 'client' | 'date' | 'ref' | 'orderNo'> = { title: null, client: null, date: null, ref: null, orderNo: null }
  for (const r of rows.filter(r => r < headerRow)) {
    const cells = byRow.get(r) ?? []
    cells.forEach((c, i) => {
      const t = textOf(c)
      if (t === null) return
      const after = (m: RegExpExecArray) => (m[1].trim() !== '' ? m[1].trim() : textOf(cells[i + 1]))
      let m: RegExpExecArray | null
      if ((m = /^client\s*:\s*(.*)$/i.exec(t))) head.client = after(m)
      else if ((m = /^date\s*:\s*(.*)$/i.exec(t))) head.date = after(m)
      else if ((m = /^ref\s*:\s*(.*)$/i.exec(t))) head.ref = after(m)
      else if ((m = /^order\s*no\.?\s*[:\-–]*\s*(.*)$/i.exec(t))) head.orderNo = after(m)
      else if (head.title === null && c.type === 'string' && !/^[\d\s.\-:]*$/.test(t) && !/^\d+$/.test(t)) head.title = t
    })
  }

  // ── Lines, totals as printed, notes ──
  const lines: QuotationLine[] = []
  const totals: QuotationTotal[] = []
  const footnotes: string[] = []
  const problems: string[] = []
  const at = (cells: PiCell[], col: number | undefined) => (col === undefined ? undefined : cells.find(c => c.col === col))
  for (const r of rows.filter(r => r > headerRow)) {
    const cells = byRow.get(r) ?? []
    const quantity = numberOf(at(cells, cols.quantity))
    const unitPrice = numberOf(at(cells, cols.unitPrice))
    const name = textOf(at(cells, cols.name))
    const code = textOf(at(cells, cols.code))
    if (quantity !== null && quantity > 0 && unitPrice !== null && unitPrice >= 0 && (name !== null || code !== null)) {
      lines.push({
        row: r, code, name, description: textOf(at(cells, cols.description)), quantity, unitPrice,
        total: numberOf(at(cells, cols.total)), notes: textOf(at(cells, cols.notes)), image: null,
      })
      continue
    }
    const label = cells.map(c => ({ c, t: textOf(c) })).find(x => x.c.type === 'string' && x.t !== null && FOOTER.test(normalizeLabel(x.t)))
    if (label) {
      const amount = [...cells].reverse().map(numberOf).find(n => n !== null) ?? null
      if (amount !== null) totals.push({ label: label.t!.replace(/\s*:\s*$/, ''), amount })
      continue
    }
    const note = cells.map(textOf).filter((t): t is string => t !== null).join(' ')
    if (note !== '' && footnotes.length < 10) footnotes.push(note)
  }
  if (lines.length === 0) return { ok: false, reason: 'NO_LINES' }

  // ── Pictures: one per line, anchored in the Image column ──
  if (imageCol !== undefined) {
    const drawingPart = resolveDrawingPart(entries, resolution.part)
    if (drawingPart) {
      const harvest = harvestProductImages({
        entries, drawingPart, representativeColumn: imageCol, customizationColumn: -1,
        firstRow: headerRow + 1, lastRow: lines[lines.length - 1].row,
      })
      for (const line of lines) line.image = harvest.representativeByRow.get(line.row)?.[0] ?? null
    }
  }

  // ── The sheet against its own arithmetic: reported, never repaired ──
  for (const l of lines) {
    if (l.total !== null && Math.abs(l.quantity * l.unitPrice - l.total) > 0.5) problems.push(`Row ${l.row}: quantity × unit price does not equal the line total.`)
  }
  const sub = totals.find(t => /^sub ?total/i.test(t.label))
  const sum = lines.reduce((a, l) => a + (l.total ?? l.quantity * l.unitPrice), 0)
  if (sub && Math.abs(sub.amount - sum) > 0.5) problems.push('The printed subtotal does not equal the sum of the lines.')

  return { ok: true, data: { ...head, lines, totals, footnotes, problems } }
}
