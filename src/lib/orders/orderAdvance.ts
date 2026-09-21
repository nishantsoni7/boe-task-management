// HOW MUCH OF THIS ORDER IS ACTUALLY PAID FOR — as an operational indicator.
//
// WHAT THIS MODULE IS FOR
// -----------------------
// The status workspace states one figure: the share of the final Order Value
// that Finance has VERIFIED and that is genuinely allocated to this Order.
// 35% or more reads Safe; below 35% reads Risky.
//
// IT COMPUTES NO MONEY. Every figure below is buildOrderFinancePosition's, and
// `verifiedPercent` is already exactly the quantity this card wants:
//
//     verified allocated share ÷ orders.total_value × 100
//
// where `verified` counts only rows isVerifiedPaymentStatus() admits, at the
// share attributeToTarget() derives from this Order's own ACTIVE allocations.
// Pending money, money in clarification, refused money, money with no
// allocation and money allocated somewhere else are all already excluded there,
// truncated to two decimals, and null when the Order carries no value. A second
// arithmetic path here is precisely the thing that would let the Order screen
// and the Finance module print different percentages for the same payments.
//
// THE THRESHOLD IS A LABEL, NOT A GATE.
//
// BOE requires a verified advance of 40%, or an approved exception, BEFORE a PI
// may become a Confirmed Order. That rule lives in the approval path and is not
// touched, read or restated here. This 35% line is a different thing for a
// different reader: an operations indicator on an Order that already exists,
// telling somebody glancing at the workspace whether the money behind it is
// thin. Nothing on this page decides anything from it.

import type { OrderFinancePosition } from '@/lib/finance/orderFinancePosition'

// ── Words ─────────────────────────────────────────────────────────────────────

export const ADVANCE_TITLE = 'Advance Received'
export const ADVANCE_AMOUNT_LABEL = 'Received'
export const ADVANCE_ORDER_VALUE_LABEL = 'Order value'
export const ADVANCE_PERCENT_LABEL = 'Advance received'

/** What a figure that cannot be derived says. Never 0%, which is a claim. */
export const ADVANCE_NOT_AVAILABLE = 'Not available'

export const ADVANCE_RISKY_LABEL = 'Risky'
export const ADVANCE_SAFE_LABEL = 'Safe'

/**
 * The line between the two labels, in percent.
 *
 * REACHING IT IS SAFE; ONLY FALLING SHORT IS RISKY. Exactly 35.00 reads Safe,
 * because the business states this as a MINIMUM the advance has to reach — and
 * a minimum that an exact hit fails is not a minimum, it is 35-point-something.
 * 34.99 is short of it and reads Risky.
 */
export const ADVANCE_SAFE_THRESHOLD_PERCENT = 35

export const ADVANCE_NOTE_VERIFIED =
  'Verified payments allocated to this Order, against its final Order Value.'
export const ADVANCE_NOTE_NO_VALUE =
  'This Order carries no value, so a percentage cannot be derived.'

// ── The standing ──────────────────────────────────────────────────────────────

export type AdvanceClassification = {
  label: string
  tone: 'green' | 'red'
  /** True for Safe. Kept so a caller never has to compare the label text. */
  safe: boolean
}

export type AdvanceStanding = {
  /** The raw percentage as the shared position produced it, or null. */
  percent: string | null
  /** `42.65%`, or the not-available wording. */
  percentLabel: string
  /** Verified money allocated to this Order, formatted. */
  verifiedAmount: string
  /** orders.total_value, formatted — or null when the Order has none. */
  orderValue: string | null
  /** Null exactly when the percentage could not be derived. */
  classification: AdvanceClassification | null
  note: string
}

/**
 * Risky or Safe, from a percentage the finance position already derived.
 *
 * NULL IN, NULL OUT. An Order with no value, or one whose value is zero, has no
 * percentage — and an indicator that called that Risky would be reporting a
 * payment problem where there is only a missing figure.
 *
 * NOTHING IS CAPPED. A genuinely overpaid Order reads its real percentage:
 * 120% is a fact somebody needs to see, and quietly showing 100% would hide a
 * misallocation at the exact moment it matters.
 */
export function classifyAdvance(percent: string | null): AdvanceClassification | null {
  if (percent === null || percent.trim() === '') return null
  // Number('') is 0, not NaN. Without the guard above, a record with no
  // percentage would be classified Risky — a payment problem reported where
  // there is only a missing figure.
  const value = Number(percent)
  if (!Number.isFinite(value)) return null

  return value >= ADVANCE_SAFE_THRESHOLD_PERCENT
    ? { label: ADVANCE_SAFE_LABEL, tone: 'green', safe: true }
    : { label: ADVANCE_RISKY_LABEL, tone: 'red', safe: false }
}

/**
 * Everything the card prints, from the position and the page's own formatters.
 *
 * The two formatters are handed in rather than imported so this module states
 * no opinion about how money or a percentage looks — the page already has one,
 * shared with Finance and the PI screens.
 */
export function advanceStanding(input: {
  finance: OrderFinancePosition
  /** The page's money formatter — formatMoney, unchanged. */
  formatAmount: (value: string | number | null) => string
  /** The page's percentage formatter — formatPercent, unchanged. */
  formatPercent: (value: string | number | null) => string
}): AdvanceStanding {
  const { finance, formatAmount, formatPercent } = input
  const percent = finance.verifiedPercent

  return {
    percent,
    percentLabel: percent === null ? ADVANCE_NOT_AVAILABLE : formatPercent(percent),
    verifiedAmount: formatAmount(finance.verified),
    orderValue: finance.orderValue === null ? null : formatAmount(finance.orderValue),
    classification: classifyAdvance(percent),
    note: percent === null ? ADVANCE_NOTE_NO_VALUE : ADVANCE_NOTE_VERIFIED,
  }
}
