/**
 * Reaching (and not reaching) the payroll guide.
 *
 * Three things this pins, each of which was a deliberate decision rather than an
 * accident of layout:
 *
 *   1. The guide card is GONE from Payroll Result Detail. That page is one
 *      employee's salary and settlement; a module-wide explainer competed with
 *      the figures it was meant to explain.
 *   2. "How Payroll Works" is in BOTH sidebars — the Payroll one for admins and
 *      the Attendance one for employees, who never see the Payroll sidebar at all
 *      and would otherwise have no route to the page.
 *   3. Both link to the SAME constant, so the guard's exception and the links
 *      cannot drift apart into a redirect loop or a locked-out employee.
 *
 * Source-level assertions: these are structural facts about which files
 * reference what, and checking them by reading the files is both accurate and
 * free of a React renderer.
 *
 * Run:
 *   npx tsx --test src/app/payroll/payrollGuideAccess.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PAYROLL_GUIDE_PATH } from '@/lib/payroll/guidePath'

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8')

const DETAIL_VIEW = read('src', 'app', 'payroll', 'results', '[periodId]', '[employeeId]', 'PayrollDetailView.tsx')
const PAYROLL_NAV = read('src', 'components', 'layout', 'PayrollLayout.tsx')
const ATTEND_NAV  = read('src', 'components', 'layout', 'AttendanceLayout.tsx')
const GUARD       = read('src', 'app', 'payroll', 'layout.tsx')

// ─── 1. The guide card is gone from Payroll Detail ────────────────────────────

describe('Payroll Result Detail', () => {
  test('no longer carries the "Want to understand this calculation?" card', () => {
    assert.equal(
      DETAIL_VIEW.includes('Want to understand this calculation'), false,
      'the guide card is still rendered on Payroll Result Detail',
    )
    assert.equal(DETAIL_VIEW.includes('View how payroll works'), false)
  })

  test('the component that rendered it is deleted, not merely unused', () => {
    assert.equal(DETAIL_VIEW.includes('function HowPayrollWorksLink'), false)
    assert.equal(DETAIL_VIEW.includes('<HowPayrollWorksLink'), false)
  })

  test('nothing was left behind that would replace it — no banner, accordion or link', () => {
    // The instruction was to remove it and not substitute another affordance.
    assert.equal(DETAIL_VIEW.includes(PAYROLL_GUIDE_PATH), false, 'detail still links to the guide')
    assert.equal(DETAIL_VIEW.includes('guidePath'), false, 'the guide path import is still present')
  })

  test('the accordion it originally replaced has not come back either', () => {
    assert.equal(DETAIL_VIEW.includes('CalculationRulesSection'), false)
    assert.equal(DETAIL_VIEW.includes('How Attendance & Payroll Is Calculated'), false)
  })
})

// ─── 2 + 3. The guide is in both navigations, via the shared constant ─────────

describe('navigation', () => {
  test('the Payroll sidebar offers "How Payroll Works"', () => {
    assert.match(PAYROLL_NAV, /label: 'How Payroll Works'/)
    assert.match(PAYROLL_NAV, /path: PAYROLL_GUIDE_PATH/)
  })

  test('the Attendance sidebar offers it to employees', () => {
    // Employees never render PayrollLayout — /payroll redirects them — so this
    // is their only route to the page.
    assert.match(ATTEND_NAV, /label: 'How Payroll Works'/)
    assert.match(ATTEND_NAV, /path: PAYROLL_GUIDE_PATH/)
  })

  test('neither sidebar hard-codes the route string', () => {
    // A typo in one of three places would either lock employees out or send
    // them into the guard's redirect.
    for (const [name, source] of [['PayrollLayout', PAYROLL_NAV], ['AttendanceLayout', ATTEND_NAV]] as const) {
      assert.match(source, /from '@\/lib\/payroll\/guidePath'/, `${name} does not import the constant`)
      assert.equal(
        source.includes(`'${PAYROLL_GUIDE_PATH}'`), false,
        `${name} hard-codes the guide path instead of importing it`,
      )
    }
  })

  test('the employee entry is added without disturbing the admin list', () => {
    // The admin branch of AttendanceLayout is a different array; the guide
    // belongs to the employee one, beside My Payroll.
    const employeeBranch = ATTEND_NAV.slice(ATTEND_NAV.indexOf(': ['))
    assert.ok(employeeBranch.includes("label: 'My Payroll'"))
    assert.ok(employeeBranch.includes("label: 'How Payroll Works'"))
  })
})

// ─── The guard admits everybody to exactly this one route ────────────────────

describe('access', () => {
  test('the guard opens the guide to any signed-in user', () => {
    assert.match(GUARD, /PAYROLL_GUIDE_PATH/)
    assert.match(GUARD, /guide_only/)
  })

  test('and to no other payroll route', () => {
    // guide_only renders children only when the path IS the guide; every other
    // path falls through to the redirect.
    assert.match(GUARD, /access === 'guide_only' && isGuide/)
    assert.match(GUARD, /router\.replace/)
  })

  test('the guide route the guard admits is the route the links point at', () => {
    assert.equal(PAYROLL_GUIDE_PATH, '/payroll/how-it-works')
  })
})

// ─── The guide exposes no employee data ──────────────────────────────────────

describe('the guide page carries no employee data', () => {
  const PAGE = read('src', 'app', 'payroll', 'how-it-works', 'page.tsx')

  test('reads no payroll table', () => {
    for (const table of [
      'payroll_results', 'payroll_settlements', 'payroll_deduction_lines',
      'payroll_pending_adjustments', 'attendance_records',
    ]) {
      assert.equal(PAGE.includes(table), false, `the guide queries ${table}`)
    }
  })

  test('reads no other employee, and no salary column', () => {
    assert.equal(PAGE.includes('monthly_salary'), false)
    assert.equal(PAGE.includes('employee_id'), false)
    // The only users row it touches is the caller's own profile, for the layout
    // header — scoped by the session's own id.
    assert.match(PAGE, /\.eq\('id', session\.user\.id\)/)
  })

  test('calls no payroll API that returns figures', () => {
    for (const route of ['/api/payroll/results', '/api/payroll/my-result', '/api/payroll/periods']) {
      assert.equal(PAGE.includes(route), false, `the guide calls ${route}`)
    }
  })
})
