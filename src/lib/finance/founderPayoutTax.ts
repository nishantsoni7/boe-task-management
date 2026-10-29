// ── Founders' payouts: the income-tax arithmetic ─────────────────────────────
//
// Used by /finance/founders to say, per person and per financial year, how much
// more can be paid while staying under the zero-tax line, and what tax an extra
// amount would cost. Nothing here is stored: the database keeps the payments
// and the two typed inputs (other income, book profit); every figure below is
// worked out on read, from the rules of that tax year.
//
// GENERAL RULES, NOT ADVICE. They are the published new-regime rules for an
// individual resident in India and the partner-remuneration ceiling for a firm.
// They do not know the partnership deed, who holds what share, or a spouse
// relationship (clubbing), so the page tells the owner to confirm with the CA.
//
// TAX YEAR = the year the financial year starts: 2026 means 2026-27 (1 April
// 2026 to 31 March 2027). From 1 April 2026 the Income-tax Act, 2025 applies;
// the slab and rebate figures carried over from the Finance Act 2025 unchanged.
//
// Amounts are rupees (numbers); callers sum in paise and divide.

export type TaxRole = 'working_partner' | 'employee' | 'family' | 'unset'

type Slab = { upTo: number | null; rate: number }

export type TaxYearRules = {
  taxYear: number
  /** New-regime slabs, ascending; the last has upTo null. */
  slabs: readonly Slab[]
  /** Total income at or below which the rebate wipes the tax out (old s.87A). */
  rebateIncomeLimit: number
  /** Salary and pension only; a partner's remuneration is business income. */
  standardDeduction: number
  /** Health and education cess on the tax. */
  cessRate: number
  /** Partner remuneration a firm may deduct (old s.40(b), new s.35(e)). */
  ceilingFloor: number
  ceilingFirstTier: number
  ceilingFirstRate: number
  ceilingRestRate: number
  /** Interest on partners' capital, simple, per year. */
  interestOnCapitalMaxRate: number
  /** TDS on payments to a partner (old s.194T): rate once the year's total passes the threshold. */
  tdsThreshold: number
  tdsRate: number
}

const NEW_REGIME_SLABS_FROM_2025: readonly Slab[] = [
  { upTo: 400000, rate: 0 },
  { upTo: 800000, rate: 0.05 },
  { upTo: 1200000, rate: 0.1 },
  { upTo: 1600000, rate: 0.15 },
  { upTo: 2000000, rate: 0.2 },
  { upTo: 2400000, rate: 0.25 },
  { upTo: null, rate: 0.3 },
]

const RULES_FROM_2025 = {
  slabs: NEW_REGIME_SLABS_FROM_2025,
  rebateIncomeLimit: 1200000,
  standardDeduction: 75000,
  cessRate: 0.04,
  ceilingFloor: 300000,
  ceilingFirstTier: 600000,
  ceilingFirstRate: 0.9,
  ceilingRestRate: 0.6,
  interestOnCapitalMaxRate: 0.12,
  tdsThreshold: 20000,
  tdsRate: 0.1,
} as const

/** One entry per tax year whose rules are known. A Budget change is one new entry. */
export const TAX_RULES: Readonly<Record<number, TaxYearRules>> = {
  2025: { taxYear: 2025, ...RULES_FROM_2025 },
  2026: { taxYear: 2026, ...RULES_FROM_2025 },
}

const KNOWN_YEARS = Object.keys(TAX_RULES).map(Number).sort((a, b) => a - b)

/**
 * The rules for a tax year. A year after the last known one borrows the latest
 * rules and says so (`assumed`); a year before the first known one has none
 * (the earlier regime was different, and the page shows totals only).
 */
export function rulesFor(taxYear: number): { rules: TaxYearRules; assumed: boolean } | null {
  if (TAX_RULES[taxYear]) return { rules: TAX_RULES[taxYear], assumed: false }
  const latest = KNOWN_YEARS[KNOWN_YEARS.length - 1]
  if (taxYear > latest) return { rules: TAX_RULES[latest], assumed: true }
  return null
}

/** Tax by the slabs alone, before rebate, relief and cess. */
export function slabTax(income: number, rules: TaxYearRules): number {
  let tax = 0
  let floor = 0
  for (const slab of rules.slabs) {
    const top = slab.upTo ?? Infinity
    if (income > floor) tax += (Math.min(income, top) - floor) * slab.rate
    floor = top
  }
  return tax
}

/**
 * New-regime tax on a TOTAL income, cess included, to the rupee. Nil up to the
 * rebate line; just above it, marginal relief caps the tax at the amount by
 * which income exceeds the line. Surcharge (above ₹50 lakh) is not modelled.
 */
export function newRegimeTax(totalIncome: number, rules: TaxYearRules): number {
  if (!(totalIncome > rules.rebateIncomeLimit)) return 0
  const beforeCess = Math.min(slabTax(totalIncome, rules), totalIncome - rules.rebateIncomeLimit)
  return Math.round(beforeCess * (1 + rules.cessRate))
}

/** Does money paid to someone in this role count as THEIR income? */
export function countsAsOwnIncome(role: TaxRole): boolean {
  return role === 'working_partner' || role === 'employee'
}

/**
 * How much a person in this role can receive from BOE in the year, with no
 * other income, and pay no tax. null: not their income (family) or not known
 * yet (unset).
 */
export function taxFreeLimit(role: TaxRole, rules: TaxYearRules): number | null {
  if (role === 'working_partner') return rules.rebateIncomeLimit
  if (role === 'employee') return rules.rebateIncomeLimit + rules.standardDeduction
  return null
}

function totalIncome(role: TaxRole, received: number, otherIncome: number, rules: TaxYearRules): number {
  if (role === 'employee') return Math.max(0, received - rules.standardDeduction) + otherIncome
  return received + otherIncome
}

/** What is still free of tax this year (negative = already over), or null when it does not apply. */
export function roomLeft(role: TaxRole, received: number, otherIncome: number, rules: TaxYearRules): number | null {
  const limit = taxFreeLimit(role, rules)
  if (limit === null) return null
  return limit - otherIncome - received
}

/** The person's tax for the year if `extra` more is paid on top of what they received. null when it does not apply. */
export function taxIfPaid(role: TaxRole, received: number, otherIncome: number, extra: number, rules: TaxYearRules): number | null {
  if (!countsAsOwnIncome(role)) return null
  return newRegimeTax(totalIncome(role, received + extra, otherIncome, rules), rules)
}

/**
 * The most partner remuneration (salary, bonus, commission, remuneration) the
 * firm may deduct for ALL working partners together: on the first ₹6 lakh of
 * book profit, or on a loss, the higher of ₹3 lakh and 90%; on the rest, 60%.
 */
export function remunerationCeiling(bookProfit: number, rules: TaxYearRules): number {
  if (!(bookProfit > 0)) return rules.ceilingFloor
  const first = Math.min(bookProfit, rules.ceilingFirstTier)
  const rest = Math.max(0, bookProfit - rules.ceilingFirstTier)
  return Math.round(Math.max(rules.ceilingFloor, first * rules.ceilingFirstRate) + rest * rules.ceilingRestRate)
}
