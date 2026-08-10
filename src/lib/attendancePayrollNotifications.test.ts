/**
 * The Attendance & Payroll issue feed — one shared category, both directions.
 *
 * The defect these cover: `attendance_issue_raised` and `payroll_issue_raised`
 * were being written to `notifications` correctly and were resolving to correct
 * deep links, but belonged to NONE of the four feed filters. The rows existed
 * and no screen in the application could show them. A notification nobody can
 * see is not a notification.
 *
 * So the assertions here are about MEMBERSHIP as much as behaviour: the new
 * category selects exactly the two types, the four existing feeds are byte-for-
 * byte what they were, and every endpoint keeps resolving its scope through the
 * one shared resolver so list / count / mark-read / delete-all cannot drift.
 *
 * Run:
 *   npx tsx --test src/lib/attendancePayrollNotifications.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ATTENDANCE_PAYROLL_NOTIFICATION_TYPES,
  ASSET_NOTIFICATION_TYPES,
  FINANCE_NOTIFICATION_TYPES,
  ORDER_NOTIFICATION_TYPES,
  ADMIN_ONLY_CATEGORIES,
  isAdminOnlyNotificationCategory,
  getNotificationCategoryFilter,
  resolveNotificationCategory,
  type NotificationCategory,
} from './notifications'
import { NOTIFICATION_CATEGORIES, notificationKeys } from './notificationCache'
import { canReadNotificationCategory } from './notificationAccess'
import { getNotificationMeta } from './notificationMeta'
import { ISSUE_PARAM } from './objections'
import {
  ATTENDANCE_PAYROLL_ADMIN_NAV,
  ATTENDANCE_PAYROLL_EMPLOYEE_NAV,
} from '@/components/layout/attendancePayrollNav'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/** The enum values a `type.in.(a,b)` filter fragment selects. */
function typesIn(filter: string): string[] {
  const m = /^type\.in\.\(([^)]*)\)$/.exec(filter)
  assert.ok(m, `not an enum IN filter: ${filter}`)
  return m![1].split(',').filter(Boolean)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const notif = (type: string, entityId: string | null = 'obj-1'): any => ({
  id: 'n1', type, title: 'x', body: null, is_read: false,
  created_at: new Date().toISOString(), entity_id: entityId, task_id: null,
})

// ─── 1 & 2. The new category exists and holds exactly the two types ──────────

describe('attendance_payroll is a real category with exactly four members', () => {
  test('1. it resolves as a valid category', () => {
    const r = resolveNotificationCategory('attendance_payroll')
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.category, 'attendance_payroll')
  })

  test('1b. it is part of the cache category list, so snapshots cover it', () => {
    assert.ok(NOTIFICATION_CATEGORIES.includes('attendance_payroll'),
      'a category missing here is a category whose cache is never snapshotted or restored')
  })

  test('1c. it gets its own list and count keys, distinct from every other', () => {
    const keys = NOTIFICATION_CATEGORIES.flatMap(c =>
      [JSON.stringify(notificationKeys.list(c)), JSON.stringify(notificationKeys.count(c))])
    assert.equal(new Set(keys).size, keys.length, 'two categories sharing a key would share a badge')
    assert.deepEqual(notificationKeys.count('attendance_payroll'),
      ['notifications', 'count', 'attendance_payroll'])
  })

  test('2. the filter selects exactly the four issue types — no more, no fewer', () => {
    const selected = typesIn(getNotificationCategoryFilter('attendance_payroll'))
    assert.deepEqual(selected.sort(), [...ATTENDANCE_PAYROLL_NOTIFICATION_TYPES].sort())
    assert.equal(selected.length, 4)
  })

  test('2a. the feed carries both halves of the conversation', () => {
    // A category that selects the raise but not the decision is the same defect
    // this feed was created to fix, one step further along: the row exists and
    // no screen can show it.
    for (const t of [
      'attendance_issue_raised', 'payroll_issue_raised',
      'attendance_issue_reviewed', 'payroll_issue_reviewed',
    ]) {
      assert.ok((ATTENDANCE_PAYROLL_NOTIFICATION_TYPES as readonly string[]).includes(t), t)
    }
  })

  test('2b. it is an enum IN filter, never a prefix LIKE', () => {
    // `type` is a Postgres enum; LIKE errors server-side and a HEAD/count
    // request swallows that error and silently reports zero.
    const filter = getNotificationCategoryFilter('attendance_payroll')
    assert.ok(filter.startsWith('type.in.('))
    assert.equal(/like/i.test(filter), false)
  })

  test('2c. every type is one an objection route actually writes', () => {
    // If these drift, a notification is written with a type the feed does not
    // select — which is exactly the defect this feed exists to fix.
    const raise  = read('src/app/api/objections/route.ts')
    const review = read('src/app/api/objections/review/route.ts')
    const emitted = `${raise}\n${review}`
    for (const t of ATTENDANCE_PAYROLL_NOTIFICATION_TYPES) {
      assert.ok(emitted.includes(`'${t}'`), `${t} must be a type some objection path emits`)
    }
    // …and each half is emitted by the right route.
    for (const t of ['attendance_issue_raised', 'payroll_issue_raised']) {
      assert.ok(raise.includes(`'${t}'`), `${t} belongs to the raise path`)
    }
    for (const t of ['attendance_issue_reviewed', 'payroll_issue_reviewed']) {
      assert.ok(review.includes(`'${t}'`), `${t} belongs to the review path`)
    }
  })

  test('2d. and the ones the migrations added to the enum', () => {
    const migrations = [
      read('supabase/migrations/20260824000000_objection_notification_types.sql'),
      read('supabase/migrations/20260825000000_objection_review_notification_types.sql'),
    ].join('\n')
    for (const t of ATTENDANCE_PAYROLL_NOTIFICATION_TYPES) {
      assert.ok(migrations.includes(`ADD VALUE IF NOT EXISTS '${t}'`), t)
    }
  })

  test('2e. the review migration is additive only', () => {
    const migration = read('supabase/migrations/20260825000000_objection_review_notification_types.sql')
    for (const forbidden of ['DROP ', 'DELETE ', 'TRUNCATE', 'UPDATE ', 'ALTER TABLE']) {
      assert.equal(migration.toUpperCase().includes(forbidden), false,
        `the migration must not contain ${forbidden}`)
    }
  })
})

// ─── 3–6. The four existing feeds are untouched ──────────────────────────────

describe('no existing feed was widened', () => {
  test('3. Task stays a narrow title whitelist and gains nothing', () => {
    const filter = getNotificationCategoryFilter('task')
    // Still title-based, still 13 fragments — NOT `task_id IS NOT NULL`, which
    // would resurface ~16k historical overdue/escalation cron rows.
    assert.equal(filter.split(',').length, 13)
    assert.ok(filter.startsWith('title.ilike.'))
    assert.equal(/type\.in\./.test(filter), false)
    assert.equal(/task_id/.test(filter), false)
    for (const t of ATTENDANCE_PAYROLL_NOTIFICATION_TYPES) assert.equal(filter.includes(t), false, t)
  })

  test('3b. no legacy digest or escalation row is selected by any feed', () => {
    for (const c of NOTIFICATION_CATEGORIES) {
      const filter = getNotificationCategoryFilter(c)
      for (const legacy of ['morning_digest', 'overdue', 'escalation']) {
        assert.equal(filter.includes(legacy), false, `${c} must not surface ${legacy}`)
      }
    }
  })

  test('4. Finance selects exactly its own eight types', () => {
    assert.deepEqual(typesIn(getNotificationCategoryFilter('finance')).sort(),
      [...FINANCE_NOTIFICATION_TYPES].sort())
  })

  test('5. Orders selects exactly its own six types', () => {
    assert.deepEqual(typesIn(getNotificationCategoryFilter('order')).sort(),
      [...ORDER_NOTIFICATION_TYPES].sort())
  })

  test('6. Assets & Access selects exactly its own types', () => {
    assert.deepEqual(typesIn(getNotificationCategoryFilter('asset')).sort(),
      [...ASSET_NOTIFICATION_TYPES].sort())
  })

  test('the five feeds are disjoint — one row can never appear in two', () => {
    const seen = new Map<string, NotificationCategory>()
    for (const c of NOTIFICATION_CATEGORIES) {
      if (c === 'task') continue // title-based, no enum types to compare
      for (const t of typesIn(getNotificationCategoryFilter(c))) {
        assert.equal(seen.has(t), false, `${t} is claimed by both ${seen.get(t)} and ${c}`)
        seen.set(t, c)
      }
    }
  })
})

// ─── 7–10. Every endpoint scopes through the same resolver ───────────────────

describe('list, count, mark-all-read and delete-all share one scope', () => {
  const listRoute = read('src/app/api/notifications/route.ts')
  const markRoute = read('src/app/api/notifications/mark-read/route.ts')

  test('7 & 8. the list path and the count path apply the same filter variable', () => {
    // One `activityFilter`, used by both branches of GET — so the badge can
    // never count rows the list does not show.
    assert.ok(listRoute.includes('const activityFilter = getNotificationCategoryFilter(categoryResult.category)'))
    assert.equal((listRoute.match(/\.or\(activityFilter\)/g) ?? []).length, 3,
      'count, list and delete-all must each scope by the resolved filter')
  })

  test('9. mark-all-read resolves its scope the same way', () => {
    assert.ok(markRoute.includes('resolveNotificationCategory(category)'))
    assert.ok(markRoute.includes('.or(getNotificationCategoryFilter(categoryResult.category))'))
  })

  test('10. delete-all is category-scoped, and delete-selected stays id-scoped', () => {
    assert.ok(listRoute.includes('export async function DELETE'))
    // delete-selected takes explicit ids the caller already owns, so it needs no
    // category at all — and must not grow one.
    const selected = read('src/app/api/notifications/delete-selected/route.ts')
    assert.equal(/getNotificationCategoryFilter/.test(selected), false)
    assert.ok(selected.includes(".eq('user_id', user.id)"), 'still pinned to the caller')
  })

  test('every category-scoped endpoint still pins rows to the caller', () => {
    for (const [name, src] of [['list/delete-all', listRoute], ['mark-read', markRoute]] as const) {
      assert.ok(src.includes(".eq('user_id', user.id)"), `${name} must scope to the caller`)
    }
  })
})

// ─── 11. Admin only, server-side ─────────────────────────────────────────────

/** A `users` lookup that answers with one role, or an error. */
function stubClient(answer: { data?: { role: string } | null; error?: { message: string } }) {
  let asked = ''
  const client = {
    from: (table: string) => {
      asked = table
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => answer }) }),
      }
    },
    get askedTable() { return asked },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return client as any
}

// The category was admin-only while every row of it was addressed to an admin.
// Now that a decision notifies the employee who raised the issue, an employee
// has rows of their own here, and a category gate would refuse a person their
// own notification. What keeps one employee's rows away from another's is —
// and always was — the `user_id = caller` pin on every endpoint.

describe('11. the feed is row-scoped, not category-gated', () => {
  test('no category is admin-only any more, and the predicate agrees', () => {
    assert.deepEqual([...ADMIN_ONLY_CATEGORIES], [])
    for (const c of ['task', 'finance', 'order', 'asset', 'attendance_payroll'] as const) {
      assert.equal(isAdminOnlyNotificationCategory(c), false, c)
    }
  })

  test('an employee may now read their own attendance/payroll notifications', async () => {
    // The whole point of the change: the one person waiting for an answer was
    // the one person the feed refused.
    for (const role of ['member', 'manager', 'admin']) {
      assert.equal(
        await canReadNotificationCategory(stubClient({ data: { role } }), 'u1', 'attendance_payroll'),
        true, role,
      )
    }
  })

  test('and it costs no users read, like every other open category', async () => {
    for (const c of ['task', 'finance', 'order', 'asset', 'attendance_payroll'] as const) {
      const client = stubClient({ data: { role: 'member' } })
      assert.equal(await canReadNotificationCategory(client, 'u1', c), true, c)
      assert.equal(client.askedTable, '', `${c} must not cost a users read`)
    }
  })

  test('the gate still FAILS CLOSED for anything added to the list later', async () => {
    // The machinery is kept, not deleted — so it has to still work. Asserted
    // against the predicate directly, since no category uses it today.
    const gated = async (answer: Parameters<typeof stubClient>[0]) =>
      isAdminOnlyNotificationCategory('attendance_payroll')
        ? canReadNotificationCategory(stubClient(answer), 'u1', 'attendance_payroll')
        : null
    assert.equal(await gated({ data: null }), null, 'not gated today, by design')

    const access = read('src/lib/notificationAccess.ts')
    assert.ok(access.includes('if (error)'), 'a broken lookup must not read as an admin')
    assert.ok(access.includes("data?.role === 'admin'"), 'and a missing profile must not either')
  })

  test('all three category-scoped endpoints still apply the gate', () => {
    const list = read('src/app/api/notifications/route.ts')
    const mark = read('src/app/api/notifications/mark-read/route.ts')
    // GET (list + count) and DELETE (delete-all) are both in the list route.
    assert.equal((list.match(/canReadNotificationCategory/g) ?? []).length, 3,
      'import + one gate on GET + one gate on DELETE')
    assert.equal((mark.match(/canReadNotificationCategory/g) ?? []).length, 2,
      'import + one gate on mark-all-read')
    for (const src of [list, mark]) assert.ok(src.includes('403'), 'refusal must be a 403')
  })

  test('the role is read with an explicit column, never select(*)', () => {
    // `users` has column-level grants (20260813000000); a star select is 42501.
    // Comments are stripped first: this file's own prose says "never select('*')".
    const code = read('src/lib/notificationAccess.ts')
      .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    assert.ok(code.includes(".select('role')"))
    assert.equal(/\.select\('\*'\)/.test(code), false)
  })

  test('the shared shell sends each role to a door it can actually open', () => {
    // AttendancePayrollLayout is the ONE shell for /attendance, /payroll,
    // /my-attendance, /my-payroll and /my-issues. /attendance/notifications is
    // behind AttendanceGuard, so an employee pointed there would just be bounced.
    const layout = read('src/components/layout/AttendancePayrollLayout.tsx')
    assert.ok(layout.includes("isAdmin ? '/attendance/notifications' : '/my-issues/notifications'"),
      'the destination must branch on role')
    assert.ok(layout.includes('useUnreadAttendancePayrollNotifications()'),
      'and the count is now requested for everyone, because everyone can have rows')
    assert.ok(layout.includes('<IssueNotificationBell'), 'the module sidebar must offer the feed')
  })

  test('the employee door renders the same shared feed, not a second one', () => {
    const page = read('src/app/my-issues/notifications/page.tsx')
    assert.ok(page.includes('category="attendance_payroll"'), 'same category as both admin doors')
    assert.ok(page.includes('NotificationsView'), 'same shared list')
    for (const forbidden of ['useQuery', 'fetch(', 'createClient', 'useState']) {
      assert.equal(page.includes(forbidden), false, `a second notification implementation: ${forbidden}`)
    }
  })
})

// ─── 12–15. Presentation and destinations are unchanged ──────────────────────

describe('the approved presentation and deep links still hold', () => {
  test('12. attendance_issue_raised renders the Issue raised badge', () => {
    const meta = getNotificationMeta(notif('attendance_issue_raised'))
    assert.equal(meta.badge.label, 'Issue raised')
    assert.equal(meta.heading, 'Attendance')
  })

  test('13. payroll_issue_raised renders the Issue raised badge', () => {
    const meta = getNotificationMeta(notif('payroll_issue_raised'))
    assert.equal(meta.badge.label, 'Issue raised')
    assert.equal(meta.heading, 'Payroll')
  })

  test('12b & 13b. neither falls back to the neutral Activity chip', () => {
    for (const t of ATTENDANCE_PAYROLL_NOTIFICATION_TYPES) {
      assert.notEqual(getNotificationMeta(notif(t)).badge.label, 'Activity', t)
    }
  })

  test('14. the attendance deep link is the correction log', () => {
    assert.equal(getNotificationMeta(notif('attendance_issue_raised')).href, '/attendance/correction-log')
  })

  test('15. the payroll deep link still carries the objection to the resolver', () => {
    assert.equal(getNotificationMeta(notif('payroll_issue_raised', 'obj-9')).href,
      `/payroll?${ISSUE_PARAM}=obj-9`)
  })

  test('15b. the resolver page is untouched — it still trades the id for a payslip', () => {
    const page = read('src/app/payroll/page.tsx')
    assert.ok(page.includes('searchParams.get(ISSUE_PARAM)'))
    assert.ok(page.includes('payrollObjectionHref'))
  })
})

// ─── One feed, two doors ─────────────────────────────────────────────────────

describe('Attendance and Payroll open the same feed, not two of them', () => {
  const attendancePage = read('src/app/attendance/notifications/page.tsx')
  const payrollPage    = read('src/app/payroll/notifications/page.tsx')

  test('both pages render the shared view against the same category', () => {
    for (const [name, src] of [['attendance', attendancePage], ['payroll', payrollPage]] as const) {
      assert.ok(src.includes('category="attendance_payroll"'), `${name} must use the shared category`)
      assert.ok(src.includes('NotificationsView'), `${name} must reuse the shared list`)
    }
  })

  test('neither page reimplements list, mutation or delete behaviour', () => {
    for (const src of [attendancePage, payrollPage]) {
      for (const forbidden of ['useQuery', 'fetch(', 'createClient', 'useState']) {
        assert.equal(src.includes(forbidden), false, `a second notification implementation: ${forbidden}`)
      }
    }
  })

  test('one sidebar reads one count hook, so no two badges can disagree', () => {
    // Two shells used to hold two copies of this wiring, which is exactly how
    // they drifted. There is one shell now, so there is nothing to keep in step.
    const shell = 'src/components/layout/AttendancePayrollLayout.tsx'
    const src = read(shell)
    assert.ok(src.includes('useUnreadAttendancePayrollNotifications'), shell)
    assert.ok(src.includes('<IssueNotificationBell'), `${shell} must use the shared bell`)
    // Same category ⇒ same query key ⇒ one fetch, wherever in the module you are.
    assert.deepEqual(
      notificationKeys.count('attendance_payroll'),
      notificationKeys.count('attendance_payroll'),
    )
  })

  test('the two old shells are gone, not merely unused', () => {
    for (const p of ['src/components/layout/AttendanceLayout.tsx', 'src/components/layout/PayrollLayout.tsx']) {
      assert.equal(existsSync(join(ROOT, p)), false, `${p} still exists — the duplicate can come back`)
    }
  })

  test('both URLs render the one merged shell', () => {
    for (const [name, src] of [['attendance', attendancePage], ['payroll', payrollPage]] as const) {
      assert.ok(src.includes('AttendancePayrollLayout'), `${name} must use the merged shell`)
    }
  })

  test('the sidebar offers exactly one door onto the feed', () => {
    // /payroll/notifications stays reachable for old links, but it is no longer
    // a second entry point in the navigation — see attendancePayrollNav.tsx.
    const navPaths = [...ATTENDANCE_PAYROLL_ADMIN_NAV, ...ATTENDANCE_PAYROLL_EMPLOYEE_NAV]
      .map(i => i.path)
    for (const feed of ['/attendance/notifications', '/payroll/notifications', '/my-issues/notifications']) {
      assert.equal(navPaths.includes(feed), false,
        `${feed} is a nav item as well as the bell — that is the duplicate door`)
    }
  })
})
