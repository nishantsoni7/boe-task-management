-- Assets & Access notifications — the events the module was missing.
--
-- 20260731000000 added fifteen `asset_*` values covering custody, service,
-- change requests and warranty expiry. The audit that produced this migration
-- found eleven more meaningful mutations that told nobody anything:
--
--   * a direct master-details edit that moves a custody-relevant field
--     (status, location, department, condition, warranty dates) — the rule for
--     which already existed as editDeservesNotification() and was never wired
--     to a call site;
--   * a service record added after the fact;
--   * retirement, disposal and restoration;
--   * warranty details added or corrected;
--   * a document (invoice, warranty card or supporting file) attached;
--   * and the ENTIRE Access Register, which had three mutations and zero
--     notifications — an employee could be granted or have revoked the
--     credentials to a company system and never be told.
--
-- Same contract as before, deliberately: values on the shared
-- `notification_type` enum, `task_id` null, and `entity_id` carrying the id of
-- the record the notification is about. For `asset_*` that is the ASSET id, and
-- the deep link is /assets-access/<id>. For `access_*` it is the ACCESS RECORD
-- id; access records have no detail route, so getNotificationMeta sends those
-- to /assets-access?view=access-register — the id is still stored so the row
-- can be traced, never so a link can be built from it.
--
-- As in 20260694000000 and 20260731000000, none of the new values are
-- REFERENCED inside this migration: Postgres cannot use an enum value in the
-- same transaction that adds it. The app-side lists in src/lib/notifications.ts
-- and src/lib/assets/assetNotifications.ts are what consume them.

-- ── Asset master details ────────────────────────────────────────────────────
-- Only edits that move a custody-relevant field reach this type; a corrected
-- serial number or a reworded description stays silent, by the same rule the
-- module already documented.
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'asset_edited';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'asset_warranty_updated';

-- ── Service ─────────────────────────────────────────────────────────────────
-- Distinct from asset_repair_sent / asset_repair_returned, which are custody
-- movements. This is the record of a service that already happened.
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'asset_service_added';

-- ── Documents ───────────────────────────────────────────────────────────────
-- One value, not three. Invoice, warranty card and supporting document differ
-- by a word in the title; three enum values would give three badges for one
-- kind of event and three more rows in every duplicate-suppression lookup.
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'asset_document_uploaded';

-- ── End of life ─────────────────────────────────────────────────────────────
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'asset_retired';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'asset_disposed';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'asset_restored';

-- ── Access Register ─────────────────────────────────────────────────────────
-- The affected employee is the recipient in all four cases. Being granted or
-- losing access to a company system is the clearest possible example of an
-- event the person it happens to must be told about.
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'access_granted';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'access_updated';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'access_revoked';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'access_restored';

-- No new index: notifications_user_type_created_idx (20260731000000) already
-- covers the (user_id, type, created_at) lookup every notify route performs,
-- and these are additional VALUES on the column it already indexes, not a new
-- access path.
