// ── Fabric and packing beside each product (owner, 2026-10-30) ───────────────
//
// The PI Draft page's product list carries each line's fabric and packing from
// the Fabric & Finish cost sheet, with three figures above the table: the fabric
// total, the packing total and how many products have their fabric and finish
// approved. The owner wanted the cost sheet "merged with the product list, where
// it is easy to track".
//
// NOTHING IS CALCULATED HERE that fabricFinishCost.ts does not already decide:
// metres, amounts, the ₹10 rounding, "as applicable", typed-beats-sheet and what
// counts as an approved finish all come from there, so this list, the cost
// sheet and Edit PI can never disagree. This only picks the figures out and
// matches each sheet line to its product row.

import {
  compareWithPi,
  effective,
  effectiveFinish,
  finishIsDone,
  lineFigures,
  sheetTotals,
  type Comparison,
  type FabricFinishData,
  type FabricFinishLine,
} from './fabricFinishCost'

export const COST_SHEET_GROUP_LABEL = 'From the cost sheet'
export const APPROVALS_LABEL = 'Fabric & finish approvals'
export const APPROVAL_PENDING_TEXT = 'Approval pending'
export const NO_FABRIC_TEXT = 'No fabric'

/** One product's fabric and packing, as the cost sheet has them. */
export type ProductCost = {
  fabricAmount: number | null
  /** Total metres for the line (metres per piece × quantity). */
  metres: number | null
  pricePerMetre: number | null
  packingAmount: number | null
  packingType: string | null
  packingPerPiece: number | null
  /**
   * The fabric choice (or, with none, the first finish choice): its words when
   * it is approved, or pending. Null when the sheet records no choice at all.
   */
  choice: { text: string; done: boolean } | null
}

/** The three figures over the table. */
export type ProductCostSummary = {
  fabric: { rounded: number | null; sum: number; metres: number; products: number; comparison: Comparison }
  packing: { rounded: number | null; sum: number; products: number; comparison: Comparison }
  approvals: {
    done: number
    total: number
    /** "B004 Lounge armchair" for each product whose fabric and finish are not approved yet. */
    pending: string[]
  }
}

const FABRIC_HEADING = /fabric/i

export function productCost(line: FabricFinishLine): ProductCost {
  const figures = lineFigures(line)
  const finish = effectiveFinish(line).map(f => f.entry)
  const pick = finish.find(f => FABRIC_HEADING.test(f.heading)) ?? finish[0] ?? null
  const choiceText = pick ? pick.value.trim() : ''
  return {
    fabricAmount: figures.fabricAmount,
    metres: figures.metres,
    pricePerMetre: effective(line, 'fabricPricePerMetre').value,
    packingAmount: figures.packingAmount,
    packingType: effective(line, 'packingType').value,
    packingPerPiece: effective(line, 'packingCostPerPiece').value,
    choice: pick === null
      ? null
      : finishIsDone(choiceText) ? { text: choiceText, done: true }
      : { text: choiceText, done: false },
  }
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

const productName = (line: FabricFinishLine): string =>
  [line.itemSequence, line.productName].filter(Boolean).join(' ').trim() || 'A product'

export function productCostSummary(data: FabricFinishData): ProductCostSummary {
  const totals = sheetTotals(data.lines)
  const figures = data.lines.map(lineFigures)
  const pending = data.lines.filter((_, i) => figures[i].finishMissing).map(productName)
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
    approvals: { done: data.lines.length - pending.length, total: data.lines.length, pending },
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

/** "1 pending: B004 Lounge armchair", "3 pending", or "All approved". */
export function approvalsLine(approvals: ProductCostSummary['approvals']): string {
  if (approvals.total === 0) return 'No products'
  if (approvals.pending.length === 0) return 'All approved'
  if (approvals.pending.length === 1) return `1 pending: ${approvals.pending[0]}`
  return `${approvals.pending.length} pending`
}
