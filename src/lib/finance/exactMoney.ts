// ── Exact money arithmetic, for the one place the browser has to do any ───────
//
// THE PROBLEM THIS SOLVES
// -----------------------
// Every money figure on a PI comes from pi_submission_payment_summary(), which
// sums in `numeric` in the database. The Confirmed Order has no such function:
// its screen reads the payment rows and their allocations and adds them up in
// the browser. Until now it did that with `Number()` and `+`, which is binary
// floating point — so an Order and the PI it was approved from could print
// different totals for the same money, and the difference would be nobody's
// decision. `0.1 + 0.2 !== 0.3` is not a rounding preference; it is two modules
// disagreeing about what a client paid.
//
// This module is the fix: exact decimal arithmetic on the strings PostgREST
// already sends. `numeric` crosses the wire as a STRING precisely so it is not
// rounded by JSON's double, and every function here keeps it that way — a value
// becomes a JS `number` only at the formatting boundary, where it is about to
// become pixels and can no longer feed a decision.
//
// WHAT IT IS NOT
// --------------
// Not a general decimal library, and deliberately not a dependency. It supports
// exactly the four things the Order's finance position needs — add, subtract,
// compare, and a truncated percentage — and nothing else. There is no
// multiplication of two arbitrary decimals, no division outside the percentage,
// and no rounding mode to choose: `percentTrunc` states the one rule the
// database already states, in the one place a percentage is derived.
//
// WHAT IT DOES NOT DECIDE
// -----------------------
// Nothing. It is arithmetic. Which rows are summed, and whether the caller may
// see them at all, is RLS's answer and the calling module's — see
// orderFinancePosition.ts.

/**
 * An exact decimal: `units / 10^scale`.
 *
 * `scale` is never negative and is preserved rather than normalised, so a value
 * that arrived as "400000.00" still says it carries two decimal places. Two
 * decimals of different scale are aligned before any operation, so the result is
 * exact whatever scales went in.
 *
 * `bigint` and not `number`: the whole point is that no intermediate value is
 * ever a double.
 */
export type ExactDecimal = { units: bigint; scale: number }

// WHY THESE ARE CALLS AND NOT LITERALS. tsconfig targets ES2017, where the `0n`
// literal SYNTAX is a compile error — the `bigint` type and the `BigInt` global
// are available regardless, through `lib: esnext`. Constructing them once here
// keeps the whole repository's compiler target untouched for the sake of one
// module. Do not "tidy" these into literals without moving the target first.
const BIG_ZERO = BigInt(0)
const BIG_ONE = BigInt(1)
const NEG_ONE = BigInt(-1)
const BIG_TEN = BigInt(10)
const BIG_HUNDRED = BigInt(100)

export const ZERO: ExactDecimal = { units: BIG_ZERO, scale: 0 }

/**
 * The largest scale this module will parse.
 *
 * finance_payment_requests.amount is PLAIN `numeric` with no declared scale
 * (20260628000200), so a legacy row may in principle carry more than two
 * decimal places and this parser must not silently drop them. The cap exists
 * only so a malformed or hostile string cannot make a 10^n bigint the size of a
 * page of memory; it is far above any figure the business produces.
 */
const MAX_SCALE = 30

/** 10^n as a bigint, without going through a double. */
function pow10(n: number): bigint {
  let result = BIG_ONE
  for (let i = 0; i < n; i++) result *= BIG_TEN
  return result
}

/**
 * Parse a `numeric` as PostgREST sends it, or a JS number, into an exact value.
 *
 * Returns NULL — never a zero — for anything that is not a finite decimal:
 * null, undefined, '', 'NaN', 'Infinity', '12abc'. Zero would be a claim that
 * the amount is nothing, and "we could not read this figure" and "this figure
 * is nought" must never collapse into the same answer on a money screen.
 *
 * A JS `number` is accepted because `orders.total_value` reaches the Order
 * screen through a typed column that supabase-js has already widened to
 * `number`. It is converted through its own decimal string, which for a
 * numeric(12,2) value is exact; exponent notation is expanded rather than
 * refused, because String(1e21) is a legitimate way for a large integer to
 * print itself.
 */
export function parseExact(value: string | number | null | undefined): ExactDecimal | null {
  if (value === null || value === undefined) return null

  let text: string
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    text = expandExponent(String(value))
  } else {
    text = value.trim()
  }

  if (text === '') return null

  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text)
  if (!match) return null

  const [, sign, intPart, fracPart = ''] = match
  // "." and "" and "-" are not numbers. At least one digit must be present.
  if (intPart === '' && fracPart === '') return null
  if (fracPart.length > MAX_SCALE) return null

  const digits = `${intPart === '' ? '0' : intPart}${fracPart}`
  const units = BigInt(digits) * (sign === '-' ? NEG_ONE : BIG_ONE)
  return { units, scale: fracPart.length }
}

/**
 * Expand JS exponent notation into plain decimal digits.
 *
 * String(1e21) is "1e+21" and String(1e-7) is "1e-7"; both are exact values
 * that the plain-decimal parser above would reject. Only the shapes JS itself
 * produces are handled — this is not a general numeric-literal parser.
 */
function expandExponent(text: string): string {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text)
  if (!match) return text

  const [, sign, intPart, fracPart = '', expText] = match
  const exponent = Number(expText)
  const digits = intPart + fracPart
  // Where the point sits after shifting it by `exponent` places.
  const pointAt = intPart.length + exponent

  if (pointAt <= 0) return `${sign}0.${'0'.repeat(-pointAt)}${digits}`
  if (pointAt >= digits.length) return `${sign}${digits}${'0'.repeat(pointAt - digits.length)}`
  return `${sign}${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`
}

/** Both values restated at the same scale, so their units can be compared or added. */
function align(a: ExactDecimal, b: ExactDecimal): { a: bigint; b: bigint; scale: number } {
  if (a.scale === b.scale) return { a: a.units, b: b.units, scale: a.scale }
  const scale = Math.max(a.scale, b.scale)
  return {
    a: a.units * pow10(scale - a.scale),
    b: b.units * pow10(scale - b.scale),
    scale,
  }
}

export function addExact(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  const s = align(a, b)
  return { units: s.a + s.b, scale: s.scale }
}

export function subtractExact(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  const s = align(a, b)
  return { units: s.a - s.b, scale: s.scale }
}

/** -1, 0 or 1, exactly as a numeric comparison in the database would answer. */
export function compareExact(a: ExactDecimal, b: ExactDecimal): -1 | 0 | 1 {
  const s = align(a, b)
  if (s.a < s.b) return -1
  if (s.a > s.b) return 1
  return 0
}

export function isNegative(value: ExactDecimal): boolean {
  return value.units < BIG_ZERO
}

export function isZero(value: ExactDecimal): boolean {
  return value.units === BIG_ZERO
}

/**
 * The sum of a list, skipping anything unparseable.
 *
 * A row whose amount could not be read contributes NOTHING rather than zero-ing
 * the total or poisoning it — the same choice parseExact makes, carried through
 * to the aggregate. Callers that need to know a row was skipped count the
 * parseable rows themselves; no total here is silently short by a value it
 * pretends to include.
 */
export function sumExact(values: readonly (string | number | null | undefined)[]): ExactDecimal {
  let total: ExactDecimal = ZERO
  for (const value of values) {
    const parsed = parseExact(value)
    if (parsed) total = addExact(total, parsed)
  }
  return total
}

/** `max(value, 0)` — a pending balance is never a negative number on a screen. */
export function clampAtZero(value: ExactDecimal): ExactDecimal {
  return isNegative(value) ? { units: BIG_ZERO, scale: value.scale } : value
}

/**
 * `part` as a percentage of `whole`, TRUNCATED to `dp` decimal places.
 *
 * TRUNCATED AND NEVER ROUNDED, which is the rule the database already states
 * for order_submission_advance_percent_of() (20260917000000 §4) and applies in
 * pi_submission_payment_summary(): "Truncation cannot overstate." 39.999% rounds
 * to 40.00 and would print "40%" on a card beside a gate that refuses;
 * truncation prints 39.99 and the two agree.
 *
 * NULL when the percentage is not computable — a null or zero whole. Null means
 * "not computable" and is shown as a dash; returning 0 would read as "nothing
 * received", which is a different and possibly untrue statement.
 */
export function percentTrunc(
  part: ExactDecimal,
  whole: ExactDecimal | null,
  dp = 2,
): ExactDecimal | null {
  if (!whole || isZero(whole) || isNegative(whole)) return null

  const factor = pow10(dp)
  const aligned = align(part, whole)
  // (part / whole) * 100, carried to `dp` places, in one integer division so no
  // intermediate is ever inexact. Both operands are at the same scale, so the
  // scale factors cancel and only the units divide.
  const numerator = aligned.a * BIG_HUNDRED * factor
  const quotient = numerator / aligned.b

  // BigInt division truncates toward zero, which for a non-negative part is the
  // floor the database's trunc() reaches. A negative part cannot arise from a
  // sum of allocations (each is CHECK-constrained > 0), and if one ever did,
  // truncation toward zero is still the conservative direction.
  return { units: quotient, scale: dp }
}

/**
 * The canonical decimal string — the form the value would have come back as.
 *
 * This is what a test asserts against and what a caller stores; it never goes
 * through a double, so "1234567890123.45" survives intact where Number() would
 * already have lost digits on a large enough figure.
 */
export function exactToString(value: ExactDecimal): string {
  const negative = value.units < BIG_ZERO
  const digits = (negative ? -value.units : value.units).toString()

  if (value.scale === 0) return `${negative ? '-' : ''}${digits}`

  const padded = digits.padStart(value.scale + 1, '0')
  const intPart = padded.slice(0, padded.length - value.scale)
  const fracPart = padded.slice(padded.length - value.scale)
  return `${negative ? '-' : ''}${intPart}.${fracPart}`
}

/**
 * THE FORMATTING BOUNDARY, and the only place a double appears.
 *
 * Called when the value is about to become pixels. Everything upstream of this
 * is exact; nothing downstream of it feeds a decision. Kept as a named function
 * rather than an inline Number() so that "where does this stop being exact?" has
 * one answer a reader can grep for.
 */
export function exactToNumber(value: ExactDecimal): number {
  return Number(exactToString(value))
}
