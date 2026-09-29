-- Notification types for attendance requests.
--
--   attendance_request_submitted  written to every active admin when an
--                                 employee submits or corrects a request
--   attendance_request_decided    written to the employee when an admin
--                                 approves or rejects it
--
-- APPLY THIS BEFORE DEPLOYING THE CODE. ATTENDANCE_PAYROLL_NOTIFICATION_TYPES
-- (src/lib/notifications.ts) names both values, and the category filter is
-- `type.in.(…)`: PostgREST rejects the whole filter with 22P02 when one value
-- is missing from the enum, so the wrong order stops the entire Attendance &
-- Payroll feed loading (same contract as 20260825000000).
--
-- Purely additive. `ADD VALUE IF NOT EXISTS` is idempotent and neither value is
-- used inside this migration.
--
-- Rollback: enum values cannot be dropped in place; leaving them is harmless.

ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'attendance_request_submitted';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'attendance_request_decided';
