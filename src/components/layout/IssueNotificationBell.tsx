'use client'

// The Attendance & Payroll notification bell — one place, in the page header.
//
// It used to be a sidebar entry that swelled into a large "N unread" block. With
// the sidebar reduced to six sections it moved up beside the page actions,
// where every BOE module's bell already lives (the Modules launcher's
// announcement bell, for one), and where an unread count is visible on every
// page of the module without opening the menu on a phone.
//
// NOTHING ABOUT THE FEED CHANGED. The destination is the same page as before —
// /attendance/notifications for an admin, /my-issues/notifications for an
// employee — which renders the shared NotificationsView. Read / unread,
// mark-all-read and delete still belong to the existing notification
// infrastructure.
//
// The count is not this component's business either. It comes from the one
// shared hook against the one shared category (useUnread…Notifications), so the
// number cannot differ between pages, and TanStack dedupes it to one request.
// This file is presentation only.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Bell } from 'lucide-react'
import styles from './attendancePayrollShell.module.css'

export function IssueNotificationBell({
  unread, href,
}: {
  unread: number
  /** Where this role reads the feed — the admin queue, or the employee's own. */
  href: string
}) {
  const pathname = usePathname()
  // Both admin addresses of the shared feed light the bell; it is the same page.
  const active = pathname === href || pathname === '/payroll/notifications'
  const label = unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'

  return (
    <Link
      href={href}
      className={`${styles.iconBtn}${active ? ` ${styles.iconBtnActive}` : ''}`}
      aria-label={label}
      title="Notifications"
      aria-current={active ? 'page' : undefined}
    >
      <Bell size={16} strokeWidth={1.9} aria-hidden="true" />
      {unread > 0 && (
        <span className={styles.bellBadge} aria-hidden="true">{unread > 99 ? '99+' : unread}</span>
      )}
    </Link>
  )
}
