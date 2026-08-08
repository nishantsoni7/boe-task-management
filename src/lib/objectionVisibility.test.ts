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

  test('a payroll issue opens the payroll review side', () => {
    const meta = getNotificationMeta(notif('payroll_issue_raised'))
    assert.equal(meta.href, '/payroll')
    assert.equal(meta.heading, 'Payroll')
  })

  test('neither falls through to a link-less generic notification', () => {
    for (const t of ['attendance_issue_raised', 'payroll_issue_raised']) {
      const meta = getNotificationMeta(notif(t))
      assert.ok(meta.href && meta.href !== '#', `${t} must resolve to a real destination`)
    }
  })

  test('the routing does not depend on entity_id being present', () => {
    // The objection id is carried for reference, but the destination is a
    // screen rather than a record, so a missing id must not break the link.
    const meta = getNotificationMeta(notif('payroll_issue_raised', null))
    assert.equal(meta.href, '/payroll')
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
