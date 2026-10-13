-- Notification types for Inventory booking requests.
--
--   inventory_booking_requested  written to every active approver (Admin, or a holder of inventory:approve)
--                                when a salesperson asks to book units
--   inventory_booking_decided    written to the salesperson when somebody else confirms or rejects the
--                                request, or reverses a confirmed sale
--
-- APPLY THIS BEFORE DEPLOYING THE CODE. INVENTORY_NOTIFICATION_TYPES (src/lib/notifications.ts) names both
-- values, and the category filter is `type.in.(…)`: PostgREST rejects the whole filter with 22P02 when one
-- value is missing from the enum, so the wrong order stops the Inventory feed loading (same contract as
-- 20260825000000 and 20270215000100).
--
-- Purely additive. `ADD VALUE IF NOT EXISTS` is idempotent and neither value is used inside this migration
-- (the trigger that writes them is 20270314000100, a separate file, because a new enum value cannot be used
-- in the transaction that adds it).
--
-- Rollback: enum values cannot be dropped in place; leaving them is harmless.

ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'inventory_booking_requested';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'inventory_booking_decided';
