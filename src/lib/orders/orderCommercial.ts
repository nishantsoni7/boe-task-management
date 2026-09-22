// THE CONFIRMED ORDER'S COMMERCIAL BREAKDOWN — one presentation, and no
// arithmetic on the figures themselves.
//
// WHAT THIS MODULE IS FOR
// -----------------------
// /orders/[id] used to state the money twice over: a `Product value` /
// `Order value` pair of totals, and the full PI breakdown underneath it that
// opens and closes on those same two figures. A reader comparing the two had no
// way to know they were the same rupees. There is now ONE commercial
// presentation, and this decides its shape.
//
// IT COMPUTES NO MONEY. Every line's amount is the string the shared PI row
// builder already produced (buildCommercialRows -> commercialBreakdownRows),
// and this module only decides three things about each one:
//
//   role   whether the line is the opening product value, a factor that moves
//          it, a running total on the way, or the final Order value
//   sign   whether that factor is taken off or added on
//   column which of the two money columns it belongs in, so a factor can never
//          be mistaken for a running total
//
// AND IT NOW DERIVES NOTHING AT ALL. A `Net effect on product value` line used
// to close the section with a display subtraction of the Order's two stored
// columns. It has been removed as a presentation decision: the breakdown already
// opens on the product value, states every factor that moves it with its own
// sign, and closes on the final Order value, so the difference between the first
// row and the last was a figure the section restated rather than revealed.
//
// NOTHING ABOUT THE MONEY CHANGED WITH IT. No stored column, no commercial
// formula and no rounding rule was touched to remove that line — the
// subtraction simply has no reader any more, so it is gone rather than hidden.

import type { PiAmountRow, PiValueKind } from '@/lib/pi/previewView'

export const ORDER_COMMERCIAL_TITLE = 'Commercial breakdown'

/** What a line IS, which is what decides its column, its weight and its sign. */
export type CommercialRole = 'base' | 'deduction' | 'addition' | 'running' | 'final'

export type CommercialLine = {
  key: string
  label: string
  /** Already formatted upstream. Never re-formatted, never re-rounded. */
  value: string
  kind: PiValueKind
  role: CommercialRole
  /** Drawn BESIDE the amount, never folded into it. Null when nil or unknown. */
  sign: '−' | '+' | null
  /** A hairline opens a new group above this line. */
  groupStart: boolean
  note: string | null
}

/**
 * Every key the shared builder emits, and what it means to an Order reader.
 *
 * THE OPENING AND CLOSING LINES ARE RENAMED for this screen. The PI calls them
 * `Gross product amount` and `Grand Total`, which are the workbook's words. An
 * Order reader is asking what the products came to and what the Order is worth.
 * The figures are byte-identical either way; only the caption suits its reader.
 *
 * A key this map does not know is drawn as an ordinary line with NO sign. It is
 * better to state a factor without claiming a direction than to claim the wrong
 * one because a row was added upstream.
 */
const ROLE: Record<string, { role: CommercialRole; label?: string }> = {
  gross:          { role: 'base',      label: 'Product value' },
  discount:       { role: 'deduction' },
  subtotal:       { role: 'running' },
  fabric:         { role: 'addition' },
  packing:        { role: 'addition' },
  transportation: { role: 'addition' },
  beforeGst:      { role: 'running' },
  gst:            { role: 'addition' },
  grandTotal:     { role: 'final',     label: 'Order value' },
}

export const PRODUCT_VALUE_LABEL = ROLE.gross.label as string
export const ORDER_VALUE_LABEL = ROLE.grandTotal.label as string

/** `₹0` exactly — what formatInr prints for a nil amount. A nil factor takes no
 *  sign: `− ₹0` reads as a deduction that is not one. */
const isNil = (value: string): boolean => value.trim() === '₹0'

function signOf(role: CommercialRole, row: PiAmountRow): '−' | '+' | null {
  if (role !== 'deduction' && role !== 'addition') return null
  // Only a real amount carries a direction. `Included`, `Not applicable`, a
  // worded cell and a missing one each state something other than a figure.
  if (row.kind !== 'amount') return null
  if (isNil(row.value)) return null
  // An amount the formatter already signed keeps its own sign rather than
  // collecting a second one.
  const shown = row.value.trim()
  if (shown.startsWith('−') || shown.startsWith('-') || shown.startsWith('+')) return null
  return role === 'deduction' ? '−' : '+'
}

/**
 * The lines, in the order the calculation runs.
 *
 * NOTHING IS REORDERED. buildCommercialRows already emits the workbook's own
 * sequence — product value, discount, subtotal, the three costs, the pre-tax
 * total, tax, the total — and reordering a calculation is how it stops reading
 * as one. This maps each row where it stands.
 */
export function orderCommercialLines(rows: readonly PiAmountRow[]): CommercialLine[] {
  return rows.map(row => {
    const known = Object.prototype.hasOwnProperty.call(ROLE, row.key)
    const meta = known ? ROLE[row.key] : { role: 'addition' as CommercialRole }
    return {
      key: row.key,
      label: meta.label ?? row.label,
      value: row.value,
      kind: row.kind,
      role: meta.role,
      sign: known ? signOf(meta.role, row) : null,
      groupStart: row.groupStart === true,
      note: row.note ?? null,
    }
  })
}

// ── The fallback for an Order that never came from a PI ───────────────────────

/**
 * The two lines an Order with no approved PI can still state.
 *
 * WITHOUT THIS, removing the totals block would leave such an Order with no
 * commercial statement at all — a regression dressed as a simplification. The
 * breakdown's middle is genuinely unknown for these Orders (there is no PI to
 * read a discount or a tax off), so it is not invented: the two stored figures
 * are stated, and nothing else.
 */
export function orderStoredCommercialLines(input: {
  /** Already formatted by the page's money helper. */
  productValue: string
  orderValue: string
}): CommercialLine[] {
  return [
    {
      key: 'gross', label: PRODUCT_VALUE_LABEL, value: input.productValue,
      kind: 'amount', role: 'base', sign: null, groupStart: false, note: null,
    },
    {
      key: 'grandTotal', label: ORDER_VALUE_LABEL, value: input.orderValue,
      kind: 'amount', role: 'final', sign: null, groupStart: true, note: null,
    },
  ]
}
