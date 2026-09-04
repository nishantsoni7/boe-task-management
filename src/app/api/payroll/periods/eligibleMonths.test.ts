/**
 * GET /api/payroll/periods/eligible-months — which months the Create Payroll
 * Period picker may offer, and why the current month specifically is missing
 * when it is.
 *
 * Run:
 *   npx tsx --test src/app/api/payroll/periods/eligibleMonths.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const route = read('src/app/api/payroll/periods/eligible-months/route.ts')

describe('the eligibility list is admin-gated and reuses the real rule', () => {
  test('requireAdmin, not a hand-rolled check', () => {
    assert.match(route, /requireAdmin\(req\)/)
  })

  test('a future month is never a candidate at all', () => {
    assert.match(route, /isFutureMonth\(/)
  })

  test('attendance existence is checked with the same helper the create route enforces', () => {
    assert.match(route, /monthsWithAttendance\(/)
    assert.match(route, /from '@\/lib\/attendance\/attendanceExists'/)
  })

  test('a month with an existing period is excluded before any attendance check runs', () => {
    // No point paying for a query whose answer cannot change the outcome.
    const fn = route.slice(route.indexOf('const needsAttendanceCheck'))
    assert.match(fn.slice(0, 300), /!hasPeriod\.has\(/)
  })
})

describe('the current month is named explicitly when it is the one held back', () => {
  test('current_month_unavailable is only set when the current month has neither a period nor attendance', () => {
    const fn = route.slice(route.indexOf('const currentIsEligible'))
    assert.match(fn, /!currentIsEligible && !currentHasPeriod/)
  })

  test('the response always carries both fields, never just one or the other', () => {
    assert.match(route, /NextResponse\.json\(\{ eligible, current_month_unavailable: currentMonthUnavailable \}\)/)
  })
})

describe('the window is bounded, not the full multi-year picker range', () => {
  test('a documented, small back-window — not one existence query per selectable year', () => {
    assert.match(route, /MONTHS_BACK\s*=\s*11/)
  })
})

describe('newest first, so the most likely month an admin wants is first in the list', () => {
  test('the eligible list is sorted descending by year then month', () => {
    const fn = route.slice(route.indexOf('const eligible ='))
    assert.match(fn.slice(0, 500), /\(b\.year - a\.year\) \|\| \(b\.month - a\.month\)/)
  })
})
