// Rupees, as whole numbers.
//
// WHY PAYROLL ROUNDS AT ALL
// -------------------------
// BOE pays in whole rupees. Before this, payroll carried full floating-point
// precision the whole way through and only the display layer rounded, which
// produced two problems that both look like an arithmetic error to an employee:
//
//   · a payslip whose lines read ₹235, ₹1,000 and ₹500 with a total of ₹1,736,
//     because the true values were 235.29, 1000.00 and 500.00 and the TOTAL was
//     rounded independently of the lines;
//   · a stored net_salary of 24,461.53 that no combination of displayed figures
//     could be made to add up to.
//
// WHERE ROUNDING HAPPENS, AND WHERE IT MUST NOT
// ---------------------------------------------
// Exactly one place: the moment a monetary LINE is derived. Rates, hours,
// minutes, day fractions and leave allowances stay precise right up to that
// point, and every total is then built by summing lines that are already whole.
//
// That ordering is the rule, and it is not interchangeable with rounding the
// total. `round(a) + round(b)` and `round(a + b)` differ, and only the first
// gives a payslip whose printed lines add up to its printed total. So:
//
//   per_hour_rate = 26000 / 26 / 8.5   →  117.647058…   ← stays precise
//   2h missing punch = 2 × 117.647058… →  235.294117…   ← still precise
//   the LINE                            →  ₹235          ← rounded here, once
//   total_deductions                    →  sum of ₹ lines
//
// Deliberately NOT rounded: per_day_rate, per_hour_rate, effective_hours_worked,
// hours_deducted, paid-leave fractions. Rounding a RATE would compound the error
// across every line drawn from it, which is the opposite of the intent.
//
// One helper, used everywhere. Scattered Math.round calls are what let a
// deduction round one way on the payslip and another in the report.

/**
 * A rupee amount, rounded half-up, away from zero.
 *
 *   10.50 → 11      10.49 → 10      10.5000001 → 11
 *  -10.50 → -11    -10.49 → -10     0 → 0
 *
 * HALF-UP AWAY FROM ZERO, not JavaScript's Math.round. `Math.round(-10.5)` is
 * -10, because it rounds toward +Infinity, which would make a ₹10.50 deduction
 * and a ₹10.50 recovery round to different magnitudes. Payroll has amounts on
 * both sides of zero — an advance recovery, a negative closing balance — and a
 * rule that treats them asymmetrically is a rule that loses a rupee somewhere
 * an employee can find it.
 *
 * FLOAT SAFETY. IEEE 754 cannot hold most decimal fractions exactly, so a value
 * that is mathematically 1234.5 can arrive as 1234.4999999999998 and round DOWN
 * — a rupee lost to representation rather than to policy. The magnitude is
 * therefore normalised to 6 decimal places first, which is far finer than any
 * real payroll quantity and coarse enough to absorb accumulated error from the
 * handful of multiplications and divisions upstream.
 */
export function roundRupees(amount: number): number {
  if (!Number.isFinite(amount)) {
    throw new Error(`roundRupees: refusing to round a non-finite amount (${amount})`)
  }

  const magnitude = Math.abs(amount)
  // Number(toFixed(6)) collapses representation noise before the half-up test,
  // so 1234.4999999999998 becomes 1234.5 and rounds up as the arithmetic meant.
  const settled = Number(magnitude.toFixed(6))
  const rounded = Math.round(settled)

  // `+ 0` normalises -0 to 0, so a zeroed line never serialises as "-0".
  return (amount < 0 ? -rounded : rounded) + 0
}

/**
 * Sum amounts that are ALREADY whole rupees.
 *
 * Separate from a plain reduce so the intent is stated where it is used: a total
 * is the sum of rounded lines, never a rounded sum of raw ones. In development
 * it asserts that its inputs really are whole, which is what stops a future
 * caller quietly reintroducing paise one layer up.
 */
export function sumRupees(amounts: number[]): number {
  let total = 0
  for (const amount of amounts) {
    if (!Number.isInteger(amount)) {
      throw new Error(
        `sumRupees: expected whole rupees, got ${amount}. Round each line with roundRupees() before summing.`,
      )
    }
    total += amount
  }
  return total
}

/**
 * True when a value is a whole rupee amount.
 *
 * Used by the tests and by the report assembly to state the invariant rather
 * than assume it.
 */
export function isWholeRupees(amount: number): boolean {
  return Number.isFinite(amount) && Number.isInteger(amount)
}

/**
 * A rupee amount formatted the way BOE writes it: ₹1,23,456 — Indian digit
 * grouping, no decimals, and a minus sign kept in front of the symbol.
 *
 * The value is rounded on the way through rather than trusted, so a figure that
 * somehow reached the UI with paise still renders as whole rupees instead of
 * showing an employee a number the payslip does not contain.
 */
export function formatRupees(amount: number): string {
  const whole = roundRupees(amount)
  const formatted = new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  }).format(Math.abs(whole))
  return `${whole < 0 ? '-' : ''}₹${formatted}`
}
