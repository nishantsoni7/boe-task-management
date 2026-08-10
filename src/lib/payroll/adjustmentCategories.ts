// What a manual payroll adjustment IS, as opposed to which way it points.
//
// WHY A CATEGORY, WHEN THERE IS ALREADY A TYPE AND A DESCRIPTION
// -------------------------------------------------------------
// `adjustment_type` says only 'addition' or 'deduction'. `description` is free
// text an admin types. Between them they cannot answer "how much was paid out as
// incentive this month" — an addition might be an incentive, a bonus, a
// reimbursement, last month's unpaid salary, or something else entirely, and the
// only thing separating them is prose that reads "Incentive", "incentive ",
// "Inc." or "as discussed".
//
// The salary-processing report has to state those lines separately, so the
// distinction has to be a value rather than a hope about spelling.
//
// LEGACY ROWS STAY UNCATEGORISED, DELIBERATELY
// --------------------------------------------
// Every adjustment written before this column existed has a NULL category, and
// no backfill guesses one. Reading "Bonus for Diwali" and stamping it `bonus`
// would be inventing a fact: the admin who typed it was not choosing from this
// list, and a description that merely CONTAINS a word is not a categorisation.
// Getting it wrong would silently move money between lines of a report that
// people reconcile against.
//
// So NULL means "not stated", and the report groups it under the matching
// "Other" line. That is a presentation of an unknown, not a rewrite of it — the
// stored row keeps its NULL, and an admin can categorise it by editing it.

import type { AdjustmentType } from './adjustments'

// ─── The categories ───────────────────────────────────────────────────────────

export const ADDITION_CATEGORIES = [
  'previous_salary_pending',
  'incentive',
  'bonus',
  'reimbursement',
  'other_addition',
] as const

export const DEDUCTION_CATEGORIES = [
  'advance_recovery',
  'other_deduction',
] as const

export type AdditionCategory  = (typeof ADDITION_CATEGORIES)[number]
export type DeductionCategory = (typeof DEDUCTION_CATEGORIES)[number]
export type AdjustmentCategory = AdditionCategory | DeductionCategory

export const ADJUSTMENT_CATEGORIES: readonly AdjustmentCategory[] = [
  ...ADDITION_CATEGORIES,
  ...DEDUCTION_CATEGORIES,
]

/** What an admin and an employee see. Also the report's line labels. */
export const ADJUSTMENT_CATEGORY_LABELS: Record<AdjustmentCategory, string> = {
  previous_salary_pending: 'Previous salary pending',
  incentive:               'Incentive',
  bonus:                   'Bonus',
  reimbursement:           'Reimbursement',
  other_addition:          'Other addition',
  advance_recovery:        'Advance recovery',
  other_deduction:         'Other deduction',
}

/**
 * The direction each category must carry.
 *
 * An incentive cannot be a deduction and an advance recovery cannot be an
 * addition. Stated here once, enforced by the API, by the database CHECK in
 * migration 20260829000000, and asserted by the tests — a category that
 * contradicted its type would put a payment on the recovery line of a report.
 */
export const CATEGORY_DIRECTION: Record<AdjustmentCategory, AdjustmentType> = {
  previous_salary_pending: 'addition',
  incentive:               'addition',
  bonus:                   'addition',
  reimbursement:           'addition',
  other_addition:          'addition',
  advance_recovery:        'deduction',
  other_deduction:         'deduction',
}

/** The order the salary-processing report lists categories in. */
export const REPORT_CATEGORY_ORDER: readonly AdjustmentCategory[] = [
  'advance_recovery',
  'previous_salary_pending',
  'incentive',
  'bonus',
  'reimbursement',
  'other_addition',
  'other_deduction',
]

// ─── Narrowing ────────────────────────────────────────────────────────────────

export function isAdjustmentCategory(value: unknown): value is AdjustmentCategory {
  return typeof value === 'string' && (ADJUSTMENT_CATEGORIES as readonly string[]).includes(value)
}

/**
 * A stored category value, narrowed — or null.
 *
 * Anything unrecognised becomes null rather than being asserted through, so a
 * value written by some future path cannot reach a report as a category nobody
 * has a label for. Null is a legitimate state here (a legacy row), so this is
 * not a failure mode, it is the same answer by a different route.
 */
export function parseStoredCategory(value: unknown): AdjustmentCategory | null {
  return isAdjustmentCategory(value) ? value : null
}

/**
 * The category a row should be REPORTED under, given what it stores.
 *
 * A stated category is used as stated. A row with none — every adjustment
 * predating this column — falls to the "Other" line matching its direction,
 * because an uncategorised addition is, for reporting purposes, an addition
 * nobody labelled. Nothing is written back: the row keeps its NULL.
 */
export function reportingCategory(
  category: unknown,
  type: AdjustmentType,
): AdjustmentCategory {
  const parsed = parseStoredCategory(category)
  if (parsed && CATEGORY_DIRECTION[parsed] === type) return parsed
  // Either uncategorised, or categorised in a way that contradicts its own
  // direction. Both are read as the neutral bucket for the direction the row
  // actually carries — the amount's sign is the fact we trust, because it is
  // what the engine already applied to the salary.
  return type === 'deduction' ? 'other_deduction' : 'other_addition'
}

/** The categories valid for a direction, for a form's dropdown. */
export function categoriesFor(type: AdjustmentType): readonly AdjustmentCategory[] {
  return type === 'deduction' ? DEDUCTION_CATEGORIES : ADDITION_CATEGORIES
}

/**
 * Whether a category may be stored against a direction.
 *
 * Used by the API before an insert or update. Returning a reason rather than a
 * bare false so the caller can say what was wrong.
 */
export function validateCategoryForType(
  category: unknown,
  type: AdjustmentType,
): { ok: true; category: AdjustmentCategory } | { ok: false; message: string } {
  const parsed = parseStoredCategory(category)
  if (!parsed) {
    return { ok: false, message: `"${String(category)}" is not a payroll adjustment category.` }
  }
  if (CATEGORY_DIRECTION[parsed] !== type) {
    return {
      ok: false,
      message: `${ADJUSTMENT_CATEGORY_LABELS[parsed]} is ${CATEGORY_DIRECTION[parsed] === 'addition' ? 'an addition' : 'a deduction'}, so it cannot be saved as ${type === 'addition' ? 'an addition' : 'a deduction'}.`,
    }
  }
  return { ok: true, category: parsed }
}
