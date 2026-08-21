// ── The billing percentage, and the one rule that decides whether a PI has one ─
//
// WHAT THIS IS FOR
// ----------------
// `order_submissions.billing_percentage` records how much of the PRE-GST value
// of this PI should be billed. It is a commercial decision somebody takes and
// declares — not a discount, not a payment percentage, and not anything the
// workbook carries. Nothing here derives it, and nothing here may default it.
//
// WHY NULL IS A REAL STATE
// ------------------------
// Undeclared is not 0% and it is not 100%. A PI nobody has decided about and a
// PI somebody decided to bill in full are different facts, and collapsing them
// would make the second unprovable. So the column is nullable, no row is ever
// backfilled, and the screen says `Undeclared` rather than showing a figure
// nobody chose.
//
// WHY THE FLOOR IS 35
// -------------------
// It is a business rule, not a technical one: below 35% is outside what this
// business bills against a proforma. It is enforced in three places that must
// agree — this module for the form, the RPC for the write, and a CHECK
// constraint for the table — and `billingPercentage.test.ts` pins every
// boundary so they cannot drift.
//
// ONE RULE, THREE IMPLEMENTATIONS. Migration 20260923000000 states the same
// bounds in SQL. The constraint is the one that actually holds; the other two
// exist so a person is told why before the database has to refuse them.

/** Nobody may bill less than this share of the pre-GST value. */
export const BILLING_MIN = 35

/** And nobody may bill more than the whole of it. */
export const BILLING_MAX = 100

/** Two decimals, matching numeric(5,2) — 35.50 is a real declaration. */
export const BILLING_DECIMALS = 2

/** What the card says when nobody has declared one. Never "0%", never "—". */
export const BILLING_UNDECLARED = 'Undeclared'

export const BILLING_RANGE_HELP = `Enter a value from ${BILLING_MIN}% to ${BILLING_MAX}%.`

export type BillingParse =
  | { ok: true; value: number }
  | { ok: false; reason: 'empty' | 'malformed' | 'range' | 'precision'; message: string }

/**
 * What the user typed, as a percentage this system will accept — or the reason
 * it will not.
 *
 * REJECTS RATHER THAN REPAIRS. There is no clamping and no rounding of an
 * out-of-range value into range: a person who typed 30 meant 30, and silently
 * saving 35 on their behalf would record a decision nobody took.
 */
export function parseBillingPercentage(raw: string): BillingParse {
  const text = (raw ?? '').trim().replace(/%$/, '').trim()
  if (text === '') {
    return { ok: false, reason: 'empty', message: BILLING_RANGE_HELP }
  }
  // Number('') is 0 and Number('  ') is 0, which is why the blank check is
  // first; Number('12abc') is NaN, and Number('Infinity') is Infinity.
  const value = Number(text)
  if (!Number.isFinite(value)) {
    return { ok: false, reason: 'malformed', message: 'Enter a number, using digits.' }
  }
  const decimals = (text.split('.')[1] ?? '').length
  if (decimals > BILLING_DECIMALS) {
    return {
      ok: false,
      reason: 'precision',
      message: `Use at most ${BILLING_DECIMALS} decimal places.`,
    }
  }
  if (value < BILLING_MIN || value > BILLING_MAX) {
    return { ok: false, reason: 'range', message: BILLING_RANGE_HELP }
  }
  return { ok: true, value }
}

/** A stored value, as the card prints it: `65%`, `35.5%`, `100%`. */
export function formatBillingPercentage(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return BILLING_UNDECLARED
  // Trailing zeros are noise: 65.00 was typed as 65, and 35.50 as 35.5.
  const fixed = value.toFixed(BILLING_DECIMALS).replace(/\.?0+$/, '')
  return `${fixed}%`
}

/**
 * Whatever the database handed back, as a number or null.
 *
 * PostgREST returns `numeric` as a STRING, so this is the one place that turns
 * it into something arithmetic can use. A value outside the bounds is refused
 * rather than shown: the constraint makes it impossible, and if one ever
 * appeared it would mean the column no longer means what this module says.
 */
export function readBillingPercentage(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) return null
  if (value < BILLING_MIN || value > BILLING_MAX) return null
  return value
}

/**
 * The billing value: what this percentage comes to against the PRE-GST total.
 *
 * TOTAL BEFORE GST, AND NOTHING ELSE. Not the grand total, which includes tax
 * this percentage says nothing about, and not the product value, which is
 * before the costs the subtotal already absorbed. Substituting either would
 * produce a plausible figure that answers a different question.
 *
 * Returns null when EITHER input is missing, so the caller shows its own
 * missing-value treatment. A missing total must never come out as ₹0.
 */
export function billingValue(input: {
  totalBeforeGst: number | null | undefined
  percentage: number | null | undefined
}): number | null {
  const total = input.totalBeforeGst
  const pct = input.percentage
  if (total === null || total === undefined || !Number.isFinite(total)) return null
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return null
  return (total * pct) / 100
}
