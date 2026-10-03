// ── THE ADVANCE FORMULA — one definition for every screen and route ───────────
//
//   Subtotal         = Product value before discount − Discount
//   Total before GST = Subtotal + Fabric amount + Packaging + quoted Transportation
//   Grand Total      = Total before GST + GST
//   Advance %        = VERIFIED advance ÷ Total before GST × 100
//   Required advance = 40% of Total before GST
//
// THE DENOMINATOR IS THE COMPLETE PRE-GST AMOUNT. Not the product value alone
// and not the Grand Total: GST is collected on the client's behalf and is not
// part of what the order is worth to BOE, and a product value that leaves out
// fabric, packaging and quoted transport understates what is being sold.
//
// BOE TRANSCRIBES THE PRE-GST TOTAL; IT DOES NOT RE-ADD IT. total_before_gst is
// the workbook's own I120 (see 20261002000000), the parser checks it against
// the rows and keeps the workbook's figure, and the database stores it. This
// module therefore takes that stored figure as the base — the same figure the
// database functions in 20270226000000 take — so a screen and a gate cannot
// disagree about which number 40% is taken of. Transportation written in words
// ("as applicable") carries no amount and adds nothing; only a quoted figure is
// inside the stored total.
//
// THE NUMERATOR IS NOT DECIDED HERE. Callers hand in the VERIFIED advance —
// finance-verified allocations only (finance_payment_status_is_verified). A
// pending, clarification-needed, rejected or reversed payment is simply never
// passed in, which is why nothing here knows the word "pending".
//
// EVERYTHING IS EXACT. Money goes through exactMoney's decimals, never a double,
// and the percentage is TRUNCATED, never rounded — the rule the database states
// for order_submission_advance_percent_of: 39.999% must not print as 40%.
//
// UNAVAILABLE IS NOT ZERO. A missing, zero, negative or non-numeric base has no
// percentage and no requirement: every function returns null for it, and
// `meetsStandardAdvance` returns false. A calculation that cannot be made never
// satisfies an approval requirement, and nothing here can return NaN or Infinity.

import {
  ZERO,
  addExact,
  compareExact,
  exactToString,
  isNegative,
  isZero,
  parseExact,
  percentTrunc,
  subtractExact,
  type ExactDecimal,
} from '@/lib/finance/exactMoney'

/** The standard advance, as a percentage of the Total before GST. */
export const STANDARD_ADVANCE_PERCENT = 40

/** What a figure that cannot be derived says. Never 0%, which is a claim. */
export const ADVANCE_UNAVAILABLE = 'Not available'

export type AdvanceAmountInput = string | number | null | undefined

const BIG_ZERO = BigInt(0)
const BIG_ONE = BigInt(1)
const BIG_TEN = BigInt(10)

/**
 * The base the advance is measured against: the Total before GST, when it is a
 * real, positive figure. Null otherwise — "no base", not "base of zero".
 */
export function advanceBase(totalBeforeGst: AdvanceAmountInput): ExactDecimal | null {
  const base = parseExact(totalBeforeGst)
  if (!base || isZero(base) || isNegative(base)) return null
  return base
}

/** The verified advance as an exact amount; unreadable counts as nothing received. */
function verifiedAmount(verified: AdvanceAmountInput): ExactDecimal {
  const amount = parseExact(verified)
  return amount && !isNegative(amount) ? amount : ZERO
}

/** `part` as an exact percentage of `base`, truncated to two places, or null. */
export function advancePercentExact(
  verified: AdvanceAmountInput,
  totalBeforeGst: AdvanceAmountInput,
): ExactDecimal | null {
  const base = advanceBase(totalBeforeGst)
  if (!base) return null
  return percentTrunc(verifiedAmount(verified), base)
}

/** `42.65`, or null when there is no base to take a percentage of. */
export function advancePercent(
  verified: AdvanceAmountInput,
  totalBeforeGst: AdvanceAmountInput,
): string | null {
  const percent = advancePercentExact(verified, totalBeforeGst)
  return percent ? exactToString(percent) : null
}

/**
 * The exact requirement: `percent`% of the base, to full precision. Null for no
 * base. (A base has at most two decimals and the percentage is whole, so this
 * is exact at four.)
 */
export function requiredAdvanceExact(
  totalBeforeGst: AdvanceAmountInput,
  percent: number = STANDARD_ADVANCE_PERCENT,
): ExactDecimal | null {
  const base = advanceBase(totalBeforeGst)
  if (!base || !Number.isFinite(percent) || percent < 0) return null
  const scaled = parseExact(String(percent))
  if (!scaled) return null
  // base × percent ÷ 100, kept exact by moving the divisor into the scale.
  return { units: base.units * scaled.units, scale: base.scale + scaled.scale + 2 }
}

/** Rounded UP to whole paise, so the figure shown is always one that satisfies. */
function ceilToPaise(value: ExactDecimal): ExactDecimal {
  if (value.scale <= 2) return value
  const divisor = BIG_TEN ** BigInt(value.scale - 2)
  let units = value.units / divisor
  if (value.units % divisor > BIG_ZERO) units += BIG_ONE
  return { units, scale: 2 }
}

/** The smallest payable amount that meets the requirement, e.g. `48000.00`. */
export function requiredAdvance(
  totalBeforeGst: AdvanceAmountInput,
  percent: number = STANDARD_ADVANCE_PERCENT,
): string | null {
  const required = requiredAdvanceExact(totalBeforeGst, percent)
  return required ? exactToString(ceilToPaise(required)) : null
}

/**
 * How much MORE verified advance is needed, to whole paise and never below
 * zero. Null when there is no base: an unknown requirement has no shortfall.
 */
export function advanceShortfall(
  verified: AdvanceAmountInput,
  totalBeforeGst: AdvanceAmountInput,
  percent: number = STANDARD_ADVANCE_PERCENT,
): string | null {
  const required = requiredAdvanceExact(totalBeforeGst, percent)
  if (!required) return null
  const gap = subtractExact(required, verifiedAmount(verified))
  return exactToString(isNegative(gap) || isZero(gap) ? { units: BIG_ZERO, scale: 2 } : ceilToPaise(gap))
}

/**
 * Has the verified advance reached the standard 40% of the Total before GST?
 *
 * FALSE when the base is missing, zero or unreadable. An invalid calculation
 * must not satisfy an approval requirement, and "no requirement could be
 * worked out" is not "requirement met".
 */
export function meetsStandardAdvance(
  verified: AdvanceAmountInput,
  totalBeforeGst: AdvanceAmountInput,
): boolean {
  const required = requiredAdvanceExact(totalBeforeGst)
  if (!required) return false
  return compareExact(verifiedAmount(verified), required) >= 0
}

/** `42.65%`, or the unavailable wording. Never NaN, Infinity or an invented 0%. */
export function advancePercentLabel(
  verified: AdvanceAmountInput,
  totalBeforeGst: AdvanceAmountInput,
): string {
  const percent = advancePercent(verified, totalBeforeGst)
  return percent === null ? ADVANCE_UNAVAILABLE : `${trimPercent(percent)}%`
}

/** `40.00` → `40`, `42.60` → `42.6`: the way the rest of the app writes them. */
function trimPercent(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

/**
 * The Total before GST from its parts — for the checks and fixtures that need
 * to prove the formula, NOT for storing. Null when the Subtotal is missing; a
 * missing fabric, packaging or transport figure counts as ABSENT (adds nothing)
 * and is never turned into a recorded zero by this function's caller, because
 * `recorded` says which parts were actually present.
 */
export function totalBeforeGstFromParts(parts: {
  subtotal: AdvanceAmountInput
  fabric?: AdvanceAmountInput
  packaging?: AdvanceAmountInput
  /** Only an explicitly quoted amount. "As applicable" is not an amount. */
  transportation?: AdvanceAmountInput
}): { total: string; recorded: { fabric: boolean; packaging: boolean; transportation: boolean } } | null {
  const subtotal = parseExact(parts.subtotal)
  if (!subtotal) return null
  let total = subtotal
  const recorded = { fabric: false, packaging: false, transportation: false }
  for (const key of ['fabric', 'packaging', 'transportation'] as const) {
    const amount = parseExact(parts[key])
    if (amount) {
      recorded[key] = true
      total = addExact(total, amount)
    }
  }
  return { total: exactToString(total), recorded }
}
