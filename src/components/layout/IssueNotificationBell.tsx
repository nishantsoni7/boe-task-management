'use client'

// The Attendance & Payroll notification bell, in one place for both shells.
//
// WHAT WAS WRONG
// --------------
// Every other module shows its bell in two states: the large alert block while
// something is unread, and a quiet sidebar entry when nothing is (Samples,
// Finance, Orders, Dashboard all do exactly this). Attendance and Payroll had
// only the quiet entry, and only for admins — so from an employee's side the
// bell never moved, never counted anything and looked broken, which is what it
// effectively was: no notification of this category was ever addressed to them.
//
// The count itself is not this component's business. It comes from the one
// shared hook, against the one shared category, so the Attendance sidebar and
// the Payroll sidebar cannot show different numbers. This is presentation only.
//
// Nothing here is a second notification system: the destination is a page that
// renders the shared NotificationsView, and read/unread, mark-all-read and
// delete all still belong to the existing notification infrastructure.

import { useRouter } from 'next/navigation'
import { Bell } from 'lucide-react'
import { NotificationsNavItem } from '@/components/layout/NotificationsNavItem'

export function IssueNotificationBell({
  unread, href, onNavigate,
}: {
  unread: number
  /** Where this role reads the feed — the admin queue, or the employee's own. */
  href: string
  /** Closes the mobile sidebar. Navigation is this component's own job. */
  onNavigate?: () => void
}) {
  const router = useRouter()

  if (unread > 0) {
    return (
      <div style={{ padding: '0 10px 14px' }}>
        <button
          type="button"
          onClick={() => { router.push(href); onNavigate?.() }}
          className="boe-notif-alert"
          aria-label={`Notifications, ${unread} unread`}
        >
          <div className="boe-notif-alert-bell">
            <Bell size={24} strokeWidth={1.8} color="#DC1F2E" />
          </div>
          <div style={{ fontSize: '28px', fontWeight: 800, color: '#111318', lineHeight: 1 }}>
            {unread > 99 ? '99+' : unread}
          </div>
          <div style={{ fontSize: '11.5px', fontWeight: 600, color: '#3D4455' }}>
            unread {unread === 1 ? 'notification' : 'notifications'}
          </div>
          <div style={{
            fontSize: '10px', fontWeight: 600, color: '#DC1F2E',
            letterSpacing: '0.05em', textTransform: 'uppercase',
          }}>
            Tap to review →
          </div>
        </button>
      </div>
    )
  }

  // Nothing unread: the same permanent entry every module keeps, so the feed is
  // never hidden by its own count.
  return (
    <div style={{ padding: '0 10px 8px' }}>
      <NotificationsNavItem
        href={href}
        count={unread}
        onNavigate={onNavigate}
      />
    </div>
  )
}
