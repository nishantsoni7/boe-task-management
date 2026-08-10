/**
 * Authorization and privacy for the salary-processing report.
 *
 *   npx tsx --test src/app/api/payroll/salaryReportAuth.test.ts
 *
 * This route returns every employee's salary for a month in one response. It is
 * the most sensitive read in the payroll API, and the text built from it is
 * written to be pasted into WhatsApp — so what the route SELECTS is a privacy
 * decision, not just a performance one.
 *
 * These are source-level assertions. They are worth having because the failures
 * they catch are all silent: a route that gains an `employee_id` parameter, a
 * select list that grows a `description`, or a participation check rewritten by
 * hand all keep working perfectly while leaking.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const ROUTE = 'src/app/api/payroll/salary-report/route.ts'
const PAGE  = 'src/app/payroll/results/[periodId]/salary-report/page.tsx'

/**
 * The file with its comments removed.
 *
 * The "must not appear" assertions below are about what the route DOES, and the
 * route's comments necessarily name the very columns they explain excluding —
 * "deliberately not the adjustment description", "monthly_salary is absent".
 * Matching raw source would fail on the documentation that makes the code
 * trustworthy, which is exactly the wrong incentive.
 */
async function code(path: string): Promise<string> {
  const src = await readFile(path, 'utf8')
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/^\s*\/\/.*$/gm, '')       // whole-line comments
    .replace(/\/\/.*$/gm, '')           // trailing comments
}

describe('the route is admin-only', () => {
  test('it goes through the shared requireAdmin helper', async () => {
    const src = await readFile(ROUTE, 'utf8')
    assert.match(src, /requireAdmin/)
    assert.match(src, /const auth = await requireAdmin\(req\)/)
    assert.match(src, /if \(isResponse\(auth\)\) return auth/)
  })

  test('the admin check happens before anything is read', async () => {
    const src = await readFile(ROUTE, 'utf8')
    const authAt   = src.indexOf('requireAdmin(req)')
    const firstRead = src.indexOf(".from('payroll_")
    assert.ok(authAt > 0 && firstRead > 0)
    assert.ok(authAt < firstRead, 'a read must not precede the authorization check')
  })

  test('there is no self-service variant of this route', async () => {
    const src = await readFile(ROUTE, 'utf8')
    assert.doesNotMatch(src, /requireSelfOrAdmin/)
  })
})

describe('an employee cannot aim this route at somebody else', () => {
  test('the route takes no employee_id input at all', async () => {
    const src = await readFile(ROUTE, 'utf8')
    // There is nothing for a non-admin to point at: the only input is a period.
    assert.doesNotMatch(src, /searchParams\.get\('employee_id'\)/)
    assert.doesNotMatch(src, /searchParams\.get\("employee_id"\)/)
  })

  test('the only query parameter is the period', async () => {
    const src = await readFile(ROUTE, 'utf8')
    const params = [...src.matchAll(/searchParams\.get\('([^']+)'\)/g)].map(m => m[1])
    assert.deepEqual(params, ['period_id'])
  })

  test('the caller identity comes from the token, never from the request', async () => {
    const src = await readFile(ROUTE, 'utf8')
    // requireAdmin resolves the caller from the Authorization header. Nothing
    // here may read an identity out of the body or the query string.
    assert.doesNotMatch(src, /body\.(caller|user|employee)/)
  })
})

describe('what the route selects', () => {
  test('the adjustment description is NOT selected', async () => {
    const src = await readFile(ROUTE, 'utf8')
    const adjSelect = /\.from\('payroll_pending_adjustments'\)\s*\n\s*\.select\('([^']+)'\)/.exec(src)
    assert.ok(adjSelect, 'could not find the adjustments select')
    assert.doesNotMatch(adjSelect[1]!, /description/,
      'admins write private context in description; it must not travel to WhatsApp')
    assert.match(adjSelect[1]!, /adjustment_category/, 'the category is what the report states')
  })

  test('the employee’s current monthly_salary is NOT selected', async () => {
    const src = await code(ROUTE)
    // gross_salary is what payroll RECORDED for the month. An employee's current
    // salary is a different fact with no business on a processing report.
    assert.doesNotMatch(src, /monthly_salary/)
  })

  test('no attendance, objection, comment, remark or settings column is read', async () => {
    const src = await code(ROUTE)
    for (const forbidden of [
      /attendance_records/, /check_in_at/, /check_out_at/, /punch/,
      /objection/, /comment/, /remark/, /correction/,
      /settings_snapshot/, /payroll_settings/,
    ]) {
      assert.doesNotMatch(src, forbidden, `the report route reads ${forbidden}`)
    }
  })
})

describe('who appears on the report', () => {
  test('participation is decided by the shared predicate, not a hand-written filter', async () => {
    const src = await readFile(ROUTE, 'utf8')
    assert.match(src, /participatesInPayroll/)
    // A hand-rolled check here is how this list and real generation drift apart.
    assert.doesNotMatch(src, /\.eq\('payroll_active', true\)/)
  })

  test('deleted and payroll-excluded employees are filtered out', async () => {
    const src = await readFile(ROUTE, 'utf8')
    assert.match(src, /is_deleted/)
    assert.match(src, /excluded\.push/)
  })

  test('an adjustment belonging to an excluded employee cannot travel in the response', async () => {
    const src = await readFile(ROUTE, 'utf8')
    // The response is the boundary, not the renderer: filtering only at render
    // time would still ship the row to the browser.
    assert.match(src, /includedIds\.has\(row\.employee_id\)/)
  })
})

describe('the route does not mutate anything', () => {
  test('it is a read — no insert, update, delete or RPC', async () => {
    const src = await readFile(ROUTE, 'utf8')
    for (const write of [/\.insert\(/, /\.update\(/, /\.delete\(/, /\.upsert\(/, /\.rpc\(/]) {
      assert.doesNotMatch(src, write, `the report route performs a write: ${write}`)
    }
  })

  test('only GET is exported', async () => {
    const src = await readFile(ROUTE, 'utf8')
    assert.match(src, /export async function GET/)
    for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.doesNotMatch(src, new RegExp(`export async function ${verb}`))
    }
  })
})

describe('the page does not calculate salary', () => {
  test('it renders through the shared report builder', async () => {
    const src = await readFile(PAGE, 'utf8')
    assert.match(src, /buildSalaryReport/)
    assert.match(src, /renderReportText/)
  })

  test('it never runs the payroll engine in the browser', async () => {
    const src = await readFile(PAGE, 'utf8')
    assert.doesNotMatch(src, /generatePayrollForEmployee/)
    assert.doesNotMatch(src, /PER_DAY_DIVISOR/)
    assert.doesNotMatch(src, /per_day_rate/)
  })

  test('Copy sends exactly the previewed string', async () => {
    const src = await readFile(PAGE, 'utf8')
    // Both the preview block and the clipboard write use `reportText`.
    assert.match(src, /clipboard\.writeText\(reportText\)/)
    assert.match(src, /\{reportText\}/)
  })

  test('an over-long WhatsApp report opens no link and is not truncated', async () => {
    const src = await readFile(PAGE, 'utf8')
    // The failure branch sets an error and returns before window.open.
    assert.match(src, /if \(!whatsapp\.ok\) \{[\s\S]*?setError\(whatsapp\.message\)[\s\S]*?return/)
    assert.doesNotMatch(src, /\.slice\(0,\s*WHATSAPP/)
    assert.doesNotMatch(src, /substring\(0/)
  })

  test('the character count is shown to the admin', async () => {
    const src = await readFile(PAGE, 'utf8')
    assert.match(src, /encodedLength/)
    assert.match(src, /WHATSAPP_URL_TEXT_LIMIT/)
  })

  test('the selected count is shown', async () => {
    const src = await readFile(PAGE, 'utf8')
    assert.match(src, /selected\.size\} of \{results\.length\} selected/)
  })
})
