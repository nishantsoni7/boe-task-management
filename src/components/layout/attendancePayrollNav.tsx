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
  Banknote, BookOpen, CalendarDays, CalendarX, ClipboardList,
  LayoutDashboard, MessageSquareWarning, SlidersHorizontal, Users, Coins,
} from 'lucide-react'
import { PAYROLL_GUIDE_PATH } from '@/lib/payroll/guidePath'
import { MY_CREDITS_PATH } from '@/lib/boeCredits/paths'

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
  /**
   * Which section header this item renders under. Undefined items are the two
   * primary operational entries (Overview, View Attendance, View Payroll) and
   * render with no header at all — they are the whole point of the sidebar and
   * do not need one. Grouped items render below a small label the first time
   * their group differs from the previous item's.
   */
  group?: 'administration' | 'help'
}

/** Display label for each group, in the order they render. */
export const ATTENDANCE_PAYROLL_NAV_GROUP_LABEL: Record<'administration' | 'help', string> = {
  administration: 'Administration',
  help:           'Help',
}

/**
 * ADMIN — the management surface, admins only.
 *
 * Four primary operational destinations, Overview included: View Attendance,
 * View Payroll and Payroll Issues. Everything else an admin needs is either
 * reached FROM one of those (Attendance Upload from View Attendance's own
 * action button; Attendance Records and the Correction Log from Overview's
 * cards, unchanged; period create/generate/lock/unlock/delete from View
 * Payroll's own controls) or grouped below as Administration/Help — employee
 * and holiday configuration, settings, credits, the guide.
 *
 * The routes behind Attendance Records and Attendance Upload have not moved
 * and still work when linked to directly; they are simply no longer their own
 * top-level nav entries, because an admin should not have to already know that
 * "raw records" and "the upload tool" are separate implementation pages to
 * find the one workspace ("what happened this month") they actually want.
 *
 * Payroll Runs is GONE from navigation entirely, not merely regrouped: its
 * period-lifecycle actions (create, generate, lock, unlock, delete,
 * participation) now live inside View Payroll itself, because "view this
 * month's payroll" and "administer this month's payroll" turned out to be one
 * task to the person doing it, not two screens. `/payroll` itself still
 * resolves — see the redirect at src/app/payroll/page.tsx — so no bookmark or
 * hardcoded link breaks; it simply forwards to View Payroll rather than being
 * its own destination.
 *
 * Not here, deliberately:
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
    // The correction log and the raw records list are admin utilities reached
    // from the overview cards, not from their own sidebar entries.
    alsoActiveFor: ['/attendance/correction-log', '/attendance/records'],
    icon: <LayoutDashboard size={15} strokeWidth={1.8} />,
  },
  {
    label: 'View Attendance',
    path: '/attendance/monthly-review',
    // Upload is reached from a button on this page, not a sidebar entry of
    // its own — the nav should still read as "still on View Attendance"
    // while an admin is there.
    alsoActiveFor: ['/attendance/upload'],
    icon: <CalendarDays size={15} strokeWidth={1.8} />,
  },
  {
    label: 'View Payroll',
    path: '/payroll/monthly-review',
    // A month that already has a generated run redirects here to the stored
    // payslip experience — still "View Payroll" from the admin's side, not a
    // different destination.
    //
    // Bare `/payroll` is deliberately NOT listed here: it now redirects
    // straight to this page (src/app/payroll/page.tsx), so nobody's browser
    // sits on it long enough to need it highlighted, and `isUnder` would
    // otherwise treat EVERY /payroll/* route as "under" it — including
    // Payroll Settings and BOE Credits, which are their own nav items.
    alsoActiveFor: ['/payroll/results'],
    icon: <Banknote size={15} strokeWidth={1.8} />,
  },
  {
    label: 'Payroll Issues',
    path: '/payroll/issues',
    icon: <MessageSquareWarning size={15} strokeWidth={1.8} />,
  },
  { label: 'Employee Master',    path: '/attendance/employees', icon: <Users size={15} strokeWidth={1.8} />,             group: 'administration' },
  { label: 'Holiday Management', path: '/attendance/holidays',  icon: <CalendarX size={15} strokeWidth={1.8} />,         group: 'administration' },
  { label: 'Payroll Settings',   path: '/payroll/settings',     icon: <SlidersHorizontal size={15} strokeWidth={1.8} />, group: 'administration' },
  { label: 'BOE Credits',        path: '/payroll/credits',      icon: <Coins size={15} strokeWidth={1.8} />,             group: 'administration' },
  { label: 'How Payroll Works',  path: PAYROLL_GUIDE_PATH,      icon: <BookOpen size={15} strokeWidth={1.8} />,          group: 'help' },
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
