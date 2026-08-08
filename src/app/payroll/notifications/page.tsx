'use client'

import { PayrollLayout } from '@/components/layout/PayrollLayout'
import { NotificationsView } from '@/components/notifications/NotificationsView'

// The Payroll module's door into the SAME Attendance & Payroll issue feed that
// /attendance/notifications shows — same `attendance_payroll` category, same
// rows, same unread count, same cache keys. See that file for the reasoning;
// the only difference here is the shell, so an admin reviewing payroll is not
// thrown into the Attendance module to read a payroll dispute.
//
// Access: /payroll is admin-only (PayrollGuard → resolveManagementAccess), and
// the API refuses this category to a non-admin regardless.
export default function PayrollNotificationsPage() {
  return <NotificationsView category="attendance_payroll" Layout={PayrollLayout} />
}
