/**
 * View Payroll — a generated month redirects to the stored payslip experience;
 * a Draft period stays on this page with Generate Payroll as its action; an
 * ungenerated month with attendance offers Create Payroll Period; a month with
 * no attendance explains why rather than showing a table of zeros. The admin
 * should never have to know that Payroll Runs / Results and Payroll Monthly
 * Preview are two different screens.
 *
 * These are source-text assertions, matching this codebase's existing style
 * for client-page wiring (see attendancePayrollNav.test.tsx). Further coverage
 * of the Create/Generate actions and the readiness strip lives in
 * src/app/payroll/payrollRunsConsolidation.test.ts — this file stays focused
 * on the generated/locked → redirect decision and its ordering.
 *
 * Run:
 *   npx tsx --test src/app/payroll/viewPayrollRedirect.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const viewPayroll = read('src/app/payroll/monthly-review/page.tsx')
const results     = read('src/app/payroll/results/[periodId]/page.tsx')

describe('View Payroll decides generated-vs-live before it fetches or renders anything', () => {
  test('the check reads payroll_periods directly — no new API route for one field', () => {
    // payroll_periods is SELECT-able by any authenticated user (see
    // 20260611_create_payroll_periods.sql), so this needs no service-role
    // route: it is exactly the kind of read the RLS policy already allows.
    assert.match(viewPayroll, /from\('payroll_periods'\)/)
    assert.match(viewPayroll, /\.eq\('payroll_year',\s*y\)/)
    assert.match(viewPayroll, /\.eq\('payroll_month',\s*m\)/)
  })

  test('only "generated" or "locked" redirects — a draft period stays on the live preview', () => {
    const fn = viewPayroll.slice(viewPayroll.indexOf('const periodFor'))
    assert.match(fn, /status === 'generated'/)
    assert.match(fn, /status === 'locked'/)
    // A Draft period is handled as its OWN third state — the redirect branch
    // must not also fire for it.
    const openMonth = viewPayroll.slice(viewPayroll.indexOf('const openMonth'), viewPayroll.indexOf('useEffect(() => {'))
    const redirectIf = openMonth.slice(0, openMonth.indexOf("router.push(`/payroll/results/"))
    assert.equal(/'draft'/.test(redirectIf), false, 'draft must not be treated as generated')
  })

  test('the redirect happens before the preview is fetched, on the initial load path', () => {
    const init = viewPayroll.slice(viewPayroll.indexOf('const init = async'), viewPayroll.indexOf('init()'))
    const checkAt    = init.indexOf('periodFor(')
    const redirectAt = init.indexOf("router.push(`/payroll/results/")
    const previewAt  = init.indexOf('loadPreview(')
    assert.ok(checkAt !== -1 && redirectAt !== -1 && previewAt !== -1, 'all three steps must be present')
    assert.ok(checkAt < redirectAt && redirectAt < previewAt,
      'the period must be checked, then redirected on, before ever loading the preview')
  })

  test('the redirect happens before the preview is fetched, on the month-selector path too', () => {
    const openMonth = viewPayroll.slice(viewPayroll.indexOf('const openMonth'), viewPayroll.indexOf('useEffect(() => {'))
    const checkAt    = openMonth.indexOf('periodFor(')
    const redirectAt = openMonth.indexOf("router.push(`/payroll/results/")
    const previewAt  = openMonth.indexOf('loadPreview(')
    assert.ok(checkAt < redirectAt && redirectAt < previewAt)
  })

  test('the full-page loading screen covers the decision — nothing flashes on the way to a redirect', () => {
    // setLoading(false) must not run until AFTER the generated-period check
    // has already decided to stay; if it ran earlier, the placeholder or an
    // empty table would flash before router.push takes effect.
    const init = viewPayroll.slice(viewPayroll.indexOf('const init = async'), viewPayroll.indexOf('init()'))
    const checkAt = init.indexOf('periodFor(')
    const loadingFalseAt = init.indexOf('setLoading(false)')
    assert.ok(checkAt < loadingFalseAt, 'setLoading(false) must come after the redirect decision')
  })

  test('the page reads as "View Payroll", not "Monthly Preview" — the nav-facing name and the on-screen title agree', () => {
    assert.match(viewPayroll, /title="View Payroll"/)
  })
})

describe('a generated month redirects with enough context for the results page to send the admin back correctly', () => {
  test('the redirect carries a marker distinguishing it from the Payroll Runs list', () => {
    assert.match(viewPayroll, /router\.push\(`\/payroll\/results\/\$\{period\.id\}\?from=view-payroll`\)/)
  })

  test('the results page reads that marker and returns to View Payroll, not to period administration', () => {
    assert.match(results, /searchParams\.get\('from'\)\s*===\s*'view-payroll'/)
    assert.match(results, /fromViewPayroll \? '\/payroll\/monthly-review' : '\/payroll'/)
  })

  test('reading the marker is wrapped in the Suspense boundary useSearchParams requires', () => {
    assert.match(results, /<Suspense/)
    assert.match(results, /useSearchParams/)
  })

  test('the marker only ever decides where "back" points — it grants no access', () => {
    // It must never gate data fetching, editing, or any admin action; those
    // stay governed by the existing period/profile checks untouched by this.
    const usages = [...results.matchAll(/fromViewPayroll/g)].length
    // Declared once, read once (in the back-link's destination/label) — a
    // third usage would mean it started controlling something else.
    assert.ok(usages >= 2 && usages <= 4, `fromViewPayroll used ${usages} times — check nothing new depends on it`)
  })
})
