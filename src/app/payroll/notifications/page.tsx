'use client'

import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { NotificationsView } from '@/components/notifications/NotificationsView'

// The SAME Attendance & Payroll issue feed /attendance/notifications shows —
// same `attendance_payroll` category, same rows, same unread count, same cache
// keys, and since the modules were merged the same shell too. See that file for
// the reasoning.
//
// This URL is now a SECOND ADDRESS for one page rather than a second door: the
// sidebar offers the feed once, at /attendance/notifications. The route is kept
// because bookmarks and anything already pointing here must keep resolving —
// removing it would break links to fix nothing.
//
// Access: /payroll is admin-only (PayrollGuard → resolveManagementAccess), and
// the API refuses this category to a non-admin regardless.
export default function PayrollNotificationsPage() {
  return <NotificationsView category="attendance_payroll" Layout={AttendancePayrollLayout} />
}
