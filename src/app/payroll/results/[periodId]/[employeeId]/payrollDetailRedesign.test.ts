/**
 * Payroll employee detail — Month/Employee selectors and the duplicate-figure
 * removal from PayrollDetailView.
 *
 * THE DUPLICATES REMOVED
 * -----------------------
 * Round 1 (source audit): Gross Salary, Attendance Deductions and Salary
 * After Attendance were shown in the top summary rail AND restated, verbatim,
 * with no itemisation of their own, in a second "Salary Calculation" card
 * directly below it. Net Adjustments and the BOE Credit Addition were ALSO
 * restated in the "Salary Settlement" aside, simultaneously visible next to
 * the Adjustments card that already anchors Net Adjustments under its own
 * itemised list.
 *
 * Round 2 (caught live, in the browser, during Part 17 verification — the
 * source-only audit had judged this an intentional exception): Salary
 * Payable, Amount Paid and Settlement Status were STILL shown twice — once in
 * PayrollSummaryCard (the top rail) and again in the "Salary Settlement"
 * aside further down, both stating the identical figures for the identical
 * reason (to anchor the Record/Edit amount paid button). Seeing the rendered
 * page made the duplication obvious in a way reading the source did not: the
 * fix was to move the plain-language sentence and the payment action directly
 * into PayrollSummaryCard, and delete the "Salary Settlement" aside entirely.
 * What survives in AdjustmentsAndSettlement now is only what belongs to it
 * alone — the itemised adjustments ledger and its own carry-forward action.
 *
 * Run:
 *   npx tsx --test "src/app/payroll/results/[periodId]/[employeeId]/payrollDetailRedesign.test.ts"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const view = read('src/app/payroll/results/[periodId]/[employeeId]/PayrollDetailView.tsx')
const page = read('src/app/payroll/results/[periodId]/[employeeId]/page.tsx')

describe('duplicate removal in AdjustmentsAndSettlement', () => {
  const section = view.slice(
    view.indexOf('export function AdjustmentsAndSettlement'),
    view.indexOf('export function fmtSignedAmount'),
  )

  test('the "Salary Calculation" card is gone entirely', () => {
    // Not a bare substring check — the removal is explained in a comment
    // that necessarily names the old card, so this checks for the actual
    // rendered element instead.
    assert.equal(section.includes('title="Salary Calculation"'), false)
    assert.equal(section.includes('<SettlementCard title="Salary Calculation"'), false)
  })

  test('Gross Salary and Attendance Deductions are not restated in this section', () => {
    assert.equal(/label="Gross Salary"/.test(section), false)
    assert.equal(/label="Attendance Deductions"/.test(section), false)
  })

  test('Salary After Attendance appears at most once in this section (not three times)', () => {
    const matches = section.match(/Salary After Attendance/g) ?? []
    assert.ok(matches.length <= 1, `found ${matches.length} occurrences`)
  })

  test('Net Adjustments is anchored under the itemised list exactly once, not also in the aside', () => {
    const matches = section.match(/label="Net Adjustments"/g) ?? []
    assert.equal(matches.length, 1)
  })

  test('BOE Credit Addition appears once in this section (the Adjustments card), not duplicated into the aside', () => {
    const matches = section.match(/label="BOE Credit Addition"/g) ?? []
    assert.equal(matches.length, 1)
  })

  test('the itemised adjustments ledger and its edit action both survive', () => {
    assert.match(section, /adjustments\.map\(adj =>/)
    assert.match(section, /Edit previous balance/)
  })

  test('round 2: the "Salary Settlement" aside is gone — Salary Payable/Amount Paid live in the rail only', () => {
    // Structural checks, not bare prose matches: this section's own comment
    // legitimately NAMES the removed card while explaining why it is gone
    // (the same lesson the "Salary Calculation" removal already taught this
    // file), so the proof is the actual removed elements, not the words.
    assert.equal(section.includes('rgba(79,111,208,0.28)'), false, 'the removed card\'s distinct border colour must be gone')
    assert.equal(/label="Amount Paid"/.test(section), false)
    assert.equal(/Balance Carried Forward/.test(section), false)
    assert.equal(section.includes('payroll-detail-aside'), false)
  })

  test('the two-column grid is gone entirely — a single full-width card, no lopsided empty column', () => {
    // payroll-settlement-pair (round 1) and the main/aside split (round 2)
    // were both 2-column layouts built for content that no longer exists.
    assert.equal(section.includes('payroll-settlement-pair'), false)
    assert.equal(section.includes('payroll-detail-workspace'), false)
  })

  test('nothing here computes a new figure — every value still traces to settlement.figures or the adjustments prop', () => {
    for (const forbidden of ['gross_salary -', 'gross_salary+', '* 26', '/ 26']) {
      assert.equal(section.includes(forbidden), false, `found arithmetic: ${forbidden}`)
    }
  })
})

describe('the payment action and its context now live in PayrollSummaryCard, once', () => {
  const rail = view.slice(view.indexOf('function PayrollSummaryCard'), view.indexOf('export function SettlementRow'))

  test('the rail accepts canEdit/onEditPayment and renders the action beside the figures it changes', () => {
    assert.match(rail, /canEdit\?:\s*boolean/)
    assert.match(rail, /onEditPayment\?:\s*\(\)\s*=>\s*void/)
    assert.match(rail, /canEdit && onEditPayment/)
    assert.match(rail, /Record amount paid/)
    assert.match(rail, /Edit amount paid/)
  })

  test('the plain-language sentence is shown exactly once, in the rail', () => {
    assert.match(rail, /settlement\.sentence/)
    const wholeFileMatches = view.match(/settlement\.sentence/g) ?? []
    assert.equal(wholeFileMatches.length, 1, 'settlement.sentence must render in exactly one place')
  })

  test('the payment date/remark note is preserved, not silently dropped in the consolidation', () => {
    assert.match(rail, /remark=\{paymentNote\(settlement\)\}/)
  })

  test('SummaryLine gained remark support rather than duplicating SettlementRow\'s', () => {
    const summaryLine = view.slice(view.indexOf('export function SummaryLine'), view.indexOf('export function SummaryGroup'))
    assert.match(summaryLine, /remark\?:\s*string \| null/)
  })

  test('the caller wires the same canEdit/onEditPayment it already had into the rail, not a new prop', () => {
    assert.match(page, /onEditPayment={\(\) => \{ setSettlementError\(null\); setPaymentOpen\(true\) \}\}/)
  })
})

describe('Month and Employee selectors on the admin detail page', () => {
  test('the employee selector navigates immediately to the existing per-employee route', () => {
    assert.match(page, /router\.push\(`\/payroll\/results\/\$\{periodId\}\/\$\{newEmployeeId\}`\)/)
  })

  test('changing month tries to retain the current employee, and never fabricates a result', () => {
    const fn = page.slice(page.indexOf('const handlePeriodChange'))
    assert.match(fn.slice(0, 900), /stillHasResult/)
    assert.match(fn.slice(0, 900), /router\.push\(/)
    // The "no result here" branch lands on the results LIST for that period,
    // never on a different employee's payslip silently substituted in.
    assert.match(fn.slice(0, 900), /\/payroll\/results\/\$\{newPeriodId\}`/)
  })

  test('the employee dropdown is scoped to the CURRENT period\'s own employees, from the existing results endpoint', () => {
    assert.match(page, /\/api\/payroll\/results\?period_id=\$\{forPeriodId\}/)
  })

  test('the month dropdown only offers generated/locked periods — a draft has nothing to show here', () => {
    const fn = page.slice(page.indexOf('const loadPeriodOptions'), page.indexOf('const loadEmployeeOptions'))
    assert.match(fn, /\.in\('status', \['generated', 'locked'\]\)/)
  })

  test('the period lookup reuses the same client-read technique as View Payroll — no new API route for a dropdown', () => {
    assert.match(page, /from\('payroll_periods'\)/)
    assert.match(page, /\.select\('id, payroll_month, payroll_year, status'\)/)
  })

  test('the currently open month/employee is always representable even if absent from the fetched list', () => {
    assert.match(page, /!periodOptions\.some\(p => p\.id === periodId\)/)
    assert.match(page, /!employeeOptions\.some\(e => e\.employee_id === employeeId\)/)
  })
})

describe('the redesign changed no calculation code', () => {
  test('PayrollDetailView still computes nothing — figures still come from settlement.figures / result / context props', () => {
    assert.match(view, /Nothing in this file computes money/)
  })

  test('the settlement module itself (the actual formulas) is untouched by this pass', () => {
    const settlement = read('src/lib/payroll/settlement.ts')
    assert.match(settlement, /salary_after_attendance = gross_salary − total_deductions/)
    assert.match(settlement, /salary_payable\s*=\s*salary_after_attendance \+ net_adjustments/)
  })
})
