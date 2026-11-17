// ── OLD ORDERS: the few things an older PI sheet words differently ─────────────
//
// Orders 300 and up were copied out of ClickUp as the PI workbooks their sales
// people filled in, before the template settled. They are READ for display
// (Draft Orders, never uploaded), so this is only used when the caller says
// `oldOrder: true`; a PI being uploaded today stays exactly as strict as it was.
//
// What it forgives, on the sheet's own header row (the one with Code / Name /
// Quantity in A, B, C):
//   • "Dimensions / Shape (In Inches WxDxH)" for "Dimension in inches & Shape".
//   • Column H under any other name ("CP Teak Wood Price", "Sample cost"): it is
//     the price the line total in column I is made from, wherever it is named.
//   • Column K that is not headed "Customization". Headed "Remarks" or left
//     blank, its text stays as the customization. Headed anything else it holds
//     something else (a second price, "Bulk Production Pricing"), so it is
//     emptied and never shown as customization.
//
// What it never forgives: prices in dollars or euros. An export sheet is left
// untouched, so the strict gate refuses it and the page says why.

import { normalizeLabel, type PiCell, type PiSheet } from './workbookReader'

const MAX_ROW = 80
const PRODUCT_BAND_ROWS = 80
const COL_CODE = 0, COL_NAME = 1, COL_QUANTITY = 2, COL_DIMENSIONS = 3
const COL_PRICE = 7, COL_TOTAL = 8, COL_CUSTOMIZATION = 10

const DIMENSIONS_LABEL = 'Dimension in inches & Shape'
const PRICE_LABEL = 'Cost per piece (INR)'
const CUSTOMIZATION_LABEL = 'Customization'

/** A heading that says the figures are not rupees. */
export const FOREIGN_CURRENCY = /usd|euro|dollar/i

const colLetter = (col: number) => String.fromCharCode(65 + col)

function labelAt(sheet: PiSheet, row: number, col: number): string | null {
  const cell = sheet.cells.get(`${colLetter(col)}${row}`)
  return cell && cell.type === 'string' && cell.text !== null ? cell.text : null
}

const norm = (text: string | null) => (text === null ? '' : normalizeLabel(text))

function findHeaderRow(sheet: PiSheet): number | null {
  for (let row = 1; row <= MAX_ROW; row++) {
    if (norm(labelAt(sheet, row, COL_CODE)) === 'code'
      && norm(labelAt(sheet, row, COL_NAME)) === 'name'
      && norm(labelAt(sheet, row, COL_QUANTITY)) === 'quantity') return row
  }
  return null
}

const stringCell = (row: number, col: number, text: string): PiCell => ({
  address: `${colLetter(col)}${row}`, row, col, type: 'string', text, number: null, hasFormula: false, hasCachedValue: true,
})

/** The sheet with those headings worded the way the strict reader expects; the same object when nothing applies. */
export function adaptLegacySheet(sheet: PiSheet): PiSheet {
  const row = findHeaderRow(sheet)
  if (row === null) return sheet

  const price = labelAt(sheet, row, COL_PRICE)
  const total = labelAt(sheet, row, COL_TOTAL)
  const custom = labelAt(sheet, row, COL_CUSTOMIZATION)
  if ([price, total, custom].some(t => t !== null && FOREIGN_CURRENCY.test(t))) return sheet

  const cells = new Map(sheet.cells)
  // A column already carrying the proper heading somewhere else on the row is left alone: a second one would make it ambiguous.
  const rowHas = (label: string) => [...sheet.cells.values()].some(c => c.row === row && c.type === 'string' && norm(c.text) === norm(label))
  const dimensions = norm(labelAt(sheet, row, COL_DIMENSIONS))
  if (dimensions.startsWith('dimension') && dimensions !== norm(DIMENSIONS_LABEL) && !rowHas(DIMENSIONS_LABEL)) {
    cells.set(`D${row}`, stringCell(row, COL_DIMENSIONS, DIMENSIONS_LABEL))
  }
  if (norm(price) !== norm(PRICE_LABEL) && !rowHas(PRICE_LABEL)) cells.set(`H${row}`, stringCell(row, COL_PRICE, PRICE_LABEL))

  if (norm(custom) !== norm(CUSTOMIZATION_LABEL) && !rowHas(CUSTOMIZATION_LABEL)) {
    cells.set(`K${row}`, stringCell(row, COL_CUSTOMIZATION, CUSTOMIZATION_LABEL))
    const keepsText = custom === null || /remark|remak/i.test(custom)
    if (!keepsText) for (let r = row + 1; r <= row + PRODUCT_BAND_ROWS; r++) cells.delete(`K${r}`)
  }
  return { ...sheet, cells }
}
