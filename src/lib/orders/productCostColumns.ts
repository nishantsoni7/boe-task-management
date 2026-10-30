// ── What the product list's F&P Cost and Approvals tabs add up to ────────────
//
// The product list has three tabs (owner, 2026-10-30): Product details, F&P Cost
// and Approvals. No cost shows until someone opens one of the last two.
//
// NOTHING IS CALCULATED HERE that fabricFinishCost.ts does not already decide:
// metres, amounts, the ₹10 rounding, "as applicable", typed-beats-sheet and what
// counts as approved all come from there, so the tabs and Edit PI can never
// disagree. This only sums them up and matches each sheet line to its product.

import {
  compareWithPi,
  finishFamilies,
  lineApproval,
  sheetTotals,
  type Comparison,
  type FabricFinishData,
  type FabricFinishLine,
} from './fabricFinishCost'

export const APPROVALS_LABEL = 'Fabric & finish'
export const NO_FABRIC_TEXT = 'No fabric'

/** The figures in the card's header while F&P Cost or Approvals is open. */
export type ProductCostSummary = {
  fabric: { rounded: number | null; sum: number; metres: number; products: number; comparison: Comparison }
  packing: { rounded: number | null; sum: number; products: number; comparison: Comparison }
  approvals: { approved: number; total: number; pending: number }
}

/**
 * The sheet line for one product row: by the item row's id first (the sheet
 * read keys every line by it), then by the item number.
 */
export function costLineFor(
  data: FabricFinishData | null,
  product: { id: string; itemSequence: string | null },
): FabricFinishLine | null {
  if (!data) return null
  return data.lines.find(l => l.itemId !== null && l.itemId === product.id)
    ?? (product.itemSequence ? data.lines.find(l => l.itemSequence === product.itemSequence) ?? null : null)
}

export function productCostSummary(data: FabricFinishData): ProductCostSummary {
  const totals = sheetTotals(data.lines)
  const families = finishFamilies(data.lines)
  const approved = data.lines.filter(l => lineApproval(l, families).state === 'approved').length
  return {
    fabric: {
      rounded: totals.fabric.rounded,
      sum: totals.fabric.sum,
      metres: totals.metres,
      products: totals.fabric.counted,
      comparison: compareWithPi(data.piFabricCost, totals.fabric),
    },
    packing: {
      rounded: totals.packing.rounded,
      sum: totals.packing.sum,
      products: totals.packing.counted,
      comparison: compareWithPi(data.piPackingCost, totals.packing),
    },
    approvals: { approved, total: data.lines.length, pending: data.lines.length - approved },
  }
}

/** "Matches the PI", "Differs from the PI by ₹10 more", or null when it cannot be said. */
export function comparisonText(comparison: Comparison, format: (n: number) => string): string | null {
  if (comparison.state === 'matches') return 'Matches the PI'
  if (comparison.state === 'differs' && comparison.difference !== null) {
    return `Differs from the PI by ${format(Math.abs(comparison.difference))} ${comparison.difference > 0 ? 'more' : 'less'}`
  }
  return null
}

/** "0 of 33 approved". */
export const approvalsText = (approvals: ProductCostSummary['approvals']): string =>
  `${approvals.approved} of ${approvals.total} approved`
