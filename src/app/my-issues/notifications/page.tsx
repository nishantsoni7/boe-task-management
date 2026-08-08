'use client'

import { AttendanceLayout } from '@/components/layout/AttendanceLayout'
import { NotificationsView } from '@/components/notifications/NotificationsView'

// The EMPLOYEE's door into the Attendance & Payroll issue feed — the third one,
// beside /attendance/notifications and /payroll/notifications, and the same
// feed as both.
//
// Why a third route rather than reusing one of the other two: those live under
// /attendance and /payroll, which are the management surfaces and are behind
// AttendanceGuard / PayrollGuard (admins only, and no Control Center visibility
// mode can widen that — see SELF_SERVICE_MODULE_KEYS). An employee sent there
// would simply be bounced. This route sits beside /my-issues, which is where
// their own reports already live.
//
// One feed, not four: same `attendance_payroll` category, same query keys, same
// NotificationsView, so read/unread, mark-all-read and delete behave exactly as
// they do everywhere else and no second notification system exists.
//
// Isolation is by ROW, not by route. Every notification endpoint scopes to
// `user_id = caller`, so what an employee reads here is the notifications
// addressed to them — the outcome of their own issues — and nothing else. The
// admin-facing `*_issue_raised` rows are written only to admin user ids, so
// they are not in an employee's answer to begin with.
export default function MyIssueNotificationsPage() {
  return <NotificationsView category="attendance_payroll" Layout={AttendanceLayout} />
}
