/**
 * The combined Attendance & Payroll module: one launcher card, one shell, one
 * navigation of six sections.
 *
 * What these pin, and why each mattered:
 *
 *   1. ONE card. Two cards for what is one job ("did they turn up" → "what are
 *      they paid") sent people to the wrong half.
 *   2. ONE nav definition, used by desktop and mobile alike.
 *   3. SIX admin sections — the sidebar had grown to 14 entries and nobody could
 *      tell where related work lived. Pages that belong together are tabs.
 *   4. EVERY old destination is still reachable (the old→new map below is an
 *      executable assertion, not just documentation).
 *   5. Every nav path is a route that EXISTS. Checked against the filesystem,
 *      because a nav is the one place a typo produces a 404 rather than a build
 *      error.
 *   6. The employee list contains no management route, and hiding a link is
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
  ATTENDANCE_PAYROLL_ADMIN_SECTIONS,
  ATTENDANCE_PAYROLL_EMPLOYEE_NAV,
  ATTENDANCE_PAYROLL_MODULE_NAME,
  ADMIN_NOTIFICATIONS_PATH,
  EMPLOYEE_NOTIFICATIONS_PATH,
  activeTabFor,
  adminSectionFor,
  attendancePayrollNavFor,
  isAttendancePayrollNavItemActive,
  notificationsPathFor,
  type AttendancePayrollNavItem,
} from './attendancePayrollNav'

const ROOT = process.cwd()
// \r is stripped on read: a checkout under core.autocrlf can hand these files
// back with CRLF endings, and multi-line assertions would then miss.
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r/g, '')

const LAUNCHER = read('src/app/modules/page.tsx')
const SHELL    = read('src/components/layout/AttendancePayrollLayout.tsx')

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
    assert.match(LAUNCHER, /canSeeModule\('attendance',/)
    assert.match(LAUNCHER, /canSeeModule\('payroll',\s+/)
    assert.match(LAUNCHER, /\(canSeeAttendance \|\| canSeePayroll\)/)
  })

  test('admins land on /payroll and employees on their own attendance', () => {
    assert.match(LAUNCHER, /const attendancePayrollHref = isModuleAdmin\s*\n\s*\? '\/payroll'/)
    assert.match(LAUNCHER, /canSeeAttendance \? '\/my-attendance' : '\/my-payroll'/)
  })

  test('the destination is decided by the same resolver the guards use', () => {
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
    assert.equal((SHELL.match(/<aside className/g) ?? []).length, 1, 'a second sidebar appeared')
    assert.equal((SHELL.match(/navItems\.map/g) ?? []).length, 1, 'the list is rendered twice')
  })

  test('the shell renders one header, one tab row and one notification bell', () => {
    assert.equal((SHELL.match(/boe-page-header/g) ?? []).length, 1)
    assert.equal((SHELL.match(/<ModuleSectionTabs/g) ?? []).length, 1)
    assert.equal((SHELL.match(/<IssueNotificationBell/g) ?? []).length, 1)
  })

  test('the bell is in the header, not the sidebar', () => {
    const header = SHELL.slice(SHELL.indexOf('{/* Page header */}'))
    const sidebar = SHELL.slice(SHELL.indexOf('<aside className'), SHELL.indexOf('</aside>'))
    assert.ok(header.includes('<IssueNotificationBell'))
    assert.equal(sidebar.includes('IssueNotificationBell'), false)
  })

  test('the module has one name, used by the shell', () => {
    assert.equal(ATTENDANCE_PAYROLL_MODULE_NAME, 'Attendance & Payroll')
    assert.match(SHELL, /\{ATTENDANCE_PAYROLL_MODULE_NAME\}/)
    assert.equal(SHELL.includes('Attendance & Salary'), false)
  })

  test('the role picks the list, and there are only two', () => {
    assert.equal(attendancePayrollNavFor(true), ATTENDANCE_PAYROLL_ADMIN_SECTIONS)
    assert.equal(attendancePayrollNavFor(false), ATTENDANCE_PAYROLL_EMPLOYEE_NAV)
  })

  test('the shell fetches no notification count of its own besides the shared hook', () => {
    assert.equal((SHELL.match(/useUnreadAttendancePayrollNotifications\(\)/g) ?? []).length, 1)
  })
})

// ─── 3. Six sections ─────────────────────────────────────────────────────────

describe('the admin sidebar is exactly six sections', () => {
  test('in this order, with these names', () => {
    assert.deepEqual(
      ATTENDANCE_PAYROLL_ADMIN_SECTIONS.map(s => s.label),
      ['Overview', 'Employees', 'Attendance', 'Payroll', 'Issues', 'Settings'],
    )
  })

  test('the grouped sections carry the agreed tabs', () => {
    const tabs = (key: string) =>
      ATTENDANCE_PAYROLL_ADMIN_SECTIONS.find(s => s.key === key)?.tabs?.map(t => t.label)
    assert.deepEqual(tabs('attendance'), ['Records', 'Upload', 'Monthly Review', 'Requests'])
    assert.deepEqual(tabs('payroll'), ['Monthly Preview', 'Payroll Runs', 'BOE Credits'])
    assert.deepEqual(tabs('settings'), ['Payroll Rules', 'Holidays'])
    for (const key of ['overview', 'employees', 'issues']) assert.equal(tabs(key), undefined, key)
  })

  test('How Payroll Works is Payroll\'s Help link, not a tab and not a section', () => {
    const payroll = ATTENDANCE_PAYROLL_ADMIN_SECTIONS.find(s => s.key === 'payroll')
    assert.equal(payroll?.help?.path, '/payroll/how-it-works')
    assert.equal(payroll?.tabs?.some(t => t.path === '/payroll/how-it-works'), false)
  })

  test('Notifications is not a section or a tab — it is the header bell', () => {
    const all = ATTENDANCE_PAYROLL_ADMIN_SECTIONS.flatMap(s => [s.path, ...(s.tabs ?? []).map(t => t.path)])
    for (const p of [ADMIN_NOTIFICATIONS_PATH, '/payroll/notifications', EMPLOYEE_NOTIFICATIONS_PATH]) {
      assert.equal(all.includes(p), false, p)
    }
    assert.equal(notificationsPathFor(true), '/attendance/notifications')
    assert.equal(notificationsPathFor(false), '/my-issues/notifications')
  })

  test('within one section no destination repeats', () => {
    for (const s of ATTENDANCE_PAYROLL_ADMIN_SECTIONS) {
      const paths = (s.tabs ?? []).map(t => t.path)
      assert.equal(new Set(paths).size, paths.length, `${s.key} repeats a tab`)
    }
    const sectionPaths = ATTENDANCE_PAYROLL_ADMIN_SECTIONS.map(s => s.path)
    assert.equal(new Set(sectionPaths).size, sectionPaths.length)
  })

  test('a section\'s landing page is its first useful tab or itself', () => {
    for (const s of ATTENDANCE_PAYROLL_ADMIN_SECTIONS.filter(s => s.tabs)) {
      assert.ok(s.tabs!.some(t => t.path === s.path), `${s.key} lands on a page that is not one of its tabs`)
    }
  })
})

// ─── 4. Every old destination is still reachable ─────────────────────────────

/**
 * The OLD sidebar, by route, and where each one lives now. Also the route map
 * delivered with the change. Bell = the header notification bell.
 */
const OLD_TO_NEW: Array<{ old: string; oldLabel: string; section: string; tab?: string }> = [
  { old: '/attendance',                oldLabel: 'Overview',                  section: 'Overview' },
  { old: '/attendance/employees',      oldLabel: 'Employee Master',           section: 'Employees' },
  { old: '/attendance/upload',         oldLabel: 'Attendance Upload',         section: 'Attendance', tab: 'Upload' },
  { old: '/attendance/records',        oldLabel: 'Attendance Records',        section: 'Attendance', tab: 'Records' },
  { old: '/attendance/monthly-review', oldLabel: 'Monthly Attendance Review', section: 'Attendance', tab: 'Monthly Review' },
  { old: '/attendance/requests',       oldLabel: 'Attendance Requests',       section: 'Attendance', tab: 'Requests' },
  { old: '/attendance/minop',          oldLabel: 'Minop Diagnostics',         section: 'Issues' },
  { old: '/payroll',                   oldLabel: 'Payroll Runs',              section: 'Payroll',    tab: 'Payroll Runs' },
  { old: '/payroll/monthly-review',    oldLabel: 'Payroll Monthly Preview',   section: 'Payroll',    tab: 'Monthly Preview' },
  { old: '/payroll/how-it-works',      oldLabel: 'How Payroll Works',         section: 'Payroll' },
  { old: '/payroll/settings',          oldLabel: 'Payroll Settings',          section: 'Settings',   tab: 'Payroll Rules' },
  { old: '/payroll/credits',           oldLabel: 'BOE Credits',               section: 'Payroll',    tab: 'BOE Credits' },
  { old: '/attendance/holidays',       oldLabel: 'Holiday Management',        section: 'Settings',   tab: 'Holidays' },
]

describe('all 14 old destinations are reachable through the new structure', () => {
  test('the old sidebar had 13 links plus the notification feed = 14', () => {
    assert.equal(OLD_TO_NEW.length + 1, 14)
  })

  for (const m of OLD_TO_NEW) {
    test(`${m.oldLabel} (${m.old}) → ${m.section}${m.tab ? ` › ${m.tab}` : ''}`, () => {
      const section = adminSectionFor(m.old)
      assert.equal(section?.label, m.section, `${m.old} lands in the wrong section`)
      if (m.tab) assert.equal(activeTabFor(m.old, section!)?.label, m.tab, `${m.old} lights the wrong tab`)
      // And it is a LINK the person can click, not merely a URL that resolves.
      const linked = [section!.path, ...(section!.tabs ?? []).map(t => t.path), ...(section!.help ? [section!.help.path] : [])]
      assert.ok(linked.includes(m.old) || m.old === '/attendance/employees' && section!.path === m.old,
        `${m.old} has no link in the ${m.section} section`)
    })
  }

  test('the notification feed is reachable through the bell, at its old address', () => {
    assert.equal(notificationsPathFor(true), '/attendance/notifications')
    assert.ok(existsSync(join(ROOT, 'src/app/attendance/notifications/page.tsx')))
    assert.ok(existsSync(join(ROOT, 'src/app/payroll/notifications/page.tsx')))
  })
})

describe('every navigation path is a real route', () => {
  const pageFor = (path: string) => join(ROOT, 'src', 'app', ...path.split('/').filter(Boolean), 'page.tsx')
  const allAdminPaths = ATTENDANCE_PAYROLL_ADMIN_SECTIONS.flatMap(s => [
    { label: s.label, path: s.path },
    ...(s.tabs ?? []).map(t => ({ label: `${s.label} › ${t.label}`, path: t.path })),
    ...(s.help ? [{ label: `${s.label} › ${s.help.label}`, path: s.help.path }] : []),
  ])

  for (const item of [...allAdminPaths, ...ATTENDANCE_PAYROLL_EMPLOYEE_NAV]) {
    test(`${item.label} → ${item.path}`, () => {
      assert.ok(existsSync(pageFor(item.path)), `${item.path} has no page.tsx — a nav link to nowhere`)
    })
  }
})

// ─── 5. The employee list is self-service only ───────────────────────────────

describe('the employee navigation', () => {
  test('is exactly the five self-service destinations', () => {
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

  test('an employee never gets a tab row', () => {
    // The shell resolves a section only for an admin.
    assert.match(SHELL, /const section = isAdmin \? adminSectionFor\(pathname\) : null/)
  })

  test('and hiding the admin links is NOT what stops an employee', () => {
    const attendanceGuard = read('src/app/attendance/layout.tsx')
    const payrollGuard    = read('src/app/payroll/layout.tsx')
    for (const [name, guard] of [['attendance', attendanceGuard], ['payroll', payrollGuard]] as const) {
      assert.match(guard, /resolveManagementAccess/, `${name} guard no longer resolves management access`)
      assert.match(guard, /router\.replace/, `${name} guard no longer redirects`)
    }
  })
})

// ─── 6. Active state ─────────────────────────────────────────────────────────

describe('active state', () => {
  const activeLabels = (pathname: string, nav: AttendancePayrollNavItem[]) =>
    nav.filter(i => isAttendancePayrollNavItemActive(pathname, i)).map(i => i.label)

  test('exactly one section owns every admin route', () => {
    for (const pathname of [
      '/attendance', '/attendance/employees', '/attendance/employees/abc',
      '/attendance/upload', '/attendance/records', '/attendance/monthly-review',
      '/attendance/monthly-review/user-1', '/attendance/requests', '/attendance/minop',
      '/attendance/holidays', '/attendance/correction-log',
      '/payroll', '/payroll/monthly-review', '/payroll/monthly-review/user-1',
      '/payroll/how-it-works', '/payroll/settings', '/payroll/credits',
      '/payroll/results/p1', '/payroll/results/p1/e1', '/payroll/results/p1/salary-report',
    ]) {
      const owners = ATTENDANCE_PAYROLL_ADMIN_SECTIONS.filter(s => adminSectionFor(pathname)?.key === s.key)
      assert.equal(owners.length, 1, `${pathname} is owned by ${owners.length} sections`)
    }
  })

  test('a section root does not claim the pages beneath it', () => {
    assert.equal(adminSectionFor('/attendance')?.label, 'Overview')
    assert.equal(adminSectionFor('/attendance/records')?.label, 'Attendance')
    assert.equal(adminSectionFor('/payroll')?.label, 'Payroll')
    assert.equal(adminSectionFor('/payroll/settings')?.label, 'Settings')
  })

  test('a payroll run and its payslips keep Payroll Runs lit', () => {
    for (const p of ['/payroll/results/p1', '/payroll/results/p1/e1', '/payroll/results/p1/salary-report']) {
      const s = adminSectionFor(p)!
      assert.equal(s.label, 'Payroll', p)
      assert.equal(activeTabFor(p, s)?.label, 'Payroll Runs', p)
    }
  })

  test('the payroll guide is Payroll\'s Help: section lit, no tab lit', () => {
    const s = adminSectionFor('/payroll/how-it-works')!
    assert.equal(s.label, 'Payroll')
    assert.equal(activeTabFor('/payroll/how-it-works', s), null)
  })

  test('the employee record and the monthly detail keep their parent lit', () => {
    assert.equal(adminSectionFor('/attendance/employees/abc')?.label, 'Employees')
    const s = adminSectionFor('/attendance/monthly-review/user-1')!
    assert.equal(activeTabFor('/attendance/monthly-review/user-1', s)?.label, 'Monthly Review')
    const p = adminSectionFor('/payroll/monthly-review/user-1')!
    assert.equal(activeTabFor('/payroll/monthly-review/user-1', p)?.label, 'Monthly Preview')
  })

  test('the correction log keeps Overview lit, since that is where it is reached from', () => {
    assert.equal(adminSectionFor('/attendance/correction-log')?.label, 'Overview')
  })

  test('the notification feeds belong to the bell, not to any section', () => {
    for (const p of ['/attendance/notifications', '/payroll/notifications']) {
      assert.equal(adminSectionFor(p), null, p)
    }
  })

  test('employee routes light exactly one item each', () => {
    assert.deepEqual(activeLabels('/my-attendance', ATTENDANCE_PAYROLL_EMPLOYEE_NAV), ['My Attendance'])
    assert.deepEqual(activeLabels('/my-payroll', ATTENDANCE_PAYROLL_EMPLOYEE_NAV), ['My Payroll'])
    assert.deepEqual(activeLabels('/my-payroll/period-1', ATTENDANCE_PAYROLL_EMPLOYEE_NAV), ['My Payroll'])
    assert.deepEqual(activeLabels('/my-issues', ATTENDANCE_PAYROLL_EMPLOYEE_NAV), ['My Issues'])
    assert.deepEqual(activeLabels('/payroll/how-it-works', ATTENDANCE_PAYROLL_EMPLOYEE_NAV), ['How Payroll Works'])
  })

  test('the employee notification feed belongs to the bell, not to My Issues', () => {
    assert.deepEqual(activeLabels('/my-issues/notifications', ATTENDANCE_PAYROLL_EMPLOYEE_NAV), [])
  })

  test('prefix matching is segment-aware, not string-prefix', () => {
    assert.equal(adminSectionFor('/attendance/records-archive'), null)
    assert.deepEqual(activeLabels('/my-attendance-summary', ATTENDANCE_PAYROLL_EMPLOYEE_NAV), [])
  })

  test('an unrelated route lights nothing', () => {
    for (const p of ['/modules', '/dashboard', '/finance']) {
      assert.equal(adminSectionFor(p), null, p)
      assert.deepEqual(activeLabels(p, ATTENDANCE_PAYROLL_EMPLOYEE_NAV), [], p)
    }
  })
})

// ─── 7. Nothing structural moved ─────────────────────────────────────────────

describe('the regrouping is user-interface only', () => {
  test('both URL trees still exist, unmoved', () => {
    for (const p of [
      'src/app/attendance/page.tsx', 'src/app/attendance/layout.tsx',
      'src/app/payroll/page.tsx', 'src/app/payroll/layout.tsx',
      'src/app/my-attendance/page.tsx', 'src/app/my-payroll/page.tsx',
      'src/app/my-issues/page.tsx',
      'src/app/attendance/notifications/page.tsx', 'src/app/payroll/notifications/page.tsx',
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

  test('the tab row fetches nothing, so an unopened tab costs nothing', () => {
    const tabs = read('src/components/layout/ModuleSectionTabs.tsx')
    for (const forbidden of ['fetch(', 'createClient', 'useQuery', 'router.prefetch']) {
      assert.equal(tabs.includes(forbidden), false, `the tab row reaches for ${forbidden}`)
    }
  })

  test('the nav definition is data, not a second access rule', () => {
    const nav = read('src/components/layout/attendancePayrollNav.tsx')
    for (const forbidden of ['role ===', 'resolveModuleAccess', 'resolveManagementAccess', 'createClient']) {
      assert.equal(nav.includes(forbidden), false, `the nav decides access via ${forbidden}`)
    }
  })
})
