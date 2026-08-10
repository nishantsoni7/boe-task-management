/**
 * Adjustment categories.
 *
 *   npx tsx --test src/lib/payroll/adjustmentCategories.test.ts
 *
 * Two things here can cost real money if they are wrong.
 *
 * The first is direction. `advance_recovery` is a deduction and `incentive` is
 * an addition, and a row whose category contradicted its own amount would put a
 * payment onto the recovery line of a report somebody reconciles against a bank
 * statement — the label and the money would disagree, and the label is what a
 * human reads.
 *
 * The second is legacy rows. Every adjustment written before the column exists
 * has a NULL category, and nothing may guess one for it. A description reading
 * "Bonus for Diwali" is not a categorisation, and stamping it `bonus` would be
 * inventing a fact the admin never stated.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ADDITION_CATEGORIES,
  DEDUCTION_CATEGORIES,
  ADJUSTMENT_CATEGORIES,
  ADJUSTMENT_CATEGORY_LABELS,
  CATEGORY_DIRECTION,
  REPORT_CATEGORY_ORDER,
  isAdjustmentCategory,
  parseStoredCategory,
  reportingCategory,
  categoriesFor,
  validateCategoryForType,
  type AdjustmentCategory,
} from './adjustmentCategories'

describe('the required categories all exist', () => {
  test('every addition category the report needs is present', () => {
    for (const required of [
      'previous_salary_pending', 'incentive', 'bonus', 'reimbursement', 'other_addition',
    ]) {
      assert.ok(ADDITION_CATEGORIES.includes(required as never), `missing ${required}`)
    }
    assert.equal(ADDITION_CATEGORIES.length, 5)
  })

  test('every deduction category the report needs is present', () => {
    for (const required of ['advance_recovery', 'other_deduction']) {
      assert.ok(DEDUCTION_CATEGORIES.includes(required as never), `missing ${required}`)
    }
    assert.equal(DEDUCTION_CATEGORIES.length, 2)
  })

  test('every category has a human label', () => {
    for (const c of ADJUSTMENT_CATEGORIES) {
      assert.ok(ADJUSTMENT_CATEGORY_LABELS[c]?.length > 0, `no label for ${c}`)
    }
  })

  test('every category appears exactly once in the report order', () => {
    assert.equal(REPORT_CATEGORY_ORDER.length, ADJUSTMENT_CATEGORIES.length)
    assert.equal(new Set(REPORT_CATEGORY_ORDER).size, REPORT_CATEGORY_ORDER.length)
    for (const c of ADJUSTMENT_CATEGORIES) {
      assert.ok(REPORT_CATEGORY_ORDER.includes(c), `${c} is missing from the report order`)
    }
  })

  test('no category is in both directions', () => {
    for (const c of ADDITION_CATEGORIES) {
      assert.equal(DEDUCTION_CATEGORIES.includes(c as never), false, `${c} is in both lists`)
    }
  })
})

describe('direction is part of the category', () => {
  test('every addition category is declared an addition', () => {
    for (const c of ADDITION_CATEGORIES) assert.equal(CATEGORY_DIRECTION[c], 'addition', c)
  })

  test('every deduction category is declared a deduction', () => {
    for (const c of DEDUCTION_CATEGORIES) assert.equal(CATEGORY_DIRECTION[c], 'deduction', c)
  })

  test('categoriesFor offers only the categories valid for a direction', () => {
    assert.deepEqual([...categoriesFor('addition')], [...ADDITION_CATEGORIES])
    assert.deepEqual([...categoriesFor('deduction')], [...DEDUCTION_CATEGORIES])
  })
})

describe('validation', () => {
  test('a matching category is accepted', () => {
    const r = validateCategoryForType('incentive', 'addition')
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.category, 'incentive')
  })

  test('a category that contradicts its direction is REFUSED', () => {
    // The case that would misplace money in a report.
    const r = validateCategoryForType('advance_recovery', 'addition')
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.message, /deduction/)
  })

  test('an incentive cannot be saved as a deduction either', () => {
    const r = validateCategoryForType('incentive', 'deduction')
    assert.equal(r.ok, false)
  })

  test('an unknown category is refused rather than stored', () => {
    for (const bad of ['salary', '', 'INCENTIVE', null, undefined, 7, {}]) {
      assert.equal(validateCategoryForType(bad, 'addition').ok, false, String(bad))
    }
  })

  test('the refusal names the category, so an admin can act on it', () => {
    const r = validateCategoryForType('bonus', 'deduction')
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.message, /Bonus/)
  })
})

describe('narrowing a stored value', () => {
  test('a recognised value narrows', () => {
    assert.equal(parseStoredCategory('bonus'), 'bonus')
    assert.equal(isAdjustmentCategory('bonus'), true)
  })

  test('anything unrecognised becomes null rather than reaching a report', () => {
    for (const bad of [null, undefined, '', 'Bonus', 'nonsense', 42, {}, []]) {
      assert.equal(parseStoredCategory(bad), null, String(bad))
      assert.equal(isAdjustmentCategory(bad), false, String(bad))
    }
  })
})

describe('legacy rows are reported, not reinterpreted', () => {
  test('an uncategorised addition reports as Other addition', () => {
    assert.equal(reportingCategory(null, 'addition'), 'other_addition')
    assert.equal(reportingCategory(undefined, 'addition'), 'other_addition')
  })

  test('an uncategorised deduction reports as Other deduction', () => {
    assert.equal(reportingCategory(null, 'deduction'), 'other_deduction')
  })

  test('a description is NEVER consulted — only the stored category counts', () => {
    // reportingCategory takes no description argument at all, which is the
    // structural guarantee. Passing prose where a category belongs must not
    // produce a category.
    assert.equal(reportingCategory('Bonus for Diwali', 'addition'), 'other_addition')
    assert.equal(reportingCategory('incentive payment', 'addition'), 'other_addition')
  })

  test('a stated category is used exactly as stated', () => {
    for (const c of ADDITION_CATEGORIES) {
      assert.equal(reportingCategory(c, 'addition'), c)
    }
    for (const c of DEDUCTION_CATEGORIES) {
      assert.equal(reportingCategory(c, 'deduction'), c)
    }
  })

  test('a category contradicting its own direction falls back to the direction’s Other', () => {
    // The amount's sign is the fact we trust: it is what the engine already
    // applied to the salary. A contradictory label must not move the money.
    assert.equal(reportingCategory('advance_recovery', 'addition'), 'other_addition')
    assert.equal(reportingCategory('incentive', 'deduction'), 'other_deduction')
  })

  test('every reporting outcome is itself a valid category for that direction', () => {
    const inputs: unknown[] = [null, undefined, 'nonsense', 'bonus', 'advance_recovery', 42]
    for (const type of ['addition', 'deduction'] as const) {
      for (const input of inputs) {
        const out = reportingCategory(input, type)
        assert.equal(CATEGORY_DIRECTION[out], type, `${String(input)} → ${out} on a ${type}`)
      }
    }
  })
})

describe('the migration matches the code', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase/migrations/20260829000000_payroll_adjustment_categories.sql'),
    'utf8',
  )

  test('every category the code knows is allowed by the CHECK', () => {
    for (const c of ADJUSTMENT_CATEGORIES) {
      assert.ok(sql.includes(`'${c}'`), `${c} is missing from the migration CHECK`)
    }
  })

  test('the CHECK pairs each category with its direction', () => {
    // Membership alone would let an incentive be stored as a deduction.
    assert.match(sql, /adjustment_type = 'addition'\s*\n\s*AND adjustment_category IN/)
    assert.match(sql, /adjustment_type = 'deduction'\s*\n\s*AND adjustment_category IN/)
  })

  test('NULL is allowed, so legacy rows are not invalidated', () => {
    assert.match(sql, /adjustment_category IS NULL/)
  })

  test('the column is nullable with no default, and nothing is backfilled', () => {
    assert.match(sql, /ADD COLUMN IF NOT EXISTS adjustment_category text;/)
    assert.doesNotMatch(sql, /DEFAULT '/)
    assert.doesNotMatch(sql, /UPDATE public\.payroll_pending_adjustments/)
  })

  test('no RLS policy is added, altered or dropped', () => {
    // A category is a label on a row the caller could already read.
    assert.doesNotMatch(sql, /CREATE POLICY/)
    assert.doesNotMatch(sql, /DROP POLICY/)
    assert.doesNotMatch(sql, /ENABLE ROW LEVEL SECURITY/)
    assert.doesNotMatch(sql, /GRANT /)
  })
})

describe('the API stores what it validates', () => {
  const route = readFileSync(
    join(process.cwd(), 'src/app/api/payroll/adjustments/route.ts'),
    'utf8',
  )

  test('the category is validated against the direction before being stored', () => {
    assert.match(route, /validateCategoryForType/)
  })

  test('an unvalidated category cannot reach the insert', () => {
    // The insert must use the narrowed value, never the raw body field.
    assert.match(route, /adjustment_category: resolvedCategory/)
    assert.doesNotMatch(route, /adjustment_category: category/)
  })

  test('the amount is stored in whole rupees, through the shared helper', () => {
    assert.match(route, /roundRupees\(amount\)/)
    assert.match(route, /amount:\s+wholeAmount/)
  })

  test('the category is optional, so an existing caller keeps working', () => {
    assert.match(route, /category\?:\s+string/)
    assert.match(route, /let resolvedCategory: string \| null = null/)
  })
})

describe('categories do not change any salary figure', () => {
  test('the engine never reads a category', async () => {
    // The category is a reporting label. If the engine consulted it, adding one
    // to an old row would change that month's pay.
    const engine = readFileSync(join(process.cwd(), 'src/lib/payroll/engine.ts'), 'utf8')
    assert.doesNotMatch(engine, /adjustment_category/)
    assert.doesNotMatch(engine, /adjustmentCategories/)
  })

  test('the engine adjustment shape carries no category', async () => {
    const { toSignedAdjustment } = await import('./adjustments')
    const signed = toSignedAdjustment({
      id: 'a1',
      adjustment_type: 'deduction',
      adjustment_category: 'advance_recovery',
      amount: 500,
      description: 'Advance',
    })
    assert.deepEqual(Object.keys(signed).sort(), ['amount', 'description', 'id'])
    assert.equal(signed.amount, -500, 'direction still comes from adjustment_type')
  })

  test('a category cannot flip the sign the engine applies', async () => {
    const { toSignedAdjustment } = await import('./adjustments')
    // Contradictory category on purpose: the sign must follow the TYPE.
    const signed = toSignedAdjustment({
      id: 'a2',
      adjustment_type: 'addition',
      adjustment_category: 'advance_recovery' as unknown,
      amount: 500,
      description: 'Odd row',
    })
    assert.equal(signed.amount, 500)
  })
})

/** Compile-time proof the union is exhaustive where it is switched on. */
const _exhaustive: Record<AdjustmentCategory, true> = {
  previous_salary_pending: true,
  incentive: true,
  bonus: true,
  reimbursement: true,
  other_addition: true,
  advance_recovery: true,
  other_deduction: true,
}
void _exhaustive
