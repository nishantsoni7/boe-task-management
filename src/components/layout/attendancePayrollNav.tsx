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
// shell components. A link added to one silently went missing from the other,
// which is how /attendance/monthly-review ended up reachable only from a card
// on the overview page. There is now one list, rendered by one shell
// (AttendancePayrollLayout), on both desktop and mobile — the mobile menu is
// the same <aside> with a class toggled, so it cannot drift from the desktop
// one by construction.
//
// Every path below is an EXISTING route. Nothing here creates a page.

import {
  Banknote, BookOpen, CalendarDays, CalendarX, ClipboardList, FileBarChart,
  LayoutDashboard, MessageSquareWarning, SlidersHorizontal, Upload, Users, Coins,
} from 'lucide-react'
import { PAYROLL_GUIDE_PATH } from '@/lib/payroll/guidePath'

/** The user-facing name of the combined module, in one place. */
export const ATTENDANCE_PAYROLL_MODULE_NAME = 'Attendance & Payroll'

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

/**
 * ADMIN — the management surface, admins only.
 *
 * Ordering follows the work: what came in (attendance), then what was computed
 * from it (payroll), then the reference and configuration pages.
 *
 * Two entries carry their page's own title rather than a generic one, because
 * `/attendance/monthly-review` ("Monthly Attendance Review") and
 * `/payroll/monthly-review` ("Payroll Monthly Preview") are different screens
 * over different data, and one label named "Monthly Review" for both would be a
 * link that lies about where it goes.
 *
 * Not here, deliberately:
 *   Issues        — the sidebar's door onto the issue feed is IssueNotificationBell,
 *                   which carries the unread count. A second plain link would be
 *                   the duplicate entry point this consolidation removes.
 *   Salary Report — `/payroll/results/[periodId]/salary-report` exists only for a
 *                   chosen period; there is no period-free route to link to, and
 *                   inventing one is not this task. It is reached from a payroll
 *                   run, where the period is known.
 */
export const ATTENDANCE_PAYROLL_ADMIN_NAV: AttendancePayrollNavItem[] = [
  {
    label: 'Overview',
    path: '/attendance',
    exact: true,
    // The correction log is an admin utility reached from the overview cards.
    alsoActiveFor: ['/attendance/correction-log'],
    icon: <LayoutDashboard size={15} strokeWidth={1.8} />,
  },
  { label: 'Employee Master',           path: '/attendance/employees',      icon: <Users size={15} strokeWidth={1.8} /> },
  { label: 'Attendance Upload',         path: '/attendance/upload',         icon: <Upload size={15} strokeWidth={1.8} /> },
  { label: 'Attendance Records',        path: '/attendance/records',        icon: <ClipboardList size={15} strokeWidth={1.8} /> },
  { label: 'Monthly Attendance Review', path: '/attendance/monthly-review', icon: <CalendarDays size={15} strokeWidth={1.8} /> },
  {
    label: 'Payroll Runs',
    path: '/payroll',
    exact: true,
    // A generated run and its per-employee payslips live under /payroll/results.
    alsoActiveFor: ['/payroll/results'],
    icon: <Banknote size={15} strokeWidth={1.8} />,
  },
  { label: 'Payroll Monthly Preview',   path: '/payroll/monthly-review',    icon: <FileBarChart size={15} strokeWidth={1.8} /> },
  { label: 'How Payroll Works',         path: PAYROLL_GUIDE_PATH,           icon: <BookOpen size={15} strokeWidth={1.8} /> },
  { label: 'Payroll Settings',          path: '/payroll/settings',          icon: <SlidersHorizontal size={15} strokeWidth={1.8} /> },
  { label: 'BOE Credits',               path: '/payroll/credits',           icon: <Coins size={15} strokeWidth={1.8} /> },
  { label: 'Holiday Management',        path: '/attendance/holidays',       icon: <CalendarX size={15} strokeWidth={1.8} /> },
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
  {
    label: 'My Issues',
    path: '/my-issues',
    // The employee's notification feed sits under /my-issues but belongs to the
    // bell below the nav, which lights up for it instead.
    notActiveFor: ['/my-issues/notifications'],
    icon: <MessageSquareWarning size={15} strokeWidth={1.8} />,
  },
  { label: 'How Payroll Works', path: PAYROLL_GUIDE_PATH, icon: <BookOpen size={15} strokeWidth={1.8} /> },
]

/** The nav this role sees. One call site, so desktop and mobile cannot differ. */
export function attendancePayrollNavFor(isAdmin: boolean): AttendancePayrollNavItem[] {
  return isAdmin ? ATTENDANCE_PAYROLL_ADMIN_NAV : ATTENDANCE_PAYROLL_EMPLOYEE_NAV
}

/** Whether `pathname` is inside `base` — the tree, not a name that starts the same way. */
function isUnder(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`)
}

/**
 * Whether this item should render as the current page.
 *
 * Prefix matching is segment-aware: `/attendance/records` must not light up for
 * a hypothetical `/attendance/records-archive`, which the previous
 * `startsWith(path)` in both shells would have done.
 */
export function isAttendancePayrollNavItemActive(
  pathname: string,
  item: AttendancePayrollNavItem,
): boolean {
  if (item.notActiveFor?.some(p => isUnder(pathname, p))) return false
  if (item.exact ? pathname === item.path : isUnder(pathname, item.path)) return true
  return (item.alsoActiveFor ?? []).some(p => isUnder(pathname, p))
}
