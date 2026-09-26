/**
 * THE DEDUCTION ROW ON THE GENERATED CLIENT PI — one rule, no choice.
 *
 * BOE's standard PI labels the row above the subtotal "Design Fee" and usually
 * leaves it blank. When a discount is actually offered, Sales changes the
 * wording to "Discount". EITHER WAY THE FIGURE IS A DEDUCTION: the workbook
 * subtracts it (I116 = I114 − I115) and so does every screen and document
 * here.
 *
 * THE CONVENTION (20270122000000):
 *
 *   zero or blank   the row is LEFT OFF the generated client PI
 *   non-zero        the row is printed as "Discount" — never "Design Fee" —
 *                   whatever the workbook called it
 *
 * The figure and the arithmetic never change; only which rows appear and the
 * one word. `discount_label` keeps the wording the workbook printed, for
 * provenance only, so the PI page can warn when the UPLOADED FILE (which is
 * never changed, and which a client may also be sent) says something else.
 */

export const DEDUCTION_LABEL = 'Discount'
export const SUBTOTAL_AFTER_DEDUCTION_LABEL = 'Subtotal after discount'

/** "Design Fee", "Design Fees", "design fee :" … — the template's default wording. */
export function isDesignFeeWording(label: string): boolean {
  return /^\s*design\s*fees?\b/i.test(label)
}

export function isDiscountWording(label: string): boolean {
  return /^\s*(less\s*[:\-]?\s*)?discount\b/i.test(label)
}

const numeric = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** True when there is a deduction worth printing at all. */
export function hasDeduction(amount: number | string | null | undefined): boolean {
  const n = numeric(amount)
  return n !== null && n !== 0
}

/**
 * THE GENERATED PI'S COMMERCIAL ROWS: the shared builder's rows (figures
 * untouched), with the deduction row printed as "Discount" when non-zero and
 * REMOVED when zero or blank. Nothing is recomputed; rows are only dropped and
 * the one label fixed.
 */
export function clientDeductionRows<R extends { key: string; label: string }>(
  rows: readonly R[],
  input: { amount: number | string | null | undefined },
): R[] {
  const present = hasDeduction(input.amount)
  return rows
    .filter(row => present || row.key !== 'discount')
    .map(row => {
      if (row.key === 'discount') return { ...row, label: DEDUCTION_LABEL }
      if (row.key === 'subtotal') return { ...row, label: SUBTOTAL_AFTER_DEDUCTION_LABEL }
      return row
    })
}

export type DiscountWordingKind = 'none' | 'consistent' | 'design_fee' | 'other' | 'unknown'

export type DiscountWording = {
  kind: DiscountWordingKind
  /** Null when there is nothing for anyone to check. */
  notice: string | null
}

/**
 * WHERE THE UPLOADED WORKBOOK'S WORDING NEEDS A HUMAN. The generated PI always
 * says "Discount" for a non-zero deduction; the uploaded file is never changed,
 * and a client may also be sent it — so a workbook that says anything else, or
 * whose wording is not on record, is flagged before either goes out.
 */
export function classifyDiscountWording(input: {
  amount: number | null | undefined
  /**
   * Null covers two cases the record cannot tell apart — a blank label cell,
   * and a PI uploaded before 20270122000000 recorded the wording — and both get
   * the same instruction: look at the workbook.
   */
  label: string | null | undefined
  formatAmount: (n: number) => string
}): DiscountWording {
  const amount = typeof input.amount === 'number' && Number.isFinite(input.amount) ? input.amount : 0
  if (amount === 0) return { kind: 'none', notice: null }
  const shown = input.formatAmount(amount)
  const label = (input.label ?? '').trim()

  if (!label) {
    return {
      kind: 'unknown',
      notice: `This PI deducts ${shown}. The generated PI prints it as "Discount", but the uploaded workbook's wording for that row is not on record. Check the workbook says "Discount" before it is shared with the client.`,
    }
  }
  if (isDiscountWording(label)) return { kind: 'consistent', notice: null }
  if (isDesignFeeWording(label)) {
    return {
      kind: 'design_fee',
      notice: `The uploaded workbook labels the ${shown} deduction "${label}". The generated PI prints it as "Discount". Correct the workbook to "Discount" before sharing the original file with the client.`,
    }
  }
  return {
    kind: 'other',
    notice: `The uploaded workbook labels the ${shown} deduction "${label}". The generated PI prints it as "Discount". Check the workbook before sharing it with the client.`,
  }
}
