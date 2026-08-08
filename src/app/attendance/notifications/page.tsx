'use client'

import { AttendanceLayout } from '@/components/layout/AttendanceLayout'
import { NotificationsView } from '@/components/notifications/NotificationsView'

// Attendance & Payroll issue notifications — employees reporting a problem with
// their own attendance day or payslip.
//
// ONE feed, reachable from either module. This route and /payroll/notifications
// render the SAME shared list against the SAME `attendance_payroll` category, so
// they read the same rows, the same unread count and the same query cache; only
// the surrounding shell differs, so an admin stays in whichever module they were
// already working in. Two categories would have meant two bells for one queue.
//
// Nothing about read/unread, mark-all-read, select, delete-one, delete-selected
// or delete-all is reimplemented here — that all lives in NotificationsView and
// useNotificationMutations, exactly as Finance, Orders and Assets & Access use
// it. AttendanceLayout already matches NotificationsView's Layout contract
// (profile / title / subtitle / actions / onSignOut / children), so no adapter
// is needed.
//
// Access: /attendance is admin-only (AttendanceGuard → resolveManagementAccess),
// and the API refuses this category to a non-admin regardless of how it is
// called — see canReadNotificationCategory in src/lib/notificationAccess.ts.
export default function AttendanceNotificationsPage() {
  return <NotificationsView category="attendance_payroll" Layout={AttendanceLayout} />
}
