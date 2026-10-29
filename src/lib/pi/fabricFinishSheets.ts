// THE WORKBOOK'S OTHER TWO SHEETS, READ AS THEY ARE (owner, 2026-10-29).
//
// A BOE PI workbook carries, beside the Master sheet the app has always parsed,
// two per-product sheets nobody in the app could see:
//
//   "Packing cost and Fabric Cost"  fabric metres per piece, the price per
//                                   metre, the packing cost per piece and its
//                                   type, with the totals as the workbook's own
//                                   formulas (I = H × C, K = J × I, M = L × C).
//   "Fabric and Finish"             one free-text approval per product for the
//                                   fabric, the wood finish, the metal finish
//                                   and the marble / rope — PENDING, NA or the
//                                   choice itself, as the ERP side records it.
//
// BOTH SHEETS LINE UP WITH THE MASTER SHEET BY ROW: their columns A–D are the
// formulas =Master!A32 … =Master!D111, so sheet row r describes Master row
// r + 30, which is the `source_row` every stored product line keeps. The join
// is that arithmetic and nothing cleverer; a code written in A is reported but
// never used as a key, because a renumbered line keeps its row.
//
// THE MASTER SHEET'S OWN FABRIC AND PACKING FIGURES ARE THESE SHEETS' SUMS:
// Master I117 is SUM(K:K) and I118 is SUM(M:M) (rounded to the ten), so what
// this reads can be reconciled to the PI's Commercial breakdown exactly.
//
// READ-ONLY, AND NEVER STORED. Nothing here is typed in the app and nothing is
// written anywhere: the page asks for the stored workbook and shows what it
// says. Editing a PI in the app changes its lines, not this workbook — the
// page says so, and flags a line whose quantity has since moved.
//
// PURE. Bytes in, a description out. Tolerant of a sheet that is missing, a
// header that was renamed or a column that was added: columns are found by
// their header words first and by the template's letters second, and an
// approval column is any header the finish sheet carries from column G on.

import {
  cellRef,
  columnToIndex,
  openPiArchive,
  partText,
  readSharedStrings,
  readSheet,
  resolveSheetPart,
  type PiCell,
  type PiSheet,
} from './workbookReader'

export const FABRIC_COST_SHEET_NAME = 'Packing cost and Fabric Cost'
export const FABRIC_FINISH_SHEET_NAME = 'Fabric and Finish'

/** Sheet row r is Master row r + SHEET_ROW_OFFSET: row 2 ↔ Master 32, the first product slot. */
export const SHEET_ROW_OFFSET = 30
const FIRST_LINE_ROW = 2
/** Eighty product slots, B001–B080, as the Master sheet has. */
const LAST_LINE_ROW = 81
const HEADER_ROW = 1

export type FabricCostFigures = {
  /** Metres of fabric for one piece, as typed. */
  perPiece: number | null
  /** Metres for the line: the workbook's I (H × C), or that product when the formula kept no value. */
  total: number | null
  /** Rupees per metre, as typed. */
  pricePerMetre: number | null
  /** Rupees for the line: the workbook's K (J × I), or that product. */
  amount: number | null
}

export type PackingCostFigures = {
  /** Rupees per piece, as typed. */
  perPiece: number | null
  /** Rupees for the line: the workbook's M (L × C), or that product. */
  total: number | null
  /** Free text: "BCF", "Carton and crate" … */
  type: string | null
}

export type FinishApproval = { column: string; value: string | null }

export type FabricFinishLine = {
  /** The Master sheet row this line describes — `order_submission_items.source_row`. */
  masterRow: number
  /** The sheet's own row, for a reader checking the workbook. */
  sheetRow: number
  code: string | null
  name: string | null
  quantity: number | null
  material: string | null
  fabric: FabricCostFigures | null
  packing: PackingCostFigures | null
  /** One per approval column of the finish sheet, in the sheet's order. */
  approvals: FinishApproval[]
}

export type FabricFinishTotals = {
  totalFabricMetres: number
  fabricAmount: number
  packingTotal: number
  linesWithFabric: number
  linesWithPacking: number
}

export type FabricFinishSheets = {
  costSheet: { present: boolean }
  finishSheet: { present: boolean; approvalColumns: string[] }
  lines: FabricFinishLine[]
  totals: FabricFinishTotals
}

export type FabricFinishResult =
  | { ok: true; sheets: FabricFinishSheets; sheetNames: string[] }
  | { ok: false; reason: 'ARCHIVE' | 'NO_SHEETS'; message: string; sheetNames: string[] }

// ── Cells ─────────────────────────────────────────────────────────────────────

const cellAt = (sheet: PiSheet, col: number, row: number): PiCell | undefined =>
  sheet.cells.get(cellRef(col, row))

/** The cell's words, trimmed, or null for a blank. A number is its plain text. */
function textAt(sheet: PiSheet, col: number, row: number): string | null {
  const cell = cellAt(sheet, col, row)
  if (!cell) return null
  if (cell.text !== null) {
    const t = cell.text.trim()
    return t === '' ? null : t
  }
  if (cell.number !== null) return String(cell.number)
  return null
}

/** The cell's number, or a number written as words, or null. */
function numberAt(sheet: PiSheet, col: number, row: number): number | null {
  const cell = cellAt(sheet, col, row)
  if (!cell) return null
  if (cell.number !== null && Number.isFinite(cell.number)) return cell.number
  if (cell.text !== null) {
    const n = Number(cell.text.replace(/[,\s₹]/g, ''))
    return Number.isFinite(n) && cell.text.trim() !== '' ? n : null
  }
  return null
}

/** Lower case, letters and digits only, one space between words. */
const words = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Every header of the first row: column index → its words. */
function headers(sheet: PiSheet): Map<number, string> {
  const out = new Map<number, string>()
  for (const cell of sheet.cells.values()) {
    if (cell.row !== HEADER_ROW) continue
    const t = cell.text?.trim()
    if (t) out.set(cell.col, words(t))
  }
  return out
}

/**
 * The column whose header says `want` (every word, in order), or the template's
 * letter when no header does. `not` rules out a header that also says those
 * words — "total fabric" must not match "total fabric amount".
 */
function findColumn(head: Map<number, string>, want: string[], not: string[], fallback: string): number {
  for (const [col, label] of head) {
    if (want.some(w => label.includes(w)) && !not.some(n => label.includes(n))) return col
  }
  return columnToIndex(fallback)
}

// ── Lines ─────────────────────────────────────────────────────────────────────

/** A slot is in use when the Master row it mirrors names a product or has a quantity. */
function slotInUse(name: string | null, quantity: number | null): boolean {
  if (name !== null && name !== '0') return true
  return quantity !== null && quantity > 0
}

type CostColumns = {
  code: number; name: number; quantity: number; material: number
  fabricPerPiece: number; totalFabric: number; pricePerMetre: number; fabricAmount: number
  packingPerPiece: number; packingTotal: number; packingType: number
}

function costColumns(sheet: PiSheet): CostColumns {
  const head = headers(sheet)
  return {
    code: findColumn(head, ['code'], [], 'A'),
    name: findColumn(head, ['name'], [], 'B'),
    quantity: findColumn(head, ['quantity', 'qty'], [], 'C'),
    material: findColumn(head, ['material'], [], 'G'),
    fabricPerPiece: findColumn(head, ['fabric per pc', 'fabric per piece', 'fabric pc'], ['total', 'price', 'amount'], 'H'),
    totalFabric: findColumn(head, ['total fabric'], ['amount', 'cost', 'price'], 'I'),
    pricePerMetre: findColumn(head, ['price per meter', 'price per metre', 'fabric price', 'per meter', 'per metre'], ['total'], 'J'),
    fabricAmount: findColumn(head, ['total fabric amount', 'fabric amount', 'total fabric cost'], [], 'K'),
    packingPerPiece: findColumn(head, ['packing cost pc', 'packing cost per pc', 'packing cost per piece', 'packing pc', 'packing per pc'], ['total', 'type'], 'L'),
    packingTotal: findColumn(head, ['total packing'], [], 'M'),
    packingType: findColumn(head, ['packing type'], [], 'N'),
  }
}

/** A product of two figures when both are known, else null — the workbook's own arithmetic, repeated only where it left no value. */
const product = (a: number | null, b: number | null): number | null =>
  a !== null && b !== null ? Math.round(a * b * 100) / 100 : null

function readCostSheet(sheet: PiSheet): Map<number, FabricFinishLine> {
  const cols = costColumns(sheet)
  const lines = new Map<number, FabricFinishLine>()
  const lastRow = Math.min(LAST_LINE_ROW, Math.max(sheet.maxRow, FIRST_LINE_ROW))
  for (let row = FIRST_LINE_ROW; row <= lastRow; row++) {
    const name = textAt(sheet, cols.name, row)
    const quantity = numberAt(sheet, cols.quantity, row)
    if (!slotInUse(name, quantity)) continue
    const fabricPerPiece = numberAt(sheet, cols.fabricPerPiece, row)
    const totalFabric = numberAt(sheet, cols.totalFabric, row) ?? product(fabricPerPiece, quantity)
    const pricePerMetre = numberAt(sheet, cols.pricePerMetre, row)
    const fabricAmount = numberAt(sheet, cols.fabricAmount, row) ?? product(pricePerMetre, totalFabric)
    const packingPerPiece = numberAt(sheet, cols.packingPerPiece, row)
    const packingTotal = numberAt(sheet, cols.packingTotal, row) ?? product(packingPerPiece, quantity)
    lines.set(row, {
      masterRow: row + SHEET_ROW_OFFSET,
      sheetRow: row,
      code: textAt(sheet, cols.code, row),
      name,
      quantity,
      material: textAt(sheet, cols.material, row),
      fabric: { perPiece: fabricPerPiece, total: totalFabric, pricePerMetre, amount: fabricAmount },
      packing: { perPiece: packingPerPiece, total: packingTotal, type: textAt(sheet, cols.packingType, row) },
      approvals: [],
    })
  }
  return lines
}

/** Every header from column G on is an approval column, in sheet order; the picture column is not. */
function approvalColumns(sheet: PiSheet): { col: number; label: string }[] {
  const out: { col: number; label: string }[] = []
  const first = columnToIndex('G')
  for (const cell of sheet.cells.values()) {
    if (cell.row !== HEADER_ROW || cell.col < first) continue
    const label = cell.text?.trim()
    if (!label || /image|picture/i.test(label)) continue
    out.push({ col: cell.col, label })
  }
  return out.sort((a, b) => a.col - b.col)
}

function readFinishSheet(sheet: PiSheet, lines: Map<number, FabricFinishLine>): string[] {
  const head = headers(sheet)
  const nameCol = findColumn(head, ['name'], [], 'B')
  const quantityCol = findColumn(head, ['quantity', 'qty'], [], 'C')
  const codeCol = findColumn(head, ['code'], [], 'A')
  const columns = approvalColumns(sheet)
  const lastRow = Math.min(LAST_LINE_ROW, Math.max(sheet.maxRow, FIRST_LINE_ROW))
  for (let row = FIRST_LINE_ROW; row <= lastRow; row++) {
    const name = textAt(sheet, nameCol, row)
    const quantity = numberAt(sheet, quantityCol, row)
    const known = lines.get(row)
    if (!known && !slotInUse(name, quantity)) continue
    const approvals = columns.map(c => ({ column: c.label, value: textAt(sheet, c.col, row) }))
    if (known) {
      known.approvals = approvals
    } else {
      lines.set(row, {
        masterRow: row + SHEET_ROW_OFFSET, sheetRow: row,
        code: textAt(sheet, codeCol, row), name, quantity, material: null,
        fabric: null, packing: null, approvals,
      })
    }
  }
  return columns.map(c => c.label)
}

function totalsOf(lines: readonly FabricFinishLine[]): FabricFinishTotals {
  const sum = (pick: (l: FabricFinishLine) => number | null) =>
    Math.round(lines.reduce((acc, l) => acc + (pick(l) ?? 0), 0) * 100) / 100
  return {
    totalFabricMetres: sum(l => l.fabric?.total ?? null),
    fabricAmount: sum(l => l.fabric?.amount ?? null),
    packingTotal: sum(l => l.packing?.total ?? null),
    linesWithFabric: lines.filter(l => (l.fabric?.total ?? 0) > 0).length,
    linesWithPacking: lines.filter(l => (l.packing?.total ?? 0) > 0).length,
  }
}

// ── The read ──────────────────────────────────────────────────────────────────

/**
 * Read the two sheets out of a PI workbook. Pure with respect to the bytes.
 *
 * A workbook with neither sheet is reported as such rather than as an empty
 * page: an older template is a fact about the upload, not an absence of fabric.
 */
export async function readFabricFinishSheets(bytes: Uint8Array): Promise<FabricFinishResult> {
  const opened = await openPiArchive(bytes)
  if (!opened.ok) {
    return { ok: false, reason: 'ARCHIVE', message: `The stored workbook could not be opened (${opened.reason}).`, sheetNames: [] }
  }
  const { entries } = opened.archive
  const shared = readSharedStrings(entries)

  const open = (name: string): { sheet: PiSheet | null; names: readonly string[] } => {
    const resolved = resolveSheetPart(entries, name)
    if (!resolved.ok) return { sheet: null, names: resolved.sheetNames }
    const xml = partText(entries, resolved.part)
    return { sheet: xml ? readSheet(xml, shared) : null, names: resolved.sheetNames }
  }

  const cost = open(FABRIC_COST_SHEET_NAME)
  const finish = open(FABRIC_FINISH_SHEET_NAME)
  const sheetNames = [...(cost.names.length ? cost.names : finish.names)]
  if (!cost.sheet && !finish.sheet) {
    return {
      ok: false,
      reason: 'NO_SHEETS',
      message: `This workbook has neither a "${FABRIC_COST_SHEET_NAME}" nor a "${FABRIC_FINISH_SHEET_NAME}" sheet.`,
      sheetNames,
    }
  }

  const byRow = cost.sheet ? readCostSheet(cost.sheet) : new Map<number, FabricFinishLine>()
  const approvalLabels = finish.sheet ? readFinishSheet(finish.sheet, byRow) : []
  const lines = [...byRow.values()].sort((a, b) => a.sheetRow - b.sheetRow)
  // A line the finish sheet alone knows still answers to every approval column.
  for (const line of lines) {
    if (line.approvals.length === 0 && approvalLabels.length > 0) {
      line.approvals = approvalLabels.map(column => ({ column, value: null }))
    }
  }

  return {
    ok: true,
    sheetNames,
    sheets: {
      costSheet: { present: cost.sheet !== null },
      finishSheet: { present: finish.sheet !== null, approvalColumns: approvalLabels },
      lines,
      totals: totalsOf(lines),
    },
  }
}

// ── Reconciling with the PI ───────────────────────────────────────────────────

/** The Master sheet rounds each sum to the nearest ten rupees; a difference inside that is the same figure. */
export const RECONCILE_TOLERANCE_RUPEES = 10

export type Reconciliation =
  | { kind: 'match' }
  | { kind: 'differs'; sheet: number; pi: number }
  | { kind: 'pi_worded'; piText: string }
  | { kind: 'unknown' }

/**
 * Does the sheet's sum agree with the figure the PI stores? `piAmount` is
 * `order_submissions.fabric_cost` / `packing_cost`; `piText` its worded form
 * ("Included", a dash) when the PI did not state a number.
 */
export function reconcileWithPi(sheetSum: number, piAmount: number | null, piText: string | null): Reconciliation {
  if (piAmount === null) {
    return piText ? { kind: 'pi_worded', piText } : { kind: 'unknown' }
  }
  return Math.abs(sheetSum - piAmount) <= RECONCILE_TOLERANCE_RUPEES
    ? { kind: 'match' }
    : { kind: 'differs', sheet: sheetSum, pi: piAmount }
}

/** How a stored product line relates to a sheet line: the same quantity, a moved one, or no line at all. */
export type LineDrift = { kind: 'same' } | { kind: 'quantity'; piQuantity: number } | { kind: 'not_on_pi' }

export function lineDrift(line: FabricFinishLine, piQuantityByRow: ReadonlyMap<number, number | null>): LineDrift {
  if (!piQuantityByRow.has(line.masterRow)) return { kind: 'not_on_pi' }
  const piQuantity = piQuantityByRow.get(line.masterRow) ?? null
  if (piQuantity === null || line.quantity === null || piQuantity === line.quantity) return { kind: 'same' }
  return { kind: 'quantity', piQuantity }
}
