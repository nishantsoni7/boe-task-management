-- Attendance machine: the notification sent when punches stop reaching BOE.
--
-- Postgres cannot use a new enum value in the transaction that adds it, so the
-- value lives alone in this migration. It MUST be applied before the code that
-- names it ships: the Attendance & Payroll feed filters on this value, and an
-- unknown value in that filter fails the whole feed.

ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'attendance_machine_stopped';
