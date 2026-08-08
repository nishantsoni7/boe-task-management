/**
 * Where a raised issue surfaces for the admin, and what it may not do.
 *
 * The complaint in acceptance testing was not that objections were insecure —
 * they were not — but that an admin could miss one entirely. So these tests are
 * about REACHABILITY: the notification exists, it points somewhere useful, the
 * indicator travels with the row, and the review panel sits on the screen where
 * an admin is already looking at that record.
 *
 * The security side is proved elsewhere, against the database, in
 * src/lib/security/objectionIsolation.test.ts.
 *
 * Run:
 *   npx tsx --test src/lib/objectionVisibility.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getNotificationMeta } from './notificationMeta'
import { ISSUE_PARAM, payrollObjectionHref, type AdminObjectionRow } from './objections'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const notif = (type: string, entityId: string | null = 'obj-1'): any => ({
  id: 'n1', type, title: 'x', body: null, is_read: false,
  created_at: new Date().toISOString(), entity_id: entityId, task_id: null,
})

describe('an issue notification lands where the admin can act on it', () => {
  test('an attendance issue opens the correction workflow', () => {
    const meta = getNotificationMeta(notif('attendance_issue_raised'))
    assert.equal(meta.href, '/attendance/correction-log')
    assert.equal(meta.heading, 'Attendance')
    assert.ok(meta.actionLabel)
  })

  // The gap this closes: a payroll issue used to land on /payroll — the list of
  // PERIODS. An admin arriving there still had to find the month, then the
  // employee, then the issue, which is the opposite of "click the notification
  // and read the reason". It now carries the objection id, which /payroll trades
  // for the disputed payslip.
  test('a payroll issue carries the objection through to the disputed result', () => {
    const meta = getNotificationMeta(notif('payroll_issue_raised', 'obj-9'))
    assert.equal(meta.href, `/payroll?${ISSUE_PARAM}=obj-9`)
    assert.equal(meta.heading, 'Payroll')
    assert.notEqual(meta.href, '/payroll', 'the bare periods list is not a review context')
  })

  test('neither falls through to a link-less generic notification', () => {
    for (const t of ['attendance_issue_raised', 'payroll_issue_raised']) {
      const meta = getNotificationMeta(notif(t))
      assert.ok(meta.href && meta.href !== '#', `${t} must resolve to a real destination`)
    }
  })

  test('a missing entity_id degrades to the module rather than to a broken link', () => {
    const meta = getNotificationMeta(notif('payroll_issue_raised', null))
    assert.equal(meta.href, '/payroll')
  })

  // These used to fall through to the neutral "Activity" chip, which reads as a
  // log line rather than as a person disputing their attendance or their pay.
  test('both carry an issue badge, not the generic Activity fallback', () => {
    for (const t of ['attendance_issue_raised', 'payroll_issue_raised']) {
      const { badge } = getNotificationMeta(notif(t))
      assert.notEqual(badge.label, 'Activity', `${t} must not use the neutral fallback`)
      assert.match(badge.label, /issue/i)
    }
  })
})

describe('the payroll destination is derived, never assembled from the URL', () => {
  const row = (payroll_result: AdminObjectionRow['payroll_result'], resultId: string | null = 'res-1') =>
    ({
      id: 'o1', employee_id: 'emp-1', attendance_date: null, payroll_result_id: resultId,
      reason: 'r', subject_snapshot: 's', status: 'pending', reviewed_by: null,
      reviewed_at: null, review_note: null, created_at: '', payroll_result,
    }) as AdminObjectionRow

  test('the route is the period and employee of the result the objection names', () => {
    assert.equal(
      payrollObjectionHref(row({ payroll_period_id: 'per-1', employee_id: 'emp-1' })),
      '/payroll/results/per-1/emp-1',
      'the admin lands on the existing payslip route, not on a new screen',
    )
  })

  test('a to-one embed returned as an array resolves the same way', () => {
    assert.equal(
      payrollObjectionHref(row([{ payroll_period_id: 'per-1', employee_id: 'emp-1' }])),
      '/payroll/results/per-1/emp-1',
    )
  })

  test('an attendance objection has no payroll route', () => {
    assert.equal(payrollObjectionHref(row(null, null)), null)
  })

  test('a result that no longer exists yields no link rather than a broken one', () => {
    assert.equal(payrollObjectionHref(row(null)), null)
    assert.equal(payrollObjectionHref(row({ payroll_period_id: null, employee_id: 'emp-1' })), null)
    assert.equal(payrollObjectionHref(row({ payroll_period_id: 'per-1', employee_id: null })), null)
  })

  test('the employee id comes from the payroll result, never from the objection row', () => {
    // Belt and braces: even if an objection row somehow carried a mismatched
    // employee_id, the route is built from the RESULT the database joined.
    const mismatched = row({ payroll_period_id: 'per-1', employee_id: 'emp-real' })
    mismatched.employee_id = 'emp-spoofed'
    assert.equal(payrollObjectionHref(mismatched), '/payroll/results/per-1/emp-real')
  })
})

describe('the resolver hands out no authority of its own', () => {
  const api  = read('src/app/api/objections/route.ts')
  const page = read('src/app/payroll/page.tsx')

  test('only an admin is given the result period and employee', () => {
    const embed = 'payroll_result:payroll_result_id ( payroll_period_id, employee_id )'
    assert.ok(api.includes(embed), 'the route keys must be read server-side')
    const adminBranch = api.slice(api.indexOf('caller.isAdmin'), api.indexOf('let query'))
    assert.ok(adminBranch.includes(embed), 'and only on the admin branch of the select')
  })

  test('an id filter cannot escape the ownership pin', () => {
    // `.eq('id', …)` is applied after the non-admin pin, so it can only narrow
    // rows the caller already owns.
    assert.ok(api.indexOf("query.eq('employee_id', caller.id)") < api.indexOf("query.eq('id', id)"),
      'the pin must be applied before any id filter')
  })

  test('the page resolves the objection id and nothing else from the URL', () => {
    assert.ok(page.includes(`searchParams.get(ISSUE_PARAM)`), 'only the objection id is read')
    assert.ok(page.includes('payrollObjectionHref'), 'the destination comes from the API answer')
    assert.equal(
      /searchParams\.get\('(period|employee)/.test(page), false,
      'no period or employee id may be taken from the query string',
    )
  })
})

describe('the raise notifies admins, and only admins', () => {
  const route = read('src/app/api/objections/route.ts')

  test('recipients are active admins', () => {
    assert.ok(route.includes(".eq('role', 'admin')"), 'must target admins')
    assert.ok(route.includes(".eq('is_active', true)"), 'must skip deactivated accounts')
  })

  test('the notification names who, what and which record', () => {
    assert.ok(route.includes('raised ${what} for ${subject}'.replace(/\$/g, '$')) ||
      /raised .*\$\{what\}.* for .*\$\{subject\}/.test(route),
      'the title must carry employee, issue type and subject')
  })

  test('both types are emitted, matching the enum the migration adds', () => {
    assert.ok(route.includes("'attendance_issue_raised'"))
    assert.ok(route.includes("'payroll_issue_raised'"))
    const migration = read('supabase/migrations/20260824000000_objection_notification_types.sql')
    assert.ok(migration.includes("ADD VALUE IF NOT EXISTS 'attendance_issue_raised'"))
    assert.ok(migration.includes("ADD VALUE IF NOT EXISTS 'payroll_issue_raised'"))
  })

  test('a notification failure cannot fail the objection', () => {
    // The employee's report is already saved by this point. A notify problem
    // must be logged, never surfaced to them as a failed submission.
    assert.ok(route.includes('console.error'), 'the failure must be logged')
    const fn = route.slice(route.indexOf('async function notifyAdminsOfObjection'))
    assert.ok(fn.includes('try {') && fn.includes('catch'), 'and swallowed, not thrown')
    assert.equal(
      /throw /.test(fn), false,
      'nothing in the notify path may throw past the caller',
    )
  })

  test('the migration is additive only', () => {
    const migration = read('supabase/migrations/20260824000000_objection_notification_types.sql')
    for (const forbidden of ['DROP ', 'DELETE ', 'TRUNCATE', 'UPDATE ', 'ALTER TABLE']) {
      assert.equal(
        migration.toUpperCase().includes(forbidden), false,
        `the migration must not contain ${forbidden}`,
      )
    }
  })
})

describe('the admin meets the issue where the record is', () => {
  test('the period results row carries its own indicator', () => {
    const src = read('src/app/payroll/results/[periodId]/page.tsx')
    assert.ok(src.includes('objections.byResult.get(r.id)'), 'the row must show its own issue state')
    assert.ok(src.includes('employeeStatusLabel'), 'and label it the way the employee sees it')
  })

  test('the payslip carries the reason and the two review actions', () => {
    const src = read('src/app/payroll/results/[periodId]/[employeeId]/page.tsx')
    assert.ok(src.includes('ObjectionReviewPanel'), 'the payslip must show the objection')

    const panel = read('src/components/objections/ObjectionReviewPanel.tsx')
    assert.ok(panel.includes('objection.reason'),           'the employee reason')
    assert.ok(panel.includes('objection.created_at'),       'when it was submitted')
    assert.ok(panel.includes('employeeStatusLabel'),        'its status')
    assert.ok(panel.includes('objection.review_note'),      'and any reply already given')
    assert.ok(panel.includes("review('approved')") && panel.includes("review('rejected')"))
  })

  test('the attendance side keeps the existing queue rather than a new module', () => {
    const src = read('src/app/attendance/correction-log/page.tsx')
    assert.ok(src.includes('ObjectionQueue'), 'attendance issues stay in the correction workflow')
  })

  test('reviewing goes through the controlled API, never a direct write', () => {
    const panel = read('src/components/objections/ObjectionReviewPanel.tsx')
    assert.ok(panel.includes("'/api/objections/review'"), 'must call the review route')
    assert.equal(
      /from\('employee_record_objections'\)/.test(panel), false,
      'the panel must not touch the table directly',
    )
    for (const table of ['payroll_results', 'attendance_records', 'payroll_deduction_lines']) {
      assert.equal(panel.includes(table), false, `reviewing must not reach ${table}`)
    }
  })

  test('the review route changes only the objection', () => {
    const src = read('src/app/api/objections/review/route.ts')
    assert.ok(src.includes('review_employee_record_objection'), 'must use the controlled RPC')
    for (const table of ['payroll_results', 'attendance_records', 'attendance_day_corrections',
                         'payroll_deduction_lines', 'payroll_pending_adjustments']) {
      assert.equal(src.includes(table), false, `the review route must not touch ${table}`)
    }
  })
})
