'use client'

// The ONE navigation definition for the combined Attendance & Payroll module.
//
// Attendance and Payroll are a single module to the person using them — the
// punches attendance records are the input every payroll figure is computed
// from — so they get one launcher card, one shell and one sidebar. Internally
// they stay exactly as separate as they were: different tables, different
// calculations, different audit trails, different guards
// (AttendanceGuard / PayrollGuard), different URL trees. Merging the NAVIGATION
// is not merging the domains.
//
// Why this file exists at all: the Attendance sidebar and the Payroll sidebar
// used to be two hand-maintained copies of the same array in two near-identical
// shell components. There is now one list, rendered by one shell
// (AttendancePayrollLayout), on both desktop and mobile — the mobile menu is
// the same <aside> with a class toggled, so it cannot drift from the desktop
// one by construction.
//
// SIX SECTIONS, NOT FOURTEEN LINKS. The admin sidebar used to list every page
// (14 entries counting the notification bell), which left nobody able to tell
// where related work lived. It is now six sections, and the pages that belong
// together are reached through one row of TABS under the page header (see
// ModuleSectionTabs). A tab is an ordinary link to the page's existing URL:
// no route moved, so every bookmark, notification link and browser Back press
// keeps working, and a tab that is not open loads nothing.
//
// Every path below is an EXISTING route. Nothing here creates a page.

import {
  Banknote, BookOpen, ClipboardList, CalendarDays, LayoutDashboard,
  MessageSquareWarning, SlidersHorizontal, Users, Coins,
} from 'lucide-react'
import { PAYROLL_GUIDE_PATH } from '@/lib/payroll/guidePath'
import { MY_CREDITS_PATH } from '@/lib/boeCredits/paths'

/** The user-facing name of the combined module, in one place. */
export const ATTENDANCE_PAYROLL_MODULE_NAME = 'Attendance & Payroll'

/** Where an admin reads the module's notification feed. Header bell, not a nav entry. */
export const ADMIN_NOTIFICATIONS_PATH = '/attendance/notifications'
/** Where an employee reads the same feed. */
export const EMPLOYEE_NOTIFICATIONS_PATH = '/my-issues/notifications'

export type AttendancePayrollNavItem = {
  label: string
  path: string
  icon: React.ReactNode
  /**
   * Only `pathname === path` lights this item. Used by the two module roots,
   * `/attendance` and `/payroll`, which would otherwise claim every page below
   * them.
   */
  exact?: boolean
  /** Extra route trees that belong to this item but do not sit under its path. */
  alsoActiveFor?: string[]
  /** Route trees that must NOT light this item, checked before everything else. */
  notActiveFor?: string[]
}

/** One tab inside a section. Same matching rules as a nav item, no icon. */
export type AttendancePayrollTab = Omit<AttendancePayrollNavItem, 'icon'>

export type AttendancePayrollSection = AttendancePayrollNavItem & {
  /** Stable key for React and for tests. */
  key: string
  /**
   * The pages grouped under this section. Rendered as one row of tabs beneath
   * the page header. Absent for a section that is a single page.
   */
  tabs?: AttendancePayrollTab[]
  /** A secondary link at the end of the tab row (e.g. Payroll's Help). */
  help?: AttendancePayrollTab
}

/**
 * ADMIN — the management surface, admins only. Six sections.
 *
 * Ordering follows the work: the overview, the people, what came in
 * (attendance), what was computed from it (payroll), what needs attention, and
 * the configuration behind all of it.
 *
 * Section paths are where clicking the sidebar lands:
 *   Attendance → Records (the everyday view, and cheap to open)
 *   Payroll    → Payroll Runs (`/payroll`, the module's historic front door)
 *
 * Not tabs, deliberately:
 *   Notifications — the header bell (IssueNotificationBell), which carries the
 *                   unread count. A second plain link would be the duplicate
 *                   entry point.
 *   How Payroll Works — Payroll's Help link; the page also keeps serving every
 *                   employee (PayrollGuard's stated exception).
 *   Salary Report — `/payroll/results/[periodId]/salary-report` exists only for
 *                   a chosen period; it is reached from a payroll run.
 */
export const ATTENDANCE_PAYROLL_ADMIN_SECTIONS: AttendancePayrollSection[] = [
  {
    key: 'overview',
    label: 'Overview',
    path: '/attendance',
    exact: true,
    // The correction log is an admin utility reached from the overview cards.
    alsoActiveFor: ['/attendance/correction-log'],
    icon: <LayoutDashboard size={15} strokeWidth={1.8} />,
  },
  {
    key: 'employees',
    label: 'Employees',
    path: '/attendance/employees',
    icon: <Users size={15} strokeWidth={1.8} />,
  },
  {
    key: 'attendance',
    label: 'Attendance',
    path: '/attendance/records',
    // Nothing under /attendance/* that another section owns.
    alsoActiveFor: [
      '/attendance/upload', '/attendance/monthly-review', '/attendance/requests',
    ],
    icon: <CalendarDays size={15} strokeWidth={1.8} />,
    tabs: [
      { label: 'Records',        path: '/attendance/records' },
      { label: 'Upload',         path: '/attendance/upload' },
      { label: 'Monthly Review', path: '/attendance/monthly-review' },
      { label: 'Requests',       path: '/attendance/requests' },
    ],
  },
  {
    key: 'payroll',
    label: 'Payroll',
    path: '/payroll',
    // Every payroll page except Settings and the notification feed, which
    // /payroll/... would otherwise also claim.
    notActiveFor: ['/payroll/settings', '/payroll/notifications'],
    icon: <Banknote size={15} strokeWidth={1.8} />,
    tabs: [
      { label: 'Monthly Preview', path: '/payroll/monthly-review' },
      // A generated run and its per-employee payslips live under /payroll/results.
      { label: 'Payroll Runs',    path: '/payroll', exact: true, alsoActiveFor: ['/payroll/results'] },
      { label: 'BOE Credits',     path: '/payroll/credits' },
    ],
    help: { label: 'How Payroll Works', path: PAYROLL_GUIDE_PATH },
  },
  {
    key: 'issues',
    label: 'Issues',
    // Minop is the biometric machine's sync feed; the page is titled
    // "Attendance Sync". The section is named for what an admin comes to do.
    path: '/attendance/minop',
    icon: <MessageSquareWarning size={15} strokeWidth={1.8} />,
  },
  {
    key: 'settings',
    label: 'Settings',
    path: '/payroll/settings',
    alsoActiveFor: ['/attendance/holidays'],
    icon: <SlidersHorizontal size={15} strokeWidth={1.8} />,
    tabs: [
      { label: 'Payroll Rules', path: '/payroll/settings' },
      { label: 'Holidays',      path: '/attendance/holidays' },
    ],
  },
]

/**
 * EMPLOYEE — self-service, one person's own record and nothing else.
 *
 * Every destination here is served by an API that derives the employee from the
 * bearer token, so there is no employee id to tamper with. None of the admin
 * routes above appear, and hiding them is a usability decision rather than the
 * control: AttendanceGuard, PayrollGuard, the route handlers and RLS are what
 * actually refuse a non-admin.
 *
 * `How Payroll Works` is the one /payroll route an employee may open —
 * PayrollGuard admits everybody to PAYROLL_GUIDE_PATH and redirects them away
 * from every other one. The page renders rule constants and reads no employee
 * record, which is why the exception is safe.
 */
export const ATTENDANCE_PAYROLL_EMPLOYEE_NAV: AttendancePayrollNavItem[] = [
  { label: 'My Attendance', path: '/my-attendance', icon: <CalendarDays size={15} strokeWidth={1.8} /> },
  { label: 'My Payroll',    path: '/my-payroll',    icon: <ClipboardList size={15} strokeWidth={1.8} /> },
  // Balance, uses, this month's review progress, history — and the guide
  // under it. Served by routes that derive the employee from the token.
  { label: 'BOE Credits',   path: MY_CREDITS_PATH,  icon: <Coins size={15} strokeWidth={1.8} /> },
  {
    label: 'My Issues',
    path: '/my-issues',
    // The employee's notification feed sits under /my-issues but belongs to the
    // bell in the header, which lights up for it instead.
    notActiveFor: ['/my-issues/notifications'],
    icon: <MessageSquareWarning size={15} strokeWidth={1.8} />,
  },
  { label: 'How Payroll Works', path: PAYROLL_GUIDE_PATH, icon: <BookOpen size={15} strokeWidth={1.8} /> },
]

/** The sidebar this role sees. One call site, so desktop and mobile cannot differ. */
export function attendancePayrollNavFor(isAdmin: boolean): AttendancePayrollNavItem[] {
  return isAdmin ? ATTENDANCE_PAYROLL_ADMIN_SECTIONS : ATTENDANCE_PAYROLL_EMPLOYEE_NAV
}

/** Where this role reads the notification feed. */
export function notificationsPathFor(isAdmin: boolean): string {
  return isAdmin ? ADMIN_NOTIFICATIONS_PATH : EMPLOYEE_NOTIFICATIONS_PATH
}

/** Whether `pathname` is inside `base` — the tree, not a name that starts the same way. */
function isUnder(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`)
}

/**
 * Whether this item (a sidebar entry or a tab) should render as the current page.
 *
 * Prefix matching is segment-aware: `/attendance/records` must not light up for
 * a hypothetical `/attendance/records-archive`.
 */
export function isAttendancePayrollNavItemActive(
  pathname: string,
  item: AttendancePayrollTab,
): boolean {
  if (item.notActiveFor?.some(p => isUnder(pathname, p))) return false
  if (item.exact ? pathname === item.path : isUnder(pathname, item.path)) return true
  return (item.alsoActiveFor ?? []).some(p => isUnder(pathname, p))
}

/**
 * The admin section a pathname belongs to, or null (notifications, an account
 * page, an unrelated route). Sections are checked in order and the first match
 * wins, which is why Payroll excludes Settings explicitly.
 */
export function adminSectionFor(pathname: string): AttendancePayrollSection | null {
  return ATTENDANCE_PAYROLL_ADMIN_SECTIONS.find(s => {
    // A section that owns tabs is active for the tab it is reached through, and
    // for the payroll guide, which is Payroll's Help page.
    if (isAttendancePayrollNavItemActive(pathname, s)) return true
    if (s.help && isAttendancePayrollNavItemActive(pathname, s.help)) return true
    return false
  }) ?? null
}

/** The tab of `section` that `pathname` belongs to, if any. */
export function activeTabFor(
  pathname: string,
  section: AttendancePayrollSection,
): AttendancePayrollTab | null {
  return section.tabs?.find(t => isAttendancePayrollNavItemActive(pathname, t)) ?? null
}
