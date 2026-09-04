/**
 * The combined Attendance & Payroll module: one launcher card, one shell, one
 * navigation.
 *
 * What these pin, and why each mattered before it was merged:
 *
 *   1. ONE card. Two cards for what is one job ("did they turn up" → "what are
 *      they paid") sent people to the wrong half and then made them go back to
 *      /modules to reach the other.
 *   2. ONE nav definition, used by desktop and mobile alike. Two hand-copied
 *      arrays in two near-identical shells is how /attendance/monthly-review
 *      ended up navigable from neither sidebar.
 *   3. Every nav path is a route that EXISTS. Checked against the filesystem,
 *      because a nav is the one place a typo produces a 404 rather than a build
 *      error.
 *   4. The employee list contains no management route, and hiding a link is
 *      never what stops anybody — the guards are still there and still
 *      admin-only.
 *
 * Merging navigation is not merging the domains: attendance and payroll keep
 * their own tables, calculations, guards and URL trees, and this file asserts
 * the URL trees are untouched.
 *
 * Run:
 *   npx tsx --test src/components/layout/attendancePayrollNav.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ATTENDANCE_PAYROLL_ADMIN_NAV,
  ATTENDANCE_PAYROLL_EMPLOYEE_NAV,
  ATTENDANCE_PAYROLL_MODULE_NAME,
  attendancePayrollNavFor,
  isAttendancePayrollNavItemActive,
  type AttendancePayrollNavItem,
} from './attendancePayrollNav'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const LAUNCHER = read('src/app/modules/page.tsx')
const SHELL    = read('src/components/layout/AttendancePayrollLayout.tsx')

const byPath = (nav: AttendancePayrollNavItem[], path: string) => {
  const item = nav.find(i => i.path === path)
  assert.ok(item, `no nav item for ${path}`)
  return item
}

// ─── 1. The launcher shows one card ──────────────────────────────────────────

describe('the module launcher', () => {
  test('offers a single Attendance & Payroll card', () => {
    const matches = LAUNCHER.match(/title: 'Attendance & Payroll'/g) ?? []
    assert.equal(matches.length, 1, 'the combined card must be defined exactly once')
  })

  test('the separate Attendance and Payroll cards are gone', () => {
    assert.equal(LAUNCHER.includes("title: 'Attendance',"), false, 'a standalone Attendance card remains')
    assert.equal(LAUNCHER.includes("title: 'Payroll',"), false, 'a standalone Payroll card remains')
  })

  test('the card is admitted by EITHER module row, so nobody loses access', () => {
    // Union, not intersection: whoever could open an Attendance card or a
    // Payroll card before still gets in. Both rows survive in app_modules and
    // Control Center still configures them independently — no migration.
    assert.match(LAUNCHER, /canSeeModule\('attendance',/)
    assert.match(LAUNCHER, /canSeeModule\('payroll',\s+/)
    assert.match(LAUNCHER, /\(canSeeAttendance \|\| canSeePayroll\)/)
  })

  test('admins land on /payroll and employees on their own attendance', () => {
    assert.match(LAUNCHER, /const attendancePayrollHref = isModuleAdmin\s*\n\s*\? '\/payroll'/)
    assert.match(LAUNCHER, /canSeeAttendance \? '\/my-attendance' : '\/my-payroll'/)
  })

  test('the destination is decided by the same resolver the guards use', () => {
    // canSeeModule delegates to resolveModuleAccess; a launcher with its own
    // idea of visibility is a launcher that shows cards the route bounces.
    assert.match(LAUNCHER, /import \{ resolveModuleAccess \} from '@\/lib\/moduleAccess'/)
  })
})

// ─── 2. One navigation, one shell ────────────────────────────────────────────

describe('one navigation definition', () => {
  test('the shell renders the shared list and holds no array of its own', () => {
    assert.match(SHELL, /attendancePayrollNavFor/)
    assert.match(SHELL, /isAttendancePayrollNavItemActive/)
    assert.equal(SHELL.includes('const navItems = ['), false,
      'the shell has grown its own copy of the link list again')
  })

  test('desktop and mobile are the same element, so they cannot drift', () => {
    // The mobile menu is this <aside> with `.open` toggled — not a second menu.
    assert.equal((SHELL.match(/<aside className/g) ?? []).length, 1, 'a second sidebar appeared')
    assert.equal((SHELL.match(/navItems\.map/g) ?? []).length, 1, 'the list is rendered twice')
  })

  test('the shell renders one header and one notification bell', () => {
    assert.equal((SHELL.match(/boe-page-header/g) ?? []).length, 1)
    assert.equal((SHELL.match(/<IssueNotificationBell/g) ?? []).length, 1)
  })

  test('the module has one name, used by the shell', () => {
    assert.equal(ATTENDANCE_PAYROLL_MODULE_NAME, 'Attendance & Payroll')
    assert.match(SHELL, /\{ATTENDANCE_PAYROLL_MODULE_NAME\}/)
    // The old per-half branding is gone.
    assert.equal(SHELL.includes('Attendance & Salary'), false)
  })

  test('the role picks the list, and there are only two', () => {
    assert.equal(attendancePayrollNavFor(true), ATTENDANCE_PAYROLL_ADMIN_NAV)
    assert.equal(attendancePayrollNavFor(false), ATTENDANCE_PAYROLL_EMPLOYEE_NAV)
  })
})

// ─── 3. Every link goes somewhere that exists ────────────────────────────────

describe('every navigation path is a real route', () => {
  const pageFor = (path: string) => join(ROOT, 'src', 'app', ...path.split('/').filter(Boolean), 'page.tsx')

  for (const item of [...ATTENDANCE_PAYROLL_ADMIN_NAV, ...ATTENDANCE_PAYROLL_EMPLOYEE_NAV]) {
    test(`${item.label} → ${item.path}`, () => {
      assert.ok(existsSync(pageFor(item.path)), `${item.path} has no page.tsx — a nav link to nowhere`)
    })
  }

  test('no duplicate destinations within a list', () => {
    for (const [name, nav] of [
      ['admin', ATTENDANCE_PAYROLL_ADMIN_NAV],
      ['employee', ATTENDANCE_PAYROLL_EMPLOYEE_NAV],
    ] as const) {
      const paths = nav.map(i => i.path)
      assert.equal(new Set(paths).size, paths.length, `${name} nav repeats a destination`)
    }
  })

  test('the admin list still reaches both halves of the module', () => {
    // Attendance Upload and Attendance Records are deliberately no longer
    // their own top-level entries — reached from View Attendance's own
    // action button and from the Overview cards instead, per the two-
    // workspace redesign. Their routes are still real (checked below). Bare
    // `/payroll` (Payroll Runs) is deliberately absent too — see below.
    const paths = ATTENDANCE_PAYROLL_ADMIN_NAV.map(i => i.path)
    for (const required of [
      '/attendance', '/attendance/employees',
      '/attendance/monthly-review', '/attendance/holidays',
      '/payroll/monthly-review', '/payroll/issues', '/payroll/how-it-works', '/payroll/settings',
    ]) {
      assert.ok(paths.includes(required), `the admin nav dropped ${required}`)
    }
  })

  test('Attendance Upload and Attendance Records are still real routes, just not primary nav entries', () => {
    for (const p of ['src/app/attendance/upload/page.tsx', 'src/app/attendance/records/page.tsx']) {
      assert.ok(existsSync(join(ROOT, p)), `${p} was removed rather than just un-navved`)
    }
  })

  test('the primary workspaces are named for what an admin wants to do', () => {
    const viewAttendance = byPath(ATTENDANCE_PAYROLL_ADMIN_NAV, '/attendance/monthly-review')
    const viewPayroll    = byPath(ATTENDANCE_PAYROLL_ADMIN_NAV, '/payroll/monthly-review')
    const payrollIssues  = byPath(ATTENDANCE_PAYROLL_ADMIN_NAV, '/payroll/issues')
    assert.equal(viewAttendance.label, 'View Attendance')
    assert.equal(viewPayroll.label, 'View Payroll')
    assert.equal(payrollIssues.label, 'Payroll Issues')
    // None is grouped — they are three of the four primary entries, beside
    // Overview, not filed under Administration or Help.
    assert.equal(viewAttendance.group, undefined)
    assert.equal(viewPayroll.group, undefined)
    assert.equal(payrollIssues.group, undefined)
  })

  test('Payroll Runs is gone from navigation entirely, not merely regrouped', () => {
    // Its period-lifecycle actions (create, generate, lock, unlock, delete,
    // participation) now live inside View Payroll / the results page — see
    // src/app/payroll/monthly-review/page.tsx and
    // src/app/payroll/results/[periodId]/page.tsx. The bare /payroll route
    // itself still resolves (checked in "nothing structural moved" below),
    // it just has no nav entry of its own any more.
    const paths = ATTENDANCE_PAYROLL_ADMIN_NAV.map(i => i.path)
    assert.equal(paths.includes('/payroll'), false)
    assert.equal(ATTENDANCE_PAYROLL_ADMIN_NAV.some(i => i.label === 'Payroll Runs'), false)
  })

  test('the two monthly reviews are two links, because they are two screens', () => {
    // /attendance/monthly-review is the attendance summary; /payroll/monthly-review
    // is the engine's payroll preview. One label for both would be a link that
    // lies about where it goes.
    const attendance = byPath(ATTENDANCE_PAYROLL_ADMIN_NAV, '/attendance/monthly-review')
    const payroll    = byPath(ATTENDANCE_PAYROLL_ADMIN_NAV, '/payroll/monthly-review')
    assert.notEqual(attendance.label, payroll.label)
  })
})

// ─── 4. The employee list is self-service only ───────────────────────────────

describe('the employee navigation', () => {
  test('is exactly the five self-service destinations', () => {
    // /my-credits (BOE Credits Phase 1D) sits beside My Payroll: every read
    // behind it derives the employee from the bearer token.
    assert.deepEqual(
      ATTENDANCE_PAYROLL_EMPLOYEE_NAV.map(i => i.path),
      ['/my-attendance', '/my-payroll', '/my-credits', '/my-issues', '/payroll/how-it-works'],
    )
  })

  test('contains no management route except the data-free guide', () => {
    for (const item of ATTENDANCE_PAYROLL_EMPLOYEE_NAV) {
      if (item.path === '/payroll/how-it-works') continue
      assert.equal(item.path.startsWith('/attendance'), false, item.path)
      assert.equal(item.path.startsWith('/payroll'), false, item.path)
    }
  })

  test('and hiding the admin links is NOT what stops an employee', () => {
    // The nav is a convenience. These two guards are the control, and both
    // resolve management access as admin-only whatever visibility says.
    const attendanceGuard = read('src/app/attendance/layout.tsx')
    const payrollGuard    = read('src/app/payroll/layout.tsx')
    for (const [name, guard] of [['attendance', attendanceGuard], ['payroll', payrollGuard]] as const) {
      assert.match(guard, /resolveManagementAccess/, `${name} guard no longer resolves management access`)
      assert.match(guard, /router\.replace/, `${name} guard no longer redirects`)
    }
  })
})

// ─── 5. Active state ─────────────────────────────────────────────────────────

describe('active state', () => {
  const activeLabels = (pathname: string, nav: AttendancePayrollNavItem[]) =>
    nav.filter(i => isAttendancePayrollNavItemActive(pathname, i)).map(i => i.label)

  test('a module root does not claim the pages beneath it', () => {
    assert.deepEqual(activeLabels('/attendance', ATTENDANCE_PAYROLL_ADMIN_NAV), ['Overview'])
    // No longer a nav entry of its own — reached from Overview, which stays
    // lit while browsing it, exactly like the correction log already did.
    assert.deepEqual(activeLabels('/attendance/records', ATTENDANCE_PAYROLL_ADMIN_NAV), ['Overview'])
    assert.deepEqual(activeLabels('/payroll/settings', ATTENDANCE_PAYROLL_ADMIN_NAV), ['Payroll Settings'])
    assert.deepEqual(activeLabels('/payroll/issues', ATTENDANCE_PAYROLL_ADMIN_NAV), ['Payroll Issues'])
  })

  test('bare /payroll lights nothing — it has no nav entry of its own any more', () => {
    // Deliberate: it is still a real, reachable page (period administration),
    // just no longer represented in primary navigation. It was NOT added to
    // View Payroll's alsoActiveFor either — isUnder('/payroll/settings',
    // '/payroll') would be true, which would wrongly light View Payroll for
    // every /payroll/* route including Payroll Settings and BOE Credits.
    assert.deepEqual(activeLabels('/payroll', ATTENDANCE_PAYROLL_ADMIN_NAV), [])
  })

  test('exactly one item is ever active on an admin route', () => {
    for (const pathname of [
      '/attendance', '/attendance/employees', '/attendance/employees/abc',
      '/attendance/upload', '/attendance/records', '/attendance/monthly-review',
      '/attendance/monthly-review/user-1', '/attendance/holidays', '/attendance/correction-log',
      '/payroll/monthly-review', '/payroll/monthly-review/user-1',
      '/payroll/issues', '/payroll/how-it-works', '/payroll/settings',
      '/payroll/results/p1', '/payroll/results/p1/e1', '/payroll/results/p1/salary-report',
    ]) {
      assert.equal(activeLabels(pathname, ATTENDANCE_PAYROLL_ADMIN_NAV).length, 1,
        `${pathname} lights ${activeLabels(pathname, ATTENDANCE_PAYROLL_ADMIN_NAV).length} items`)
    }
  })

  test('a payroll run and its payslips keep View Payroll lit, not Payroll Runs', () => {
    // A generated month redirects from View Payroll to /payroll/results/{id} —
    // to the admin this is still "viewing payroll", not a trip to period
    // administration, so the nav must agree with where they actually are.
    for (const p of ['/payroll/results/p1', '/payroll/results/p1/e1', '/payroll/results/p1/salary-report']) {
      assert.deepEqual(activeLabels(p, ATTENDANCE_PAYROLL_ADMIN_NAV), ['View Payroll'], p)
    }
  })

  test('the attendance upload page keeps View Attendance lit', () => {
    assert.deepEqual(activeLabels('/attendance/upload', ATTENDANCE_PAYROLL_ADMIN_NAV), ['View Attendance'])
  })

  test('the correction log keeps Overview lit, since that is where it is reached from', () => {
    assert.deepEqual(activeLabels('/attendance/correction-log', ATTENDANCE_PAYROLL_ADMIN_NAV), ['Overview'])
  })

  test('employee routes light exactly one item each', () => {
    assert.deepEqual(activeLabels('/my-attendance', ATTENDANCE_PAYROLL_EMPLOYEE_NAV), ['My Attendance'])
    assert.deepEqual(activeLabels('/my-payroll', ATTENDANCE_PAYROLL_EMPLOYEE_NAV), ['My Payroll'])
    assert.deepEqual(activeLabels('/my-payroll/period-1', ATTENDANCE_PAYROLL_EMPLOYEE_NAV), ['My Payroll'])
    assert.deepEqual(activeLabels('/my-issues', ATTENDANCE_PAYROLL_EMPLOYEE_NAV), ['My Issues'])
    assert.deepEqual(activeLabels('/payroll/how-it-works', ATTENDANCE_PAYROLL_EMPLOYEE_NAV), ['How Payroll Works'])
  })

  test('the notification feed belongs to the bell, not to My Issues', () => {
    // Both would light otherwise — /my-issues/notifications is under /my-issues.
    assert.deepEqual(activeLabels('/my-issues/notifications', ATTENDANCE_PAYROLL_EMPLOYEE_NAV), [])
  })

  test('prefix matching is segment-aware, not string-prefix', () => {
    // The old shells used startsWith(path), which lit "Attendance Records" for
    // any route merely beginning with those characters.
    assert.deepEqual(activeLabels('/attendance/records-archive', ATTENDANCE_PAYROLL_ADMIN_NAV), [])
    assert.deepEqual(activeLabels('/my-attendance-summary', ATTENDANCE_PAYROLL_EMPLOYEE_NAV), [])
  })

  test('an unrelated route lights nothing', () => {
    for (const p of ['/modules', '/dashboard', '/finance']) {
      assert.deepEqual(activeLabels(p, ATTENDANCE_PAYROLL_ADMIN_NAV), [], p)
      assert.deepEqual(activeLabels(p, ATTENDANCE_PAYROLL_EMPLOYEE_NAV), [], p)
    }
  })
})

// ─── 6. Groups render once each, in order ────────────────────────────────────

describe('the nav groups into Administration and Help', () => {
  test('a group is contiguous — the header would never repeat', () => {
    // The shell renders a header only when an item's group differs from the
    // one before it. If Administration items were split by a Help item (or
    // vice versa), the header would silently print twice.
    const groups = ATTENDANCE_PAYROLL_ADMIN_NAV.map(i => i.group ?? null)
    const seen = new Set<string | null>()
    let previous: string | null = null
    for (const g of groups) {
      if (g !== previous) {
        assert.equal(seen.has(g), false, `group ${g} is not contiguous`)
        seen.add(g)
      }
      previous = g
    }
  })

  test('Overview, View Attendance, View Payroll and Payroll Issues are the only ungrouped entries', () => {
    const ungrouped = ATTENDANCE_PAYROLL_ADMIN_NAV.filter(i => !i.group).map(i => i.label)
    assert.deepEqual(ungrouped, ['Overview', 'View Attendance', 'View Payroll', 'Payroll Issues'])
  })

  test('the shell renders a header for every group the nav defines', () => {
    assert.match(SHELL, /ATTENDANCE_PAYROLL_NAV_GROUP_LABEL/)
  })
})

// ─── 6b. Upload is reachable FROM the workspace, not beside it ────────────────

describe('Attendance Upload is reached from View Attendance, not from its own nav entry', () => {
  test('View Attendance renders an Upload Attendance action to /attendance/upload', () => {
    const page = read('src/app/attendance/monthly-review/page.tsx')
    assert.match(page, /href="\/attendance\/upload"/)
    assert.match(page, />\s*Upload Attendance\s*</)
  })

  test('View Payroll renders a lateral link to period administration', () => {
    const page = read('src/app/payroll/monthly-review/page.tsx')
    assert.match(page, /href="\/payroll"/)
    assert.match(page, />\s*Manage Payroll Runs\s*</)
  })
})

// ─── 7. Nothing structural moved ─────────────────────────────────────────────

describe('the merge is user-interface only', () => {
  test('both URL trees still exist, unmoved', () => {
    for (const p of [
      'src/app/attendance/page.tsx', 'src/app/attendance/layout.tsx',
      'src/app/payroll/page.tsx', 'src/app/payroll/layout.tsx',
      'src/app/my-attendance/page.tsx', 'src/app/my-payroll/page.tsx',
      'src/app/my-issues/page.tsx',
      // Kept for existing links even though the sidebar now offers one door.
      'src/app/attendance/notifications/page.tsx', 'src/app/payroll/notifications/page.tsx',
      // Reached from a payroll run, where the period is known.
      'src/app/payroll/results/[periodId]/salary-report/page.tsx',
    ]) {
      assert.ok(existsSync(join(ROOT, p)), `${p} was moved or removed`)
    }
  })

  test('the shell queries no table and calls no API of its own', () => {
    for (const forbidden of ['createClient', 'supabase', 'fetch(', 'payroll_results', 'attendance_records']) {
      assert.equal(SHELL.includes(forbidden), false, `the shell reaches for ${forbidden}`)
    }
  })

  test('the nav definition is data, not a second access rule', () => {
    const nav = read('src/components/layout/attendancePayrollNav.tsx')
    for (const forbidden of ['role ===', 'resolveModuleAccess', 'resolveManagementAccess', 'createClient']) {
      assert.equal(nav.includes(forbidden), false, `the nav decides access via ${forbidden}`)
    }
  })
})
