-- Notification types for employee-raised attendance and payroll issues.
--
-- WHY A MIGRATION IS UNAVOIDABLE HERE
-- -----------------------------------
-- `notifications.type` is the strict enum `notification_type`. An insert with a
-- value the enum does not carry fails with 22P02, and because the notify path
-- is deliberately fire-and-forget (a notification must never fail the business
-- action that produced it) that failure is silent. So the alternative to this
-- migration is not "no migration" — it is an admin who is never told that an
-- employee disputed their pay.
--
-- Nothing else would do. There is no generic value to borrow: every existing
-- type names its own domain, and reusing one would send an objection to the
-- wrong deep link and count it in the wrong category in the notification list.
--
-- Purely ADDITIVE and backward-compatible, in the same shape as
-- 20260694000000: two enum values, nothing else. No table, no column, no
-- policy, no permission, no workflow, no existing behaviour is touched.
-- `ADD VALUE IF NOT EXISTS` makes it idempotent, and the new values are not
-- referenced within this migration, so PG never needs them committed
-- mid-transaction.
--
-- The values are read by getNotificationMeta() in src/lib/notificationMeta.ts,
-- which routes an attendance issue to the correction log and a payroll issue to
-- that employee's payslip — the two places an admin would actually deal with it.

ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'attendance_issue_raised';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'payroll_issue_raised';
