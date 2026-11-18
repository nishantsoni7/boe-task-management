-- Day Close, the attendance hold (owner, 2026-11-18): the notification type for every hold message
-- ("you left with work open", "tomorrow is on hold", "your punch-in is not counted", "today is counted").
--
-- Postgres cannot use a new enum value in the transaction that adds it, so the value lives alone in this
-- migration. Apply it BEFORE 20270802000100 and before the code that names it ships: the Attendance & Payroll
-- feed filters on this value, and an unknown value in that filter fails the whole feed.

ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'day_close_hold';
