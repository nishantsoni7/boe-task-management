// Where each part of a BOE PI actually sits in THIS workbook.
//
// WHY THIS EXISTS
// ---------------
// The template fixes every address — column headers on row 31, products from
// row 32, the dates under row 112, the footer's figures in column I, rows
// 115–122 — and the parser used to read exactly those addresses. People edit
// the sheet: a product row deleted or added, a spacer row removed, a column
// inserted. Every one of those moves something, and a fixed address then reads
// the NEXT cell along: a production draft (2026-09-24) lost its Grand Total that
// way, and its dates were read off the labels above them.
//
// So each block is found by its OWN labels, independently:
//
//   product columns   the row carrying all nine column names, each column
//                     mapped by its name (not by its letter)
//   header block      "PI No:", "Date of Creation:", "BILL TO:" … each value
//                     is the cell beside its label
//   dates             "Date of Order Confirmation…", "Dispatch Date
//                     Finalized:" — each value is the cell BELOW its label
//   footer            Sub Total → Grand Total as consecutive labels in one
//                     column; the amounts are read from the "Total Cost (INR)"
//                     column
//
// …and then PROVED BY THE DATA. A footer is only trusted when its own figures
// add up (Total + GST = Grand Total). When the labels cannot be found, the
// footer is looked for by that arithmetic instead. When neither works, the
// caller refuses the workbook rather than read a template cell that may hold
// something else entirely.
//
// Nothing here is a fuzzy match. Labels are compared whole (after whitespace,
// case and punctuation are set aside), every expected column name must be found
// exactly once, and a candidate that is ambiguous is never chosen by guesswork.

import { cellRef, normalizeLabel, numberToPlainText, type PiCell, type PiSheet } from './workbookReader'

// ── The template, as a reference point only ──────────────────────────────────

export const TEMPLATE_HEADER_ROW = 31
export const TEMPLATE_FIRST_PRODUCT_ROW = 32
export const TEMPLATE_LAST_PRODUCT_ROW = 111
/** Row of the "Date of Order Confirmation" / "Dispatch Date Finalized" labels. */
export const TEMPLATE_DATES_LABEL_ROW = 112
/** Row of the Grand Total in the template. */
export const TEMPLATE_GRAND_TOTAL_ROW = 122
/** Column G (0-based 6): the footer's labels. */
export const TEMPLATE_FOOTER_LABEL_COL = 6

/** How far from the top a moved column-header row is looked for. */
const MAX_HEADER_ROW = 80
/** How many columns across a moved block is looked for. */
const MAX_COL = 40

export type ProductColumnKey =
  | 'code' | 'name' | 'quantity' | 'dimensions' | 'image'
  | 'material' | 'costPerPiece' | 'lineTotal' | 'itemSequence' | 'customization'

/** The nine named columns (the item sequence column has no heading; see below). */
export const PRODUCT_COLUMN_NAMES: readonly { key: Exclude<ProductColumnKey, 'itemSequence'>; label: string; templateCol: number }[] = [
  { key: 'code',          label: 'Code',                        templateCol: 0 },
  { key: 'name',          label: 'Name',                        templateCol: 1 },
  { key: 'quantity',      label: 'Quantity',                    templateCol: 2 },
  { key: 'dimensions',    label: 'Dimension in inches & Shape', templateCol: 3 },
  { key: 'image',         label: 'Representative Image',        templateCol: 4 },
  { key: 'material',      label: 'Material',                    templateCol: 6 },
  { key: 'costPerPiece',  label: 'Cost per piece (INR)',        templateCol: 7 },
  { key: 'lineTotal',     label: 'Total Cost (INR)',            templateCol: 8 },
  { key: 'customization', label: 'Customization',               templateCol: 10 },
]

export type ProductColumns = Record<ProductColumnKey, number>

export const TEMPLATE_COLUMNS: ProductColumns = {
  code: 0, name: 1, quantity: 2, dimensions: 3, image: 4,
  material: 6, costPerPiece: 7, lineTotal: 8, itemSequence: 9, customization: 10,
}

export type HeaderField =
  | 'sourceOrderNumber' | 'creationDate' | 'createdBy' | 'boeGst' | 'contactNumber'
  | 'billToName' | 'billToPhone' | 'billToGst' | 'billingAddress'
  | 'shipToName' | 'shipToPhone' | 'shipToGst' | 'shippingAddress'

/** Where each header value sits in the template. The fallback when a label is absent. */
export const TEMPLATE_HEADER_CELLS: Record<HeaderField, string> = {
  sourceOrderNumber: 'B20', creationDate: 'G20', createdBy: 'G21', boeGst: 'B22', contactNumber: 'G22',
  billToName: 'B25', billToPhone: 'B26', billToGst: 'B27', billingAddress: 'B28',
  shipToName: 'G25', shipToPhone: 'G26', shipToGst: 'G27', shippingAddress: 'G28',
}

export type FooterRows = {
  discount: number
  subtotal: number
  fabric: number
  packing: number
  transport: number
  total: number
  gst: number
  grandTotal: number
}

export type FooterLocation = {
  rows: FooterRows
  /** Column the footer's labels are in (the discount's label is read from here). */
  labelCol: number
  /** Column the footer's amounts are read from. */
  valueCol: number
  /**
   *   labels      every label found, and Total + GST = Grand Total
   *   labelsOnly  every label found, but the figures there do not add up
   *               (the workbook's own arithmetic is wrong; reported, not fixed)
   *   arithmetic  labels not found; located by Total + GST = Grand Total alone
   *   none        neither — the caller refuses the workbook
   */
  how: 'labels' | 'labelsOnly' | 'arithmetic' | 'none'
  /** GST rate printed on the GST label ("GST @ 18%"), or null when none is. */
  gstRate: number | null
}

export type PiLayout = {
  headerRow: number
  firstProductRow: number
  lastProductRow: number
  cols: ProductColumns
  /** Every header value's cell, found by its label or (label absent) the template cell moved with the sheet. */
  headerCells: Record<HeaderField, string>
  /** Header fields whose label was not found, so the template cell was used. */
  headerFieldsByTemplate: readonly HeaderField[]
  confirmationDateCell: string
  dispatchDateCell: string
  /** True when the date labels were found; false means template cells were used. */
  datesByLabel: boolean
  footer: FooterLocation
  /** Candidate cells for the fabric-choice dropdown, most likely first. */
  fabricChoiceCells: readonly string[]
  /** Candidate cells for the "Note: … ex-factory …" block, most likely first. */
  termsNoteCells: readonly string[]
  /** Rows the header row moved from the template's (0 = in place). */
  headerRowOffset: number
  /** Product columns whose position differs from the template's, by name. */
  movedColumns: readonly { key: ProductColumnKey; from: number; to: number }[]
}

export type HeaderRowFailure = {
  /** The row that matched the most column names, for the message. */
  bestRow: number
  missing: readonly string[]
  duplicated: readonly string[]
}

// ── Small helpers ─────────────────────────────────────────────────────────────

/** Letters and digits only, lower-cased: "PI No:" → "pino", "Sub-Total" → "subtotal". */
export const labelKey = (value: string | null): string =>
  (value ?? '').toLowerCase().replace(/\([a-z]\)/g, '').replace(/[^a-z0-9]/g, '')

function textOf(cell: PiCell | undefined): string | null {
  if (!cell) return null
  if (cell.type === 'number' && cell.number !== null) return numberToPlainText(cell.number)
  return cell.text
}

function numberOf(cell: PiCell | undefined): number | null {
  if (!cell) return null
  if (cell.type === 'number') return cell.number
  if (cell.type === 'string' && cell.text) {
    const cleaned = cell.text.replace(/[,\s]/g, '')
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : null
  }
  return null
}

const hasValue = (cell: PiCell | undefined): boolean =>
  !!cell && cell.type !== 'empty' && (cell.text !== null || cell.number !== null)

/** Cells grouped by row, so a row can be scanned without walking the whole sheet. */
function indexByRow(sheet: PiSheet): Map<number, PiCell[]> {
  const byRow = new Map<number, PiCell[]>()
  for (const cell of sheet.cells.values()) {
    const list = byRow.get(cell.row)
    if (list) list.push(cell)
    else byRow.set(cell.row, [cell])
  }
  return byRow
}

function parseAddress(address: string): { col: number; row: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(address)
  if (!m) throw new Error(`bad address ${address}`)
  let col = 0
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { col: col - 1, row: Number(m[2]) }
}

const moveAddress = (address: string, rows: number, cols: number): string => {
  const { col, row } = parseAddress(address)
  return cellRef(Math.max(0, col + cols), Math.max(1, row + rows))
}

// ── Product columns, by name ──────────────────────────────────────────────────

/**
 * The row carrying every column name, and which column each one is in.
 *
 * The template's own row is tried first, so an unedited workbook always reads
 * exactly as before. Every name must appear EXACTLY once on the row: a missing
 * name, or one that appears twice, is not a row this parser can map.
 */
export function locateProductColumns(sheet: PiSheet):
  { ok: true; headerRow: number; cols: ProductColumns } | ({ ok: false } & HeaderRowFailure) {
  const byRow = indexByRow(sheet)
  const rows = [TEMPLATE_HEADER_ROW, ...Array.from({ length: MAX_HEADER_ROW }, (_, i) => i + 1).filter(r => r !== TEMPLATE_HEADER_ROW)]

  let best: HeaderRowFailure = { bestRow: TEMPLATE_HEADER_ROW, missing: PRODUCT_COLUMN_NAMES.map(c => c.label), duplicated: [] }
  let bestFound = -1

  for (const row of rows) {
    const cells = byRow.get(row) ?? []
    const found = new Map<string, number[]>()
    for (const cell of cells) {
      const text = textOf(cell)
      if (text === null) continue
      const norm = normalizeLabel(text)
      for (const { key, label } of PRODUCT_COLUMN_NAMES) {
        if (norm === normalizeLabel(label)) {
          found.set(key, [...(found.get(key) ?? []), cell.col])
        }
      }
    }
    const missing = PRODUCT_COLUMN_NAMES.filter(c => !found.has(c.key)).map(c => c.label)
    const duplicated = PRODUCT_COLUMN_NAMES.filter(c => (found.get(c.key)?.length ?? 0) > 1).map(c => c.label)

    if (missing.length === 0 && duplicated.length === 0) {
      const col = (key: string) => found.get(key)![0]
      const cols = {
        code: col('code'), name: col('name'), quantity: col('quantity'), dimensions: col('dimensions'),
        image: col('image'), material: col('material'), costPerPiece: col('costPerPiece'),
        lineTotal: col('lineTotal'), customization: col('customization'), itemSequence: -1,
      } as ProductColumns
      cols.itemSequence = locateItemSequenceColumn(cols, cells)
      return { ok: true, headerRow: row, cols }
    }

    const score = PRODUCT_COLUMN_NAMES.length - missing.length
    if (score > bestFound) {
      bestFound = score
      best = { bestRow: row, missing, duplicated }
    }
  }
  return { ok: false, ...best }
}

/**
 * The item-sequence column has no heading in the template (column J, hidden,
 * between "Total Cost (INR)" and "Customization"). It is the one column between
 * those two that carries no name; when that is not a single column, it is the
 * column straight after the line total, and a missing sequence is then reported
 * row by row by the caller.
 */
function locateItemSequenceColumn(cols: ProductColumns, headerCells: readonly PiCell[]): number {
  const named = new Set(headerCells.filter(c => textOf(c) !== null).map(c => c.col))
  const between: number[] = []
  const lo = Math.min(cols.lineTotal, cols.customization)
  const hi = Math.max(cols.lineTotal, cols.customization)
  for (let c = lo + 1; c < hi; c++) if (!named.has(c)) between.push(c)
  return between.length === 1 ? between[0] : cols.lineTotal + 1
}

// ── Header block, by label ────────────────────────────────────────────────────

const HEADER_LABELS: Record<Exclude<HeaderField, 'boeGst' | 'billToName' | 'billToPhone' | 'billToGst' | 'shipToName' | 'shipToPhone' | 'shipToGst'>, readonly string[]> = {
  // "PI No:" / "Sales Person" on the current template; "Order no:-" /
  // "Created By:" on the earlier one still in circulation.
  sourceOrderNumber: ['pino', 'pinumber', 'orderno'],
  creationDate: ['dateofcreation'],
  createdBy: ['salesperson', 'createdby'],
  contactNumber: ['contactno', 'contactnumber'],
  billingAddress: ['billingaddress'],
  shippingAddress: ['shippingaddress'],
}

const KNOWN_HEADER_LABEL_KEYS = new Set([
  'pino', 'pinumber', 'orderno', 'dateofcreation', 'salesperson', 'createdby', 'gst', 'contactno', 'contactnumber',
  'billto', 'shipto', 'name', 'phone', 'billingaddress', 'shippingaddress',
])

/**
 * The value that belongs to a label: the cell to its right. When that cell is
 * empty and the one after it holds something that is not itself a label, a
 * column was inserted between them, and that one is the value.
 */
function valueBeside(sheet: PiSheet, label: { row: number; col: number }): string {
  const right = cellRef(label.col + 1, label.row)
  if (hasValue(sheet.cells.get(right))) return right
  const next = sheet.cells.get(cellRef(label.col + 2, label.row))
  if (hasValue(next) && !KNOWN_HEADER_LABEL_KEYS.has(labelKey(textOf(next)))) return cellRef(label.col + 2, label.row)
  return right
}

function locateHeaderCells(sheet: PiSheet, headerRow: number, colShift: number):
  { cells: Record<HeaderField, string>; byTemplate: HeaderField[] } {
  const rowShift = headerRow - TEMPLATE_HEADER_ROW
  const labels: { row: number; col: number; key: string }[] = []
  for (const cell of sheet.cells.values()) {
    if (cell.row >= headerRow || cell.col > MAX_COL) continue
    const key = labelKey(textOf(cell))
    if (KNOWN_HEADER_LABEL_KEYS.has(key)) labels.push({ row: cell.row, col: cell.col, key })
  }
  labels.sort((a, b) => a.row - b.row || a.col - b.col)
  const one = (keys: readonly string[], within?: (l: { row: number; col: number }) => boolean) => {
    const hits = labels.filter(l => keys.includes(l.key) && (!within || within(l)))
    return hits.length === 1 ? hits[0] : null
  }

  const found: Partial<Record<HeaderField, { row: number; col: number }>> = {}
  for (const [field, keys] of Object.entries(HEADER_LABELS) as [HeaderField, readonly string[]][]) {
    const hit = one(keys)
    if (hit) found[field] = hit
  }

  // The two party blocks: "BILL TO:" and "SHIP TO:", each heading a column of
  // Name / Phone / GST labels below it (and before the other block's next heading).
  const billTo = one(['billto'])
  const shipTo = one(['shipto'])
  const blockBelow = (head: { row: number; col: number } | null, key: string) =>
    head ? one([key], l => l.col === head.col && l.row > head.row && l.row <= head.row + 6) : null
  if (billTo) {
    const n = blockBelow(billTo, 'name'); if (n) found.billToName = n
    const p = blockBelow(billTo, 'phone'); if (p) found.billToPhone = p
    const g = blockBelow(billTo, 'gst'); if (g) found.billToGst = g
  }
  if (shipTo) {
    const n = blockBelow(shipTo, 'name'); if (n) found.shipToName = n
    const p = blockBelow(shipTo, 'phone'); if (p) found.shipToPhone = p
    const g = blockBelow(shipTo, 'gst'); if (g) found.shipToGst = g
  }
  // BOE's own GST: the one "GST:" label above the party blocks.
  const partiesStart = Math.min(billTo?.row ?? Infinity, shipTo?.row ?? Infinity)
  const boeGst = one(['gst'], l => l.row < partiesStart)
  if (boeGst) found.boeGst = boeGst

  const cells = {} as Record<HeaderField, string>
  const byTemplate: HeaderField[] = []
  const fields = Object.keys(TEMPLATE_HEADER_CELLS) as HeaderField[]
  for (const field of fields) {
    const label = found[field]
    if (label) cells[field] = valueBeside(sheet, label)
  }
  // A value whose label is absent (the template prints no "GST:" beside the
  // ship-to GST) moves with its nearest LABELLED neighbour in the same template
  // column — the ship-to GST follows the ship-to phone and name, wherever a
  // row or column insertion put them. With no such neighbour, it moves with the
  // sheet as a whole.
  for (const field of fields) {
    if (cells[field]) continue
    const template = parseAddress(TEMPLATE_HEADER_CELLS[field])
    const neighbour = fields
      .filter(f => cells[f] && parseAddress(TEMPLATE_HEADER_CELLS[f]).col === template.col)
      .sort((a, b) =>
        Math.abs(parseAddress(TEMPLATE_HEADER_CELLS[a]).row - template.row)
        - Math.abs(parseAddress(TEMPLATE_HEADER_CELLS[b]).row - template.row))[0]
    if (neighbour) {
      const from = parseAddress(TEMPLATE_HEADER_CELLS[neighbour])
      const to = parseAddress(cells[neighbour])
      cells[field] = moveAddress(TEMPLATE_HEADER_CELLS[field], to.row - from.row, to.col - from.col)
    } else {
      cells[field] = moveAddress(TEMPLATE_HEADER_CELLS[field], rowShift, colShift)
    }
    byTemplate.push(field)
  }
  return { cells, byTemplate }
}

// ── Dates, by label ───────────────────────────────────────────────────────────

function locateDateCells(sheet: PiSheet, fromRow: number, toRow: number, colShift: number, fallbackRowShift: number):
  { confirmation: string; dispatch: string; byLabel: boolean } {
  let confirmation: PiCell | null = null
  let dispatch: PiCell | null = null
  for (const cell of sheet.cells.values()) {
    if (cell.row < fromRow || cell.row > toRow) continue
    const key = labelKey(textOf(cell))
    if (key.startsWith('dateoforderconfirmation')) confirmation = confirmation ?? cell
    if (key.startsWith('dispatchdatefinalized')) dispatch = dispatch ?? cell
  }
  if (confirmation && dispatch) {
    return {
      confirmation: cellRef(confirmation.col, confirmation.row + 1),
      dispatch: cellRef(dispatch.col, dispatch.row + 1),
      byLabel: true,
    }
  }
  return {
    confirmation: moveAddress('A113', fallbackRowShift, colShift),
    dispatch: moveAddress('E113', fallbackRowShift, colShift),
    byLabel: false,
  }
}

// ── Footer, by label, proved by arithmetic ────────────────────────────────────

const FOOTER_SEQUENCE: readonly ((label: string) => boolean)[] = [
  l => l === 'subtotal',
  l => l.includes('fabric'),
  l => l.includes('packing'),
  l => l.includes('transport'),
  l => l === 'total',
  l => l.startsWith('gst'),
  l => l === 'grandtotal',
]

/** Lower-case letters only, as the footer labels have always been compared. */
const footerKey = (value: string | null): string =>
  (value ?? '').toLowerCase().replace(/\([a-z]\)/g, '').replace(/[^a-z]/g, '')

function rowsFromGrandTotal(grand: number): FooterRows {
  return {
    discount: grand - 7, subtotal: grand - 6, fabric: grand - 5, packing: grand - 4,
    transport: grand - 3, total: grand - 2, gst: grand - 1, grandTotal: grand,
  }
}

/** Rupee tolerance for the footer's own arithmetic: GST is commonly rounded. */
const FOOTER_TOLERANCE = 1

/** Total + GST = Grand Total, at these rows in this column. */
function footerAddsUp(sheet: PiSheet, rows: FooterRows, col: number): boolean {
  const total = numberOf(sheet.cells.get(cellRef(col, rows.total)))
  const gst = numberOf(sheet.cells.get(cellRef(col, rows.gst)))
  const grand = numberOf(sheet.cells.get(cellRef(col, rows.grandTotal)))
  return total !== null && gst !== null && grand !== null && grand > 0
    && Math.abs(total + gst - grand) <= FOOTER_TOLERANCE
}

function gstRateFrom(label: string | null): number | null {
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(label ?? '')
  return m ? Number(m[1]) / 100 : null
}

export function locateFooterBlock(sheet: PiSheet, cols: ProductColumns, afterRow: number): FooterLocation {
  const byRow = indexByRow(sheet)
  const maxRow = Math.max(...sheet.cells.size ? [...byRow.keys()] : [afterRow])
  const at = (col: number, row: number) => footerKey(textOf(sheet.cells.get(cellRef(col, row))))

  // Every column/row where the seven labels run down consecutively.
  const candidates: { grand: number; col: number }[] = []
  for (let row = afterRow + 1; row <= maxRow; row++) {
    for (const cell of byRow.get(row) ?? []) {
      if (!FOOTER_SEQUENCE[0](footerKey(textOf(cell)))) continue
      const ok = FOOTER_SEQUENCE.every((matches, i) => {
        const label = at(cell.col, row + i)
        return label !== '' && matches(label)
      })
      if (ok) candidates.push({ grand: row + 6, col: cell.col })
    }
  }

  // Nearest to the template wins, so an unedited workbook reads exactly as before.
  const nearest = (a: { grand: number; col: number }) =>
    Math.abs(a.grand - TEMPLATE_GRAND_TOTAL_ROW) + Math.abs(a.col - TEMPLATE_FOOTER_LABEL_COL)
  candidates.sort((a, b) => nearest(a) - nearest(b))

  for (const candidate of candidates) {
    const rows = rowsFromGrandTotal(candidate.grand)
    const gstRate = gstRateFrom(textOf(sheet.cells.get(cellRef(candidate.col, rows.gst))))
    // The amounts belong to the "Total Cost (INR)" column; the template also
    // puts them two columns right of the labels. Prefer whichever adds up.
    const valueCols = [...new Set([cols.lineTotal, candidate.col + 2])]
    const proven = valueCols.find(c => footerAddsUp(sheet, rows, c))
    if (proven !== undefined) return { rows, labelCol: candidate.col, valueCol: proven, how: 'labels', gstRate }
  }
  if (candidates.length > 0) {
    const first = candidates[0]
    const rows = rowsFromGrandTotal(first.grand)
    return {
      rows, labelCol: first.col, valueCol: cols.lineTotal, how: 'labelsOnly',
      gstRate: gstRateFrom(textOf(sheet.cells.get(cellRef(first.col, rows.gst)))),
    }
  }

  // No labels: look for the one place the figures themselves add up, in the
  // line-total column. Total, GST and Grand Total on consecutive rows, with GST
  // a plausible share of the total and a positive Sub Total four rows above.
  const found: number[] = []
  for (let row = afterRow + 7; row <= maxRow; row++) {
    const rows = rowsFromGrandTotal(row)
    if (!footerAddsUp(sheet, rows, cols.lineTotal)) continue
    const total = numberOf(sheet.cells.get(cellRef(cols.lineTotal, rows.total)))!
    const gst = numberOf(sheet.cells.get(cellRef(cols.lineTotal, rows.gst)))!
    const subtotal = numberOf(sheet.cells.get(cellRef(cols.lineTotal, rows.subtotal)))
    if (total > 0 && gst > 0 && gst <= total * 0.3 && subtotal !== null && subtotal > 0 && subtotal <= total) found.push(row)
  }
  if (found.length === 1) {
    return { rows: rowsFromGrandTotal(found[0]), labelCol: cols.material, valueCol: cols.lineTotal, how: 'arithmetic', gstRate: null }
  }
  return { rows: rowsFromGrandTotal(TEMPLATE_GRAND_TOTAL_ROW), labelCol: cols.material, valueCol: cols.lineTotal, how: 'none', gstRate: null }
}

// ── The whole layout ──────────────────────────────────────────────────────────

export function locateLayout(sheet: PiSheet):
  { ok: true; layout: PiLayout } | ({ ok: false } & HeaderRowFailure) {
  const columns = locateProductColumns(sheet)
  if (!columns.ok) return columns
  const { headerRow, cols } = columns
  const headerRowOffset = headerRow - TEMPLATE_HEADER_ROW
  const colShift = cols.code - TEMPLATE_COLUMNS.code

  const footer = locateFooterBlock(sheet, cols, headerRow)
  const footerOffset = footer.rows.grandTotal - TEMPLATE_GRAND_TOTAL_ROW

  const dates = locateDateCells(sheet, headerRow + 1, footer.rows.subtotal, colShift, footerOffset)
  const datesLabelRow = dates.byLabel ? Number(/\d+$/.exec(dates.confirmation)![0]) - 1 : null

  // The product band ends where the next block begins: the date labels when
  // they were found, otherwise the template's distance above the footer.
  const lastProductRow = datesLabelRow !== null
    ? datesLabelRow - 1
    : Math.min(TEMPLATE_LAST_PRODUCT_ROW + footerOffset, footer.rows.discount - 1)

  const header = locateHeaderCells(sheet, headerRow, colShift)

  const movedColumns = (Object.keys(TEMPLATE_COLUMNS) as ProductColumnKey[])
    .filter(key => cols[key] !== TEMPLATE_COLUMNS[key])
    .map(key => ({ key, from: TEMPLATE_COLUMNS[key], to: cols[key] }))

  const { fabric, discount } = footer.rows
  return {
    ok: true,
    layout: {
      headerRow,
      firstProductRow: headerRow + 1,
      lastProductRow,
      cols,
      headerCells: header.cells,
      headerFieldsByTemplate: header.byTemplate,
      confirmationDateCell: dates.confirmation,
      dispatchDateCell: dates.dispatch,
      datesByLabel: dates.byLabel,
      footer,
      // The template's dropdown sits two columns right of the fabric amount
      // (K117); its neighbours are tried after it.
      fabricChoiceCells: [2, 1, 3, 4].map(d => cellRef(footer.valueCol + d, fabric)),
      // The note block is anchored at the discount row in the first column (A115).
      termsNoteCells: [0, -1, 1, 2, 3, 4].map(d => cellRef(cols.code, discount + d)),
      headerRowOffset,
      movedColumns,
    },
  }
}
