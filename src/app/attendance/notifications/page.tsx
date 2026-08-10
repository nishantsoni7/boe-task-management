'use client'

import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { NotificationsView } from '@/components/notifications/NotificationsView'

// Attendance & Payroll issue notifications — employees reporting a problem with
// their own attendance day or payslip.
//
// ONE feed. This route and /payroll/notifications render the SAME shared list
// against the SAME `attendance_payroll` category, so they read the same rows,
// the same unread count and the same query cache. Two categories would have
// meant two bells for one queue.
//
// This is the admin's canonical address for it, and the only one the sidebar
// offers now that Attendance and Payroll are one module; /payroll/notifications
// stays reachable so existing links keep working.
//
// Nothing about read/unread, mark-all-read, select, delete-one, delete-selected
// or delete-all is reimplemented here — that all lives in NotificationsView and
// useNotificationMutations, exactly as Finance, Orders and Assets & Access use
// it. AttendancePayrollLayout already matches NotificationsView's Layout contract
// (profile / title / subtitle / actions / onSignOut / children), so no adapter
// is needed.
//
// Access: /attendance is admin-only (AttendanceGuard → resolveManagementAccess),
// and the API refuses this category to a non-admin regardless of how it is
// called — see canReadNotificationCategory in src/lib/notificationAccess.ts.
export default function AttendanceNotificationsPage() {
  return <NotificationsView category="attendance_payroll" Layout={AttendancePayrollLayout} />
}
