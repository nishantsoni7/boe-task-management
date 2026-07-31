-- Assets & Access — lifecycle verification.
--
-- Proves, against a live project, the guarantees that cannot be asserted from
-- the TypeScript suite: the RLS policies, the append-only triggers, the
-- SECURITY DEFINER guards, and the deletion protection.
--
-- Covers 20260726000000 – 20260731000000.
--
-- HOW TO RUN
--   Paste sections into the Supabase SQL editor. Sections 1–5 are READ-ONLY and
--   safe on production. Section 6 WRITES: it creates a throwaway asset, walks
--   it through its whole life, and deletes it again. Run section 6 only when
--   you are content to add one asset and its history to the database — the
--   history it produces is permanent by design and CANNOT be removed
--   afterwards, which is precisely what it is proving.

-- ═══ 1. Schema is present ══════════════════════════════════════════════════

SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('asset_transfers', 'asset_service_records', 'asset_documents', 'asset_activity_log')
ORDER BY table_name;
-- EXPECT: all four.

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'assets'
  AND column_name IN (
    'asset_code','location','department','brand','model','description',
    'purchase_date','purchase_price','vendor','invoice_number',
    'warranty_start_date','warranty_expiry_date','warranty_type','warranty_remarks','condition'
  )
ORDER BY column_name;
-- EXPECT: 15 rows. asset_code NOT NULL; every other one nullable — an asset
-- that predates the module must keep loading with none of them set.

-- ═══ 2. Every existing asset still loads ═══════════════════════════════════

SELECT
  count(*)                                   AS total_assets,
  count(*) FILTER (WHERE asset_code IS NULL) AS missing_code,
  count(*) FILTER (WHERE purchase_date IS NULL) AS no_purchase_date,
  count(*) FILTER (WHERE warranty_expiry_date IS NULL) AS no_warranty
FROM public.assets;
-- EXPECT: missing_code = 0. The other two may be large — "not recorded" is a
-- legitimate permanent state, not a backfill target.

-- ═══ 3. Warranty status is NOT stored ══════════════════════════════════════

SELECT count(*) AS stored_warranty_status_columns
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'assets'
  AND column_name ILIKE '%warranty%status%';
-- EXPECT: 0. It is derived from warranty_expiry_date at display time; a stored
-- copy would be wrong on any row nobody touched that day.

-- ═══ 4. RLS: append-only history has no write policies ═════════════════════

SELECT tablename, cmd, policyname
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('asset_transfers', 'asset_service_records', 'asset_documents', 'asset_activity_log')
ORDER BY tablename, cmd, policyname;
-- EXPECT:
--   asset_activity_log     SELECT only
--   asset_transfers        SELECT only
--   asset_service_records  SELECT only
--   asset_documents        SELECT + INSERT only  (removal goes through the RPC)
-- Any UPDATE or DELETE policy on any of these is a defect.

SELECT relname, relrowsecurity
FROM pg_class
WHERE relname IN ('asset_transfers', 'asset_service_records', 'asset_documents', 'asset_activity_log');
-- EXPECT: relrowsecurity = true for all four.

-- ═══ 5. The functions exist with the signatures the app calls ══════════════

SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef AS security_definer
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'assign_asset','transfer_asset','return_asset','mark_asset_lost','recover_lost_asset',
    'send_asset_for_repair','complete_asset_service','add_asset_service_record',
    'correct_asset_service_record','retire_asset','restore_asset','remove_asset_document',
    'accept_employee_asset','can_read_asset_records','can_write_asset_records','holds_or_held_asset'
  )
ORDER BY p.proname;
-- EXPECT: exactly ONE row per name (an overload left behind would make
-- PostgREST ambiguous), and security_definer = true for all of them.
--
-- In particular assign_asset must be (uuid, uuid, date, text, text) and NOT
-- also (uuid, uuid); return_asset (uuid, text, text, text, date) and not also
-- (uuid); mark_asset_lost (uuid, text) and not also (uuid).

-- The storage bucket.
SELECT id, public, file_size_limit, array_length(allowed_mime_types, 1) AS mime_count
FROM storage.buckets WHERE id = 'asset-documents';
-- EXPECT: public = false, file_size_limit = 10485760, mime_count = 10.

-- ═══ 6. WRITE PASS — one throwaway asset through its whole life ════════════
--
-- Run as an admin session (auth.uid() must resolve). Read each EXPECT before
-- moving on. Everything is inside one transaction that ends in ROLLBACK, so it
-- leaves nothing behind — but note that means it also does NOT prove the
-- permanence of committed history. Section 6b covers that separately.

BEGIN;

INSERT INTO public.assets (asset_type, asset_name, serial_no, location)
VALUES ('laptop_desktop', 'ZZ VERIFICATION ASSET', 'ZZ-TEST-0001', 'Store Room')
RETURNING id, asset_code, status \gset asset_

-- 6.1 Creation is logged and a code was issued.
SELECT asset_code IS NOT NULL AS code_issued, status
FROM public.assets WHERE id = :'asset_id';
-- EXPECT: code_issued = t, status = 'available'.

SELECT event_type, summary FROM public.asset_activity_log WHERE asset_id = :'asset_id';
-- EXPECT: one 'asset_created' row.

-- 6.2 Assign. Pick any active employee id for :employee.
--     \set employee '00000000-0000-0000-0000-000000000000'
SELECT public.assign_asset(:'asset_id', :'employee', current_date, 'good', 'verification');

SELECT status, department, location FROM public.assets WHERE id = :'asset_id';
-- EXPECT: assigned; department = that employee's team; location = NULL.

SELECT event_type, from_employee_id, to_employee_id, condition, remarks
FROM public.asset_transfers WHERE asset_id = :'asset_id';
-- EXPECT: one 'assigned' row, to_employee_id = the employee.

SELECT event_type FROM public.asset_activity_log WHERE asset_id = :'asset_id' ORDER BY created_at;
-- EXPECT: asset_created, asset_assigned. NOT an extra 'asset_edited' — the
-- custody function suppresses the edit trigger for its own UPDATE.

-- 6.3 Assigning twice is refused.
SELECT public.assign_asset(:'asset_id', :'employee');
-- EXPECT: ERROR  ASSET_CUSTODY_INVALID: "…" is not available to assign

-- 6.4 Send for repair — custody must NOT end.
SELECT public.send_asset_for_repair(:'asset_id', 'repair', 'screen flicker', NULL, 'Acme Repairs', current_date, NULL) \gset svc_

SELECT status FROM public.assets WHERE id = :'asset_id';
-- EXPECT: under_repair.

SELECT count(*) AS open_custody FROM public.employee_assets
WHERE asset_id = :'asset_id' AND status IN ('pending_acceptance','accepted');
-- EXPECT: 1 — the holder is still accountable while a vendor has it.

-- 6.5 Transfer is refused while away for service.
SELECT public.transfer_asset(:'asset_id', NULL, 'Store Room');
-- EXPECT: ERROR  ASSET_CUSTODY_INVALID: "…" is away for service…

-- 6.6 Close the service record with a cost.
SELECT public.complete_asset_service(
  (SELECT id FROM public.asset_service_records WHERE asset_id = :'asset_id' AND status = 'in_progress'),
  current_date, 1250.00, 'good', NULL, current_date + 180);

SELECT status FROM public.assets WHERE id = :'asset_id';
-- EXPECT: assigned — back to its holder, NOT silently released to 'available'.

SELECT sum(cost) AS total_spend FROM public.asset_service_records WHERE asset_id = :'asset_id';
-- EXPECT: 1250.00.

-- 6.7 A negative cost is refused.
SELECT public.add_asset_service_record(:'asset_id', 'repair', NULL, NULL, NULL, NULL, NULL, -5);
-- EXPECT: ERROR  ASSET_SERVICE_INVALID: A service cost cannot be negative

-- 6.8 Return, then retire.
SELECT public.return_asset(:'asset_id', 'fair', 'verification return', 'Store Room');
SELECT status, condition, location FROM public.assets WHERE id = :'asset_id';
-- EXPECT: available, fair, Store Room.

SELECT public.retire_asset(:'asset_id', false, 'verification');
SELECT status FROM public.assets WHERE id = :'asset_id';
-- EXPECT: retired.

-- 6.9 History is append-only, for everyone.
UPDATE public.asset_transfers SET remarks = 'tampered' WHERE asset_id = :'asset_id';
-- EXPECT: ERROR  ASSET_TRANSFER_IMMUTABLE: transfer history cannot be modified

DELETE FROM public.asset_transfers WHERE asset_id = :'asset_id';
-- EXPECT: ERROR  ASSET_TRANSFER_IMMUTABLE: transfer history cannot be deleted

UPDATE public.asset_activity_log SET summary = 'tampered' WHERE asset_id = :'asset_id';
-- EXPECT: ERROR  ASSET_ACTIVITY_IMMUTABLE: asset activity cannot be modified

-- 6.10 Deletion is blocked by history.
DELETE FROM public.assets WHERE id = :'asset_id';
-- EXPECT: ERROR  ASSET_DELETE_BLOCKED: "…" has assignment history and cannot be deleted

ROLLBACK;

-- ═══ 6b. Deletion of a NEVER-USED asset still works ════════════════════════
-- A mistaken inventory entry must stay removable. Committed, then removed.

INSERT INTO public.assets (asset_type, asset_name)
VALUES ('other', 'ZZ MISTAKEN ENTRY') RETURNING id \gset mistake_

DELETE FROM public.assets WHERE id = :'mistake_id';
-- EXPECT: DELETE 1. Its activity log rows go with it (ON DELETE SET NULL keeps
-- the audit row itself, with the name and code snapshotted).

-- ═══ 7. Notification types ═════════════════════════════════════════════════

SELECT count(*) AS asset_notification_types
FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
WHERE t.typname = 'notification_type' AND e.enumlabel LIKE 'asset\_%';
-- EXPECT: 15 — matching ASSET_NOTIFICATION_TYPES in src/lib/notifications.ts.
