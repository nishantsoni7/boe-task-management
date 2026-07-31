-- Assets & Access notifications — stable enum types for the shared feed.
--
-- Assets reuses the shared `notifications` table exactly as Finance and Orders
-- do (20260694000000): dedicated `asset_*` enum values drive the badge and the
-- deep link, `entity_id` carries the ASSET id, and `task_id` stays null. No
-- second notification architecture is introduced — Sample Tracking's separate
-- sample_notifications table exists for per-recipient state a shared row cannot
-- express, and this module has none.
--
-- As in 20260694000000 the new values are NOT referenced anywhere inside this
-- migration: Postgres cannot use an enum value in the same transaction that
-- adds it. The app-side lists in src/lib/notifications.ts are what consume them.

-- ── Change requests: an asset request, and an edit request specifically ─────
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'asset_request_submitted';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'asset_request_approved';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'asset_request_rejected';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'asset_edit_request_submitted';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'asset_edit_request_approved';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'asset_edit_request_rejected';

-- ── Custody ────────────────────────────────────────────────────────────────
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'asset_assigned';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'asset_transferred';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'asset_transfer_acknowledged';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'asset_returned';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'asset_lost';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'asset_recovered';

-- ── Service ────────────────────────────────────────────────────────────────
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'asset_repair_sent';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'asset_repair_returned';

-- ── Warranty ───────────────────────────────────────────────────────────────
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'asset_warranty_expiring';

-- The duplicate-suppression window in every /api/*/notify route looks up
-- (user_id, type, created_at) and then narrows by entity_id. Assets adds
-- fifteen more types to that table, so the lookup is worth an index rather
-- than a scan per notification written.
CREATE INDEX IF NOT EXISTS notifications_user_type_created_idx
  ON public.notifications (user_id, type, created_at DESC);
