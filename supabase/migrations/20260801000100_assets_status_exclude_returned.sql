-- Assets & Access — 'returned' is not an asset-master status.
--
-- 20260728000000 introduced assets_status_known and admitted seven values,
-- 'returned' among them. That value has had no writer since 20260722000000:
-- a return closes the CUSTODY period, so employee_assets.status becomes
-- 'returned' while the asset itself goes back to 'available'. Leaving the
-- value in the CHECK meant the database still permitted a state the
-- application deliberately never produces — and one that strands an asset,
-- because Assign is only offered for 'available'.
--
-- This migration removes it. Six values remain, each with exactly one writer:
--
--   available     return_asset(), recover, restore, transfer to a location
--   assigned      assign_asset(), transfer to an employee
--   under_repair  send for service
--   lost          mark_asset_lost()
--   retired       retire_asset()
--   disposed      dispose
--
-- Nothing else changes: no policy, no function, no column, no data. The
-- accompanying app-side change removes 'returned' from the inventory's status
-- FILTER list (src/lib/assets/types.ts), which after this migration could
-- never match a row.
--
-- Scope note: this is the whole migration. No other Assets work is bundled in.

-- ─── 1. Refuse to proceed if the value is actually in use ──────────────────
--
-- assets_status_known was created NOT VALID, so existing rows were never
-- checked against it — a legacy 'returned' asset could be sitting there right
-- now. Section 3 would fail on such a row with a constraint-violation error
-- that names neither the table's meaning nor the fix, so the check happens
-- here first and says what to do about it.
--
-- The remedy is deliberately NOT automated: an asset stranded at 'returned'
-- either has an open custody row (in which case 'available' is the wrong
-- answer and someone must look) or does not (in which case 20260722000000 §1
-- already corrected it). Guessing on the operator's behalf is how audit
-- records become fiction.

DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.assets WHERE status = 'returned';

  IF v_count > 0 THEN
    RAISE EXCEPTION
      'ASSETS_STATUS_RETURNED_IN_USE: % asset(s) still rest at status = ''returned''. '
      'Resolve each one first (a returned asset with no open assignment belongs at '
      '''available''), then re-run this migration.', v_count
      USING ERRCODE = '23514';
  END IF;
END $$;

-- ─── 2. Replace the constraint ─────────────────────────────────────────────
--
-- Same name, so there is exactly one status constraint on this table and its
-- name keeps meaning "the statuses an asset may rest at". Added NOT VALID and
-- validated separately in section 3: ADD ... NOT VALID takes a brief
-- ACCESS EXCLUSIVE lock without scanning, and VALIDATE then scans under the
-- weaker SHARE UPDATE EXCLUSIVE, which does not block reads or writes.

ALTER TABLE public.assets
  DROP CONSTRAINT IF EXISTS assets_status_known;

ALTER TABLE public.assets
  ADD CONSTRAINT assets_status_known CHECK (
    status IN ('available', 'assigned', 'under_repair', 'lost', 'retired', 'disposed')
  ) NOT VALID;

-- ─── 3. Validate it against every existing row ─────────────────────────────
--
-- The step 20260728000000 skipped. After this the constraint is trusted for
-- existing rows as well as new ones, so the guarantee is about the table's
-- whole contents rather than only about future writes.

ALTER TABLE public.assets
  VALIDATE CONSTRAINT assets_status_known;
