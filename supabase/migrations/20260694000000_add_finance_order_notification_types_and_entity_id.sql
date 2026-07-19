-- Finance & Order Management notifications reuse the shared `notifications`
-- table, but two schema facts blocked that from actually working:
--
--   1. `notifications.type` is the strict enum `notification_type`, whose values
--      were all task-related. Inserting a `finance_*` / `order_*` type failed the
--      enum check, so every Finance/Orders notify insert was silently rejected.
--   2. `notifications.task_id` is a FK to `tasks.id`, so it cannot carry a
--      payment-request / order-request UUID for deep-linking.
--
-- This migration is purely ADDITIVE and backward-compatible:
--   * extends the enum with the stable Finance/Orders type values (the contract
--     the shared list, unread count and mark-all-read now key off), and
--   * adds a nullable, FK-free `entity_id` column so a non-task notification can
--     point at its exact source record for the existing `?request=`/`?payment=`
--     deep-link contracts.
--
-- No RLS policy, permission, workflow, status rule, or existing task behavior is
-- touched. `ADD VALUE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` make it
-- idempotent, and the new enum values are not referenced within this migration
-- (so PG never needs them committed mid-transaction).

-- ── Finance payment-request notification types ───────────────────────────────
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'finance_submitted';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'finance_resubmitted';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'finance_clarification';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'finance_approved_suspense';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'finance_approved_linked';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'finance_rejected';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'finance_linked';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'finance_status_corrected';

-- ── Order-request notification types ─────────────────────────────────────────
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'order_submitted';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'order_assigned';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'order_clarification';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'order_resubmitted';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'order_rejected';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'order_converted';

-- ── Generic deep-link target for non-task notifications ──────────────────────
-- Nullable and intentionally without a FK: it may reference different tables
-- (finance_payment_requests, order_requests) depending on `type`, and task
-- notifications continue to use `task_id` unchanged.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS entity_id uuid;
