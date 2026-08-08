/**
 * The Attendance & Payroll issue feed — one shared category, admin only.
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
import { readFileSync } from 'node:fs'
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

describe('attendance_payroll is a real category with exactly two members', () => {
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

  test('2. the filter selects exactly the two issue types — no more, no fewer', () => {
    const selected = typesIn(getNotificationCategoryFilter('attendance_payroll'))
    assert.deepEqual(selected.sort(), [...ATTENDANCE_PAYROLL_NOTIFICATION_TYPES].sort())
    assert.equal(selected.length, 2)
  })

  test('2b. it is an enum IN filter, never a prefix LIKE', () => {
    // `type` is a Postgres enum; LIKE errors server-side and a HEAD/count
    // request swallows that error and silently reports zero.
    const filter = getNotificationCategoryFilter('attendance_payroll')
    assert.ok(filter.startsWith('type.in.('))
    assert.equal(/like/i.test(filter), false)
  })

  test('2c. the two types are the ones the objection route actually writes', () => {
    // If these drift, a notification is written with a type the feed does not
    // select — which is exactly the defect this feed exists to fix.
    const route = read('src/app/api/objections/route.ts')
    for (const t of ATTENDANCE_PAYROLL_NOTIFICATION_TYPES) {
      assert.ok(route.includes(`'${t}'`), `${t} must be a type the raise path emits`)
    }
  })

  test('2d. and the ones the migration added to the enum', () => {
    const migration = read('supabase/migrations/20260824000000_objection_notification_types.sql')
    for (const t of ATTENDANCE_PAYROLL_NOTIFICATION_TYPES) {
      assert.ok(migration.includes(`ADD VALUE IF NOT EXISTS '${t}'`), t)
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

describe('11. only an admin may consume the company-wide issue feed', () => {
  test('the category is marked admin-only, and no other category is', () => {
    assert.deepEqual([...ADMIN_ONLY_CATEGORIES], ['attendance_payroll'])
    assert.equal(isAdminOnlyNotificationCategory('attendance_payroll'), true)
    for (const c of ['task', 'finance', 'order', 'asset'] as const) {
      assert.equal(isAdminOnlyNotificationCategory(c), false, c)
    }
  })

  test('an admin is allowed', async () => {
    assert.equal(
      await canReadNotificationCategory(stubClient({ data: { role: 'admin' } }), 'u1', 'attendance_payroll'),
      true,
    )
  })

  test('an employee and a manager are refused', async () => {
    for (const role of ['member', 'manager']) {
      assert.equal(
        await canReadNotificationCategory(stubClient({ data: { role } }), 'u1', 'attendance_payroll'),
        false, role,
      )
    }
  })

  test('it fails CLOSED — a missing profile or a broken lookup is not an admin', async () => {
    assert.equal(
      await canReadNotificationCategory(stubClient({ data: null }), 'u1', 'attendance_payroll'), false)
    assert.equal(
      await canReadNotificationCategory(stubClient({ error: { message: 'boom' } }), 'u1', 'attendance_payroll'), false)
  })

  test('the four open categories are answered without a role lookup at all', async () => {
    for (const c of ['task', 'finance', 'order', 'asset'] as const) {
      const client = stubClient({ data: { role: 'member' } })
      assert.equal(await canReadNotificationCategory(client, 'u1', c), true, c)
      assert.equal(client.askedTable, '', `${c} must not cost a users read`)
    }
  })

  test('all three category-scoped endpoints apply the gate', () => {
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

  test('the shared employee shell only offers the feed to an admin', () => {
    // AttendanceLayout is also the shell for /my-attendance and /my-payroll, so
    // an unguarded entry there would put an admin feed in front of an employee.
    const layout = read('src/components/layout/AttendanceLayout.tsx')
    const at = layout.indexOf('<NotificationsNavItem')
    assert.notEqual(at, -1, 'the Attendance sidebar must offer the feed')
    assert.ok(/\{isAdmin && \($/m.test(layout.slice(Math.max(0, at - 400), at)),
      'the entry must sit inside an isAdmin branch')
    assert.ok(layout.includes('useUnreadAttendancePayrollNotifications(isAdmin)'),
      'and the count must not even be requested for an employee')
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

  test('both sidebars read one count hook, so the two badges cannot disagree', () => {
    for (const p of ['src/components/layout/AttendanceLayout.tsx', 'src/components/layout/PayrollLayout.tsx']) {
      assert.ok(read(p).includes('useUnreadAttendancePayrollNotifications'), p)
    }
    // Same category ⇒ same query key ⇒ one fetch shared by both shells.
    assert.deepEqual(
      notificationKeys.count('attendance_payroll'),
      notificationKeys.count('attendance_payroll'),
    )
  })

  test('each door stays inside its own module shell', () => {
    assert.ok(attendancePage.includes('AttendanceLayout'))
    assert.ok(payrollPage.includes('PayrollLayout'))
  })
})
