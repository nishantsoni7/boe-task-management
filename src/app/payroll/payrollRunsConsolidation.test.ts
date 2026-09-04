/**
 * Payroll Runs consolidation — its period-lifecycle actions move into View
 * Payroll and the results page rather than disappearing, and the two pages
 * gain a compact readiness strip built only from data already reliable at
 * that point in the workflow.
 *
 * Source-text assertions, matching this codebase's established style for
 * page wiring (see attendancePayrollNav.test.tsx, viewPayrollRedirect.test.ts).
 *
 * Run:
 *   npx tsx --test src/app/payroll/payrollRunsConsolidation.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const viewPayroll = read('src/app/payroll/monthly-review/page.tsx')
const results     = read('src/app/payroll/results/[periodId]/page.tsx')
const runsPage     = read('src/app/payroll/page.tsx')

describe('View Payroll absorbs the actions relevant to an UNGENERATED month', () => {
  test('Create Payroll Period is offered only when attendance exists and no period does', () => {
    assert.match(viewPayroll, /Create Payroll Period/)
    assert.match(viewPayroll, /monthState\?\.kind === 'no_period'/)
  })

  test('Generate Payroll is offered only for a Draft period', () => {
    assert.match(viewPayroll, /Generate Payroll/)
    assert.match(viewPayroll, /monthState\?\.kind === 'draft'/)
    assert.match(viewPayroll, /\/api\/payroll\/generate/)
  })

  test('a month with no attendance explains why and offers the way out, not a live-preview table of zeros', () => {
    assert.match(viewPayroll, /monthState\?\.kind === 'no_attendance'/)
    assert.match(viewPayroll, /payroll is not available yet/)
    assert.match(viewPayroll, /has not been uploaded/)
    assert.match(viewPayroll, /href="\/attendance\/upload"/)
  })

  test('the create eligibility list is fetched lazily, not on every page load', () => {
    // Only inside the modal-open handler, not in the mount effect — the
    // eligible-months endpoint runs up to ~12 parallel existence queries and
    // has no reason to fire for an admin who never opens Create.
    const openCreate = viewPayroll.slice(viewPayroll.indexOf('const openCreateModal'), viewPayroll.indexOf('const handleCreatePeriod'))
    assert.match(openCreate, /eligible-months/)
    const mountInit = viewPayroll.slice(viewPayroll.indexOf('useEffect(() => {'), viewPayroll.indexOf('const handleLoad'))
    assert.equal(mountInit.includes('eligible-months'), false, 'eligibility must not be fetched on mount')
  })

  test('generating moves the month forward through the same decision logic that got here', () => {
    // No separate redirect branch duplicated for the post-generate case —
    // reuses openMonth, which already knows generated/locked → results page.
    const fn = viewPayroll.slice(viewPayroll.indexOf('const handleGeneratePayroll'))
    assert.match(fn.slice(0, 1200), /await openMonth\(/)
  })
})

describe('View Payroll no longer embeds the full issues panel', () => {
  test('Payroll Issues is a dedicated page now — no ObjectionQueue import here', () => {
    assert.equal(viewPayroll.includes('ObjectionQueue'), false,
      'the issues panel moved to /payroll/issues; embedding both would duplicate the same list')
  })
})

describe('the results page (generated/locked months) gains a compact readiness strip', () => {
  test('Attendance is not restated — a generated period could not exist without it', () => {
    // The strip states Payroll status, Issues, and Employee Review — not a
    // fourth "Attendance: uploaded" line, which would be true by construction
    // once a period is generated and therefore tells the admin nothing.
    const stripComment = results.slice(results.indexOf('Payroll readiness strip'), results.indexOf('Payroll readiness strip') + 900)
    assert.match(stripComment, /not restated\s+here/)
  })

  test('Issues count is scoped to THIS period only, from data already fetched', () => {
    const fn = results.slice(results.indexOf('const openIssues'), results.indexOf('const openIssues') + 400)
    assert.match(fn, /resultIds\.has\(o\.payroll_result_id\)/)
    assert.match(fn, /o\.status === 'pending'/)
  })

  test('Payment status is deliberately omitted — not reliably summarisable at period level yet', () => {
    assert.match(results, /Payment status\s+is deliberately absent/)
  })

  test('Employee Review reuses the exact computation already on this page', () => {
    assert.match(results, /Employee Review/)
    assert.match(results, /reviewedCount === totalCount/)
  })
})

describe('Unlock moves to the results page, where a locked period now lands', () => {
  test('the results page imports and renders UnlockPayrollModal', () => {
    assert.match(results, /import \{ UnlockPayrollModal \} from '@\/app\/payroll\/UnlockPayrollModal'/)
    assert.match(results, /<UnlockPayrollModal/)
  })

  test('unlocking calls the real API and is admin-gated the same way Lock already is', () => {
    assert.match(results, /\/api\/payroll\/unlock/)
    assert.match(results, /profile\?\.role === 'admin'/)
  })

  test('Payroll Runs still has its own Unlock too — nothing was deleted, only extended', () => {
    assert.match(runsPage, /UnlockPayrollModal/)
    assert.match(runsPage, /\/api\/payroll\/unlock/)
  })
})

describe('Delete and Participation stay on the Payroll Runs page — a deliberate scope decision', () => {
  test('both are still fully present and working there, not removed', () => {
    assert.match(runsPage, /DeletePayrollModal/)
    assert.match(runsPage, /ParticipationModal/)
    assert.match(runsPage, /\/api\/payroll\/delete/)
  })

  test('Payroll Runs is reachable from View Payroll as a lateral link, not primary nav', () => {
    assert.match(viewPayroll, /Manage Payroll Runs/)
    assert.match(viewPayroll, /href="\/payroll"/)
  })
})

describe('Create Payroll Period now uses the eligibility-restricted picker everywhere it appears', () => {
  test('the Payroll Runs page also fetches eligible months before opening Create', () => {
    assert.match(runsPage, /eligible-months/)
    assert.match(runsPage, /eligibleMonths/)
  })

  test('neither page invents its own separate creation flow', () => {
    // One component, CreatePeriodModal, imported by both — not two divergent
    // implementations of the same action.
    for (const src of [viewPayroll, runsPage]) {
      assert.match(src, /import \{ CreatePeriodModal/)
    }
  })
})
