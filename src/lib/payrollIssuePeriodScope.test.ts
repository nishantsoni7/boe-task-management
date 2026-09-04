/**
 * A reported payroll issue belongs to ONE payroll run, and is read there.
 *
 * THE DEFECT
 * ----------
 * The period results page rendered <ObjectionQueue subject="payroll"> against
 * the unfiltered /api/objections list, which is every payroll objection ever
 * raised. So "Payroll Results — August 2026" showed five objections stamped
 * 07/2026 underneath August's salaries: the header, the figures and the issues
 * were describing three different things.
 *
 * The relationship was already in the schema and simply not used —
 * employee_record_objections.payroll_result_id → payroll_results.payroll_period_id,
 * NOT NULL since 20260612000000. So the fix is a join, not a new column and not
 * a comparison of the month text in subject_snapshot.
 *
 * THE OTHER HALF
 * --------------
 * Older issues are an audit record and must stay reachable, so Payroll Monthly
 * Preview grew the same panel for the month it is showing. It knows a month
 * rather than a run, and payroll_periods is UNIQUE (payroll_month,
 * payroll_year), so the month resolves to at most one run server-side.
 *
 * Run:
 *   npx tsx --test src/lib/payrollIssuePeriodScope.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  payrollPeriodScopeQuery,
  PERIOD_ID_PARAM,
  PERIOD_YEAR_PARAM,
  PERIOD_MONTH_PARAM,
} from './objections'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

// ─── 1. Naming a run ──────────────────────────────────────────────────────────

describe('a request for issues names the run it wants', () => {
  test('a period id travels as the period id', () => {
    const q = new URLSearchParams(payrollPeriodScopeQuery({ periodId: 'per-1' }))
    assert.equal(q.get(PERIOD_ID_PARAM), 'per-1')
    assert.equal(q.get(PERIOD_YEAR_PARAM), null)
    assert.equal(q.get(PERIOD_MONTH_PARAM), null)
  })

  test('a month travels as year and month, the only thing Monthly Preview holds', () => {
    const q = new URLSearchParams(payrollPeriodScopeQuery({ year: 2026, month: 7 }))
    assert.equal(q.get(PERIOD_YEAR_PARAM), '2026')
    assert.equal(q.get(PERIOD_MONTH_PARAM), '7')
    assert.equal(q.get(PERIOD_ID_PARAM), null)
  })

  test('the id form never carries a month, so the two can never disagree', () => {
    assert.equal(payrollPeriodScopeQuery({ periodId: 'per-1' }).includes('month'), false)
  })
})

// ─── 2. What the route does with it ───────────────────────────────────────────

describe('the route resolves the run through the objection own foreign key', () => {
  const api = read('src/app/api/objections/route.ts')

  test('the scope is a join on payroll_result_id, not a month string', () => {
    assert.ok(api.includes("query.in('payroll_result_id', scoped)"),
      'issues are narrowed by the results the run holds')
    assert.ok(api.includes("from('payroll_results')") && api.includes("eq('payroll_period_id'"),
      'and those results come from the run itself')
    assert.equal(/subject_snapshot['"\s]*\)?\s*\.(startsWith|includes|slice)/.test(api), false,
      'the display snapshot must never be used as a filter')
  })

  test('a month is resolved against payroll_periods, never against the calendar', () => {
    assert.ok(api.includes("from('payroll_periods')"))
    assert.ok(api.includes("eq('payroll_year'") && api.includes("eq('payroll_month'"))
    assert.equal(/new Date\(\)|Date\.now\(\)|getMonth\(\)/.test(api), false,
      'nothing about which issues to show may come from today')
  })

  test('an unknown run answers empty rather than answering with everything', () => {
    // The failure that matters: if "no such period" fell through to an
    // unfiltered query, a month with no run would show another month's issues.
    assert.ok(api.includes('if (!period) return []'))
    assert.ok(api.includes('if (scoped.length === 0) return NextResponse.json({ objections: [] })'))
  })

  test('the scope narrows, it never widens — it is applied after the ownership pin', () => {
    assert.ok(
      api.indexOf("query.eq('employee_id', caller.id)") < api.indexOf('payrollResultIdsForPeriod(caller.svc'),
      'a non-admin is pinned to their own rows before any period filter runs',
    )
  })

  test('asking for no run keeps the old answer, for the attendance queue', () => {
    assert.ok(api.includes('if (!year || !month) return null'))
    assert.ok(api.includes('const scoped = await payrollResultIdsForPeriod'))
    assert.ok(api.includes('if (scoped !== null) {'))
  })
})

// ─── 3. Where each list is read ───────────────────────────────────────────────

describe('each screen asks for the run it is about', () => {
  test('the period results page asks for its own run', () => {
    const src = read('src/app/payroll/results/[periodId]/page.tsx')
    assert.ok(src.includes('period={{ periodId }}'),
      'the run this page IS, taken from the route it was opened on')
    assert.ok(src.includes('No payroll issues were reported for this period.'),
      'an empty run says so instead of falling back to another month')
  })

  // Payroll Issues (src/app/payroll/issues/page.tsx) is where a HISTORICAL
  // month's issues are read now — it superseded the panel Monthly Preview
  // used to embed directly, per the Attendance & Payroll UX consolidation:
  // View Payroll dropped ObjectionQueue entirely rather than showing the
  // same period-scoped list in two primary destinations at once.
  test('Payroll Issues asks for the month it is showing, not the month selected', () => {
    const src = read('src/app/payroll/issues/page.tsx')
    assert.ok(src.includes('period={{ year: shown.year, month: shown.month }}'),
      'the issues follow the month actually viewed, not the two dropdowns')
    assert.ok(src.includes("onClick={() => setShown({ year, month })}"), 'set only on View')
    assert.ok(src.includes('No payroll issues were reported for this period.'))
  })

  test('both use the one queue component — there is no second implementation', () => {
    for (const p of [
      'src/app/payroll/results/[periodId]/page.tsx',
      'src/app/payroll/issues/page.tsx',
    ]) {
      const src = read(p)
      assert.ok(src.includes('ObjectionQueue'), `${p} must reuse the existing panel`)
      assert.equal(/buildIssueHistory|IssueHistoryModal/.test(src), false,
        `${p} must not restate the history behaviour the queue already has`)
    }
  })

  test('View Payroll no longer embeds the panel at all — Payroll Issues is the one place for it', () => {
    const src = read('src/app/payroll/monthly-review/page.tsx')
    assert.equal(src.includes('ObjectionQueue'), false,
      'embedding it here too would duplicate the same list Payroll Issues already shows')
  })

  test('Payroll Issues reads history; it does not become a second way to write one', () => {
    const src = read('src/app/payroll/issues/page.tsx')
    assert.equal(/from\('employee_record_objections'\)/.test(src), false)
    assert.equal(src.includes('/api/objections/review'), false,
      'reviewing stays in the queue component and its admin-only route')
  })
})

// ─── 4. The panel itself ──────────────────────────────────────────────────────

describe('a scoped queue states an empty run; an unscoped one still hides', () => {
  const queue = read('src/components/objections/ObjectionQueue.tsx')

  test('the empty state is reachable exactly when a run was named', () => {
    assert.ok(queue.includes('if (rows.length === 0 && !period) return null'))
    assert.ok(queue.includes('{emptyLabel}'), 'and the label is rendered')
  })

  test('the attendance correction log is untouched by any of this', () => {
    const src = read('src/app/attendance/correction-log/page.tsx')
    assert.equal(src.includes('period='), false,
      'attendance issues are keyed by date and belong to no payroll run')
  })

  test('the request is rebuilt when the run changes', () => {
    assert.ok(queue.includes('}, [token, subject, scopeQuery])'),
      'switching month must refetch, or the previous month issues stay on screen')
  })

  test('nothing in the panel deletes, archives or rewrites an issue', () => {
    for (const forbidden of ['.delete(', '.update(', 'archived']) {
      assert.equal(queue.includes(forbidden), false, `the queue must not ${forbidden}`)
    }
  })
})
