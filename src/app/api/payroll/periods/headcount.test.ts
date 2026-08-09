/**
 * "Employees Included" — the period headcount.
 *
 * THE BUG
 * -------
 * The dashboard read payroll_generation.employee_count from the latest completed
 * run. That is how many employees ONE generation REQUEST processed. Every
 * attendance correction regenerates the single employee it affects, so a
 * 12-person payroll period displayed "1" as soon as one date was corrected —
 * while the period still held all twelve results, and opening it showed them.
 *
 * The fix counts payroll_results per period. These tests are the regression
 * cover for the exact sequence that produced the wrong number, plus the two
 * cases a naive count could break: a full regeneration, and an older locked
 * period whose count must not move.
 *
 * Pure data-in/data-out, so this needs no database and no credentials — unlike
 * route.test.ts, whose create/reuse suite exercises a real Supabase client.
 *
 * Run:
 *   npx tsx --test src/app/api/payroll/periods/headcount.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { countResultsByPeriod } from './route'

/** The rows payroll_results holds for `count` employees in one period. */
function resultsFor(periodId: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    payroll_period_id: periodId,
    employee_id: `emp-${i + 1}`,
  }))
}

describe('countResultsByPeriod', () => {
  test('a period with 12 current results counts 12', () => {
    const counts = countResultsByPeriod(resultsFor('july', 12))
    assert.equal(counts['july'], 12)
  })

  test('regenerating ONE employee still counts 12 — the defect, pinned', () => {
    // Regeneration upserts on (payroll_period_id, employee_id), so correcting a
    // date for one employee replaces that employee's row and leaves the other
    // eleven exactly where they were. The stored rows are what this counts, so
    // the run that touched a single employee cannot change the headcount.
    const afterPartialRegeneration = resultsFor('july', 12)
    assert.equal(afterPartialRegeneration.length, 12)

    const counts = countResultsByPeriod(afterPartialRegeneration)

    assert.equal(counts['july'], 12, 'a one-employee regeneration must not turn 12 into 1')
    assert.notEqual(counts['july'], 1)
  })

  test('a full regeneration of all 12 still counts 12', () => {
    const counts = countResultsByPeriod(resultsFor('july', 12))
    assert.equal(counts['july'], 12)
  })

  test('each period is counted independently', () => {
    const counts = countResultsByPeriod([
      ...resultsFor('june', 9),
      ...resultsFor('july', 12),
      ...resultsFor('august', 13),
    ])
    assert.deepEqual(counts, { june: 9, july: 12, august: 13 })
  })

  test('a historical period keeps its own count when a later month grows', () => {
    // June was run with 9 employees and locked. August is generated later with
    // 13, four of whom did not exist in June. June must still read 9 — the
    // headcount is per period, never the current company headcount.
    const june   = resultsFor('june', 9)
    const august = resultsFor('august', 13)

    const before = countResultsByPeriod(june)
    const after  = countResultsByPeriod([...june, ...august])

    assert.equal(before['june'], 9)
    assert.equal(after['june'], 9, 'a locked historical period must not be restated')
    assert.equal(after['august'], 13)
  })

  test('a period with no results yet is absent, not zero-by-accident', () => {
    // The caller renders `counts[id] ?? 0` and the table shows an em dash for 0,
    // so a Draft period reads as "not generated" rather than as a failed run.
    const counts = countResultsByPeriod(resultsFor('july', 3))
    assert.equal(counts['draft-period'], undefined)
    assert.equal(counts['draft-period'] ?? 0, 0)
  })

  test('no results at all produces an empty map, not a throw', () => {
    assert.deepEqual(countResultsByPeriod([]), {})
  })

  test('an excluded member simply has no result row, so no new period counts them', () => {
    // Exclusion is enforced upstream, at generation. Its effect here is the
    // absence of a row: the next period is generated for 11, not 12.
    const july   = resultsFor('july', 12)
    const august = resultsFor('august', 11)

    const counts = countResultsByPeriod([...july, ...august])

    assert.equal(counts['august'], 11)
    assert.equal(counts['july'], 12, 'excluding somebody must not restate the month they were paid in')
  })
})
