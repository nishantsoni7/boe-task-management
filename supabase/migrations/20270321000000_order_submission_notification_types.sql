-- ═══════════════════════════════════════════════════════════════════════════
-- 20270321000000  ORDERS NOTIFICATION TYPES — the values the next migration
--                 and /api/orders/submissions/notify need
-- ═══════════════════════════════════════════════════════════════════════════
--
-- notifications.type is a PG ENUM (notification_type), so a value must exist
-- before anything inserts it. This file ONLY adds values; it is separate from
-- 20270321000001 because a value added by ALTER TYPE ... ADD VALUE cannot be
-- USED in the same transaction that adds it.
--
--   pi_correction_requested / _resolved / _rejected
--       already inserted by /api/orders/submissions/notify, but never added —
--       every such insert failed with an enum error (owner audit, 2026-10-19).
--   pi_review_requested   a PI was sent for approval (to approve_order holders)
--   pi_review_decided     a PI was returned for changes or rejected (to its owner)
--   order_change_requested / order_change_decided
--                         an Order change request raised (to admins) / decided
--                         (to the requester)
--   order_update_approval a Fabric or Finish approval status recorded on an Order
--
-- ADD VALUE IF NOT EXISTS: re-running this file is a no-op. Purely additive.

alter type notification_type add value if not exists 'pi_correction_requested';
alter type notification_type add value if not exists 'pi_correction_resolved';
alter type notification_type add value if not exists 'pi_correction_rejected';
alter type notification_type add value if not exists 'pi_review_requested';
alter type notification_type add value if not exists 'pi_review_decided';
alter type notification_type add value if not exists 'order_change_requested';
alter type notification_type add value if not exists 'order_change_decided';
alter type notification_type add value if not exists 'order_update_approval';
