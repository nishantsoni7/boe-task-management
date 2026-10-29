// The two sheets of a BOE PI workbook that sit BESIDE the Master:
//
//   "Packing cost and Fabric Cost"   per product: fabric metres per piece,
//                                    fabric price per metre, packing cost per
//                                    piece, packing type
//   "Fabric and Finish"              per product: the chosen fabric and the
//                                    wood / metal / marble finishes, as text
//
// WHY THEY MATTER. The Master's own "(A) Total Fabric Cost" and "(B) Total
// Packing Cost" lines are formulas over the first sheet — ROUND(SUM(K:K), -1)
// and ROUND(SUM(M:M), -1), "-" when the sum is zero. The app has always stored
// those two totals and nothing per product. Reading the per-product values
// lets the app show the costing, let someone type what the sheet left blank,
// and recompute the totals when a quantity changes (owner, 2026-10-29).
//
// THE SAME DISCIPLINE AS THE MASTER PARSER (layout.ts): columns are found by
// their headings, never by their letters; a heading must be found exactly once;
// a value is read from the cell beside its heading. A sheet that is missing,
// unreadable or headed differently is REPORTED and never guessed — these
// sheets are optional, so nothing here is a blocking issue.
//
// Rows mirror the Master's product band (row 2 ↔ Master row 32 … 81 ↔ 111) by
// formula, so column A carries the product code the Master printed. A row is
// matched to a product by that code; when the code is absent on both sides the
// template's own row offset is used; a row that matches nothing is reported.
//
// Pure: bytes in, values out. No React, no network, nothing written.

import { labelKey } from './layout'
import {
  partText,
  readSharedStrings,
  readSheet,
  resolveSheetPart,
  type PiCell,
  type PiSheet,
} from './workbookReader'
import type { ArchiveEntries } from '../xlsxMediaOptimizer'
import type { PiProduct } from './types'

export const COST_SHEET_NAME = 'Packing cost and Fabric Cost'
export const FINISH_SHEET_NAME = 'Fabric and Finish'

/** Rows between a sheet's first row and its heading row, at most. */
const MAX_HEADING_ROW = 10
/** Sheet row ↔ Master row: the template puts product 1 on sheet row 2 and Master row 32. */
const TEMPLATE_ROW_OFFSET = 30

export type FabricFinishCostLine = {
  /** 1-based row of the cost sheet. */
  sheetRow: number
  /** Column A as the sheet cached it (a formula over the Master), trimmed. */
  code: string | null
  /** Column C as cached. Only rows with a quantity above zero are product rows. */
  quantity: number
  /** Metres of fabric per piece (blank = not given; 0 = none needed). */
  fabricMetresPerPiece: number | null
  /** ₹ per metre of fabric (blank = not given). */
  fabricPricePerMetre: number | null
  /** ₹ packing per piece (blank = not given). */
  packingCostPerPiece: number | null
  /** Free text: BCF, CB, "Carton and Carret" … */
  packingType: string | null
}

export type FabricFinishSpec = {
  /** The column heading as typed, whitespace collapsed ("Wood Finish Approval"). */
  heading: string
  /** The cell's text, trimmed. Never blank. */
  value: string
}

export type FabricFinishSpecLine = {
  sheetRow: number
  code: string | null
  quantity: number
  /** Every non-blank text cell to the right of the product columns, in column order. */
  specs: readonly FabricFinishSpec[]
}

export type FabricFinishSheetReport<Line> =
  | { found: false; reason: 'missing' | 'unreadable' | 'headings'; detail: string; lines: readonly Line[] }
  | { found: true; headingRow: number; lines: readonly Line[] }

export type FabricFinishSheets = {
  cost: FabricFinishSheetReport<FabricFinishCostLine>
  finish: FabricFinishSheetReport<FabricFinishSpecLine>
}

// ── Cells ─────────────────────────────────────────────────────────────────────

const textOf = (cell: PiCell | undefined): string | null => {
  if (!cell) return null
  if (cell.type === 'number' && cell.number !== null) {
    const n = cell.number
    return Number.isInteger(n) ? String(n) : String(n)
  }
  const t = cell.text?.replace(/\s+/g, ' ').trim() ?? ''
  return t === '' ? null : t
}

const numberOf = (cell: PiCell | undefined): number | null => {
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

/** A product code cell: the Master's code, or nothing when the Master row was blank ("0"). */
const codeOf = (cell: PiCell | undefined): string | null => {
  const t = textOf(cell)
  return t === null || t === '0' ? null : t
}

function cellsByRow(sheet: PiSheet): Map<number, PiCell[]> {
  const byRow = new Map<number, PiCell[]>()
  for (const cell of sheet.cells.values()) {
    const list = byRow.get(cell.row)
    if (list) list.push(cell)
    else byRow.set(cell.row, [cell])
  }
  for (const list of byRow.values()) list.sort((a, b) => a.col - b.col)
  return byRow
}

// ── Headings ──────────────────────────────────────────────────────────────────

type HeadingRule = { key: string; match: (k: string) => boolean; label: string }

const exact = (k: string) => (candidate: string) => candidate === k
const starts = (k: string) => (candidate: string) => candidate.startsWith(k)

/** The cost sheet's columns, by the words on them. */
const COST_HEADINGS: readonly HeadingRule[] = [
  { key: 'code',     match: exact('code'),                 label: 'Code' },
  { key: 'quantity', match: exact('quantity'),             label: 'Quantity' },
  { key: 'metres',   match: exact('fabricperpc'),          label: 'Fabric Per pc' },
  { key: 'price',    match: exact('fabricpricepermeter'),  label: 'Fabric price per meter' },
  { key: 'packing',  match: exact('packingcostpc'),        label: 'Packing cost/pc' },
  { key: 'type',     match: starts('packingtype'),         label: 'Packing Type' },
]

/** The finish sheet's product columns; everything to the right of the last one is a finish. */
const FINISH_PRODUCT_HEADINGS: readonly HeadingRule[] = [
  { key: 'code',     match: exact('code'),     label: 'Code' },
  { key: 'quantity', match: exact('quantity'), label: 'Quantity' },
  { key: 'image',    match: exact('representativeimage'), label: 'Representative Image' },
]

type Located =
  | { ok: true; row: number; cols: Record<string, number> }
  | { ok: false; detail: string }

/**
 * The first row (within the top of the sheet) on which every required heading
 * is found exactly once. The template puts them on row 1; a person may add a
 * title above, so a few rows are tried.
 */
function locateHeadings(sheet: PiSheet, rules: readonly HeadingRule[], required: readonly string[]): Located {
  const byRow = cellsByRow(sheet)
  let best: { row: number; missing: string[]; duplicated: string[] } | null = null
  for (let row = 1; row <= MAX_HEADING_ROW; row++) {
    const cells = byRow.get(row)
    if (!cells) continue
    const cols: Record<string, number> = {}
    const duplicated: string[] = []
    for (const cell of cells) {
      if (cell.type !== 'string' || !cell.text) continue
      const k = labelKey(cell.text)
      for (const rule of rules) {
        if (!rule.match(k)) continue
        if (rule.key in cols) duplicated.push(rule.label)
        else cols[rule.key] = cell.col
      }
    }
    const missing = required.filter(key => !(key in cols)).map(key => rules.find(r => r.key === key)?.label ?? key)
    if (missing.length === 0 && duplicated.length === 0) return { ok: true, row, cols }
    if (!best || missing.length + duplicated.length < best.missing.length + best.duplicated.length) {
      best = { row, missing, duplicated }
    }
  }
  const parts = best
    ? [...best.missing.map(l => `"${l}" was not found`), ...best.duplicated.map(l => `"${l}" appears more than once`)]
    : ['no headings were found']
  return { ok: false, detail: `${best ? `Closest is row ${best.row}: ` : ''}${parts.join('; ')}.` }
}

// ── Sheets ────────────────────────────────────────────────────────────────────

/** The declared sheet whose name matches, ignoring case and surrounding spaces. */
function findSheetName(sheetNames: readonly string[], wanted: string): string | null {
  const w = wanted.trim().toLowerCase()
  return sheetNames.find(n => n.trim().toLowerCase() === w) ?? null
}

type OpenedSheet =
  | { ok: true; sheet: PiSheet }
  | { ok: false; reason: 'missing' | 'unreadable'; detail: string }

function openSheet(entries: ArchiveEntries, sharedStrings: readonly string[], wanted: string): OpenedSheet {
  // resolveSheetPart matches the name exactly; find the declared spelling first.
  const probe = resolveSheetPart(entries, wanted)
  const name = probe.ok ? wanted : findSheetName(probe.sheetNames, wanted)
  if (name === null) {
    return { ok: false, reason: 'missing', detail: `This workbook has no sheet named "${wanted}".` }
  }
  const resolution = name === wanted && probe.ok ? probe : resolveSheetPart(entries, name)
  if (!resolution.ok) {
    return { ok: false, reason: 'unreadable', detail: `The "${wanted}" sheet is declared but its worksheet part could not be resolved.` }
  }
  const xml = partText(entries, resolution.part)
  if (!xml) {
    return { ok: false, reason: 'unreadable', detail: `The "${wanted}" worksheet part is empty or unreadable.` }
  }
  return { ok: true, sheet: readSheet(xml, sharedStrings) }
}

function readCostSheet(entries: ArchiveEntries, sharedStrings: readonly string[]): FabricFinishSheetReport<FabricFinishCostLine> {
  const opened = openSheet(entries, sharedStrings, COST_SHEET_NAME)
  if (!opened.ok) return { found: false, reason: opened.reason, detail: opened.detail, lines: [] }
  const located = locateHeadings(opened.sheet, COST_HEADINGS, ['code', 'quantity', 'metres', 'price', 'packing'])
  if (!located.ok) return { found: false, reason: 'headings', detail: located.detail, lines: [] }
  const { cols } = located
  const cell = (col: number | undefined, row: number) => (col === undefined ? undefined : opened.sheet.cells.get(addr(col, row)))
  const lines: FabricFinishCostLine[] = []
  for (let row = located.row + 1; row <= opened.sheet.maxRow; row++) {
    const quantity = numberOf(cell(cols.quantity, row))
    if (quantity === null || quantity <= 0) continue
    lines.push({
      sheetRow: row,
      code: codeOf(cell(cols.code, row)),
      quantity,
      fabricMetresPerPiece: nonNegative(numberOf(cell(cols.metres, row))),
      fabricPricePerMetre: nonNegative(numberOf(cell(cols.price, row))),
      packingCostPerPiece: nonNegative(numberOf(cell(cols.packing, row))),
      packingType: textOf(cell(cols.type, row)),
    })
  }
  return { found: true, headingRow: located.row, lines }
}

function readFinishSheet(entries: ArchiveEntries, sharedStrings: readonly string[]): FabricFinishSheetReport<FabricFinishSpecLine> {
  const opened = openSheet(entries, sharedStrings, FINISH_SHEET_NAME)
  if (!opened.ok) return { found: false, reason: opened.reason, detail: opened.detail, lines: [] }
  const located = locateHeadings(opened.sheet, FINISH_PRODUCT_HEADINGS, ['code', 'quantity', 'image'])
  if (!located.ok) return { found: false, reason: 'headings', detail: located.detail, lines: [] }
  const { cols } = located
  const sheet = opened.sheet
  // Every heading to the right of the picture column names a finish. "Material"
  // sometimes sits there too (a formula over the Master): it is a product
  // column, not a choice, and is left out.
  const headings: { col: number; heading: string }[] = []
  for (const c of sheet.cells.values()) {
    if (c.row !== located.row || c.col <= cols.image || c.type !== 'string' || !c.text) continue
    const heading = c.text.replace(/\s+/g, ' ').trim()
    if (heading === '' || labelKey(heading) === 'material') continue
    headings.push({ col: c.col, heading })
  }
  headings.sort((a, b) => a.col - b.col)
  const lines: FabricFinishSpecLine[] = []
  for (let row = located.row + 1; row <= sheet.maxRow; row++) {
    const quantity = numberOf(sheet.cells.get(addr(cols.quantity, row)))
    if (quantity === null || quantity <= 0) continue
    const specs: FabricFinishSpec[] = []
    for (const h of headings) {
      const c = sheet.cells.get(addr(h.col, row))
      // A formula here is a product column that was moved, not a typed choice.
      if (!c || c.hasFormula) continue
      const value = textOf(c)
      if (value !== null) specs.push({ heading: h.heading, value })
    }
    lines.push({ sheetRow: row, code: codeOf(sheet.cells.get(addr(cols.code, row))), quantity, specs })
  }
  return { found: true, headingRow: located.row, lines }
}

const nonNegative = (n: number | null): number | null => (n === null || n < 0 ? null : n)

function addr(col: number, row: number): string {
  let n = col + 1, letters = ''
  while (n > 0) { const m = (n - 1) % 26; letters = String.fromCharCode(65 + m) + letters; n = Math.floor((n - 1) / 26) }
  return `${letters}${row}`
}

/**
 * Read both sheets from an opened archive. Never throws for a sheet that is
 * absent or oddly headed: each report says so and carries no lines.
 */
export function readFabricFinishSheets(entries: ArchiveEntries): FabricFinishSheets {
  const sharedStrings = readSharedStrings(entries)
  return {
    cost: readCostSheet(entries, sharedStrings),
    finish: readFinishSheet(entries, sharedStrings),
  }
}

// ── Matching sheet rows to the Master's products ──────────────────────────────

export type FabricFinishForProduct = {
  /** The Master row the product was read from. */
  productRow: number
  itemSequence: string | null
  code: string | null
  cost: FabricFinishCostLine | null
  finish: FabricFinishSpecLine | null
}

export type FabricFinishMatch = {
  products: readonly FabricFinishForProduct[]
  /** Sheet rows that carry a product but match none of the Master's. */
  unmatched: readonly { sheet: 'cost' | 'finish'; sheetRow: number; code: string | null }[]
}

const normCode = (code: string | null | undefined): string => (code ?? '').replace(/\s+/g, '').toUpperCase()

/**
 * Pair each Master product with its row on each sheet: by the product code the
 * sheet row printed (a formula over the Master), else, when neither side has a
 * code, by the template's row offset. One sheet row serves one product.
 */
export function matchFabricFinishSheets(sheets: FabricFinishSheets, products: readonly PiProduct[]): FabricFinishMatch {
  const unmatched: { sheet: 'cost' | 'finish'; sheetRow: number; code: string | null }[] = []
  const pair = <L extends { sheetRow: number; code: string | null }>(sheet: 'cost' | 'finish', lines: readonly L[]) => {
    const byProduct = new Map<number, L>()
    const used = new Set<number>()
    // Codes first, so a moved row still finds its product.
    for (const p of products) {
      const want = normCode(p.sourceProductCode)
      if (want === '') continue
      const line = lines.find(l => !used.has(l.sheetRow) && normCode(l.code) === want)
      if (line) { byProduct.set(p.row, line); used.add(line.sheetRow) }
    }
    // Then the template's own offset, for rows without a code on either side.
    for (const p of products) {
      if (byProduct.has(p.row) || normCode(p.sourceProductCode) !== '') continue
      const line = lines.find(l => !used.has(l.sheetRow) && l.code === null && l.sheetRow + TEMPLATE_ROW_OFFSET === p.row)
      if (line) { byProduct.set(p.row, line); used.add(line.sheetRow) }
    }
    for (const l of lines) if (!used.has(l.sheetRow)) unmatched.push({ sheet, sheetRow: l.sheetRow, code: l.code })
    return byProduct
  }
  const cost = pair('cost', sheets.cost.lines)
  const finish = pair('finish', sheets.finish.lines)
  return {
    products: products.map(p => ({
      productRow: p.row,
      itemSequence: p.itemSequence,
      code: p.sourceProductCode,
      cost: cost.get(p.row) ?? null,
      finish: finish.get(p.row) ?? null,
    })),
    unmatched,
  }
}
