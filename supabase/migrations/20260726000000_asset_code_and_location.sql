-- Assets & Access — permanent asset code and current location.
--
-- Two columns, both prerequisites for the asset detail page:
--
--   asset_code  BOE-AST-000001. Database-generated, unique, immutable, and
--               assigned to every existing asset by the backfill below. It is
--               deliberately NOT derived from asset_type or any category: an
--               asset's type can be corrected by an edit, and a permanent
--               identifier that changes meaning when a field is corrected is
--               not a permanent identifier.
--
--   location    Where the asset physically is when nobody holds it ("Store
--               Room", "Design Department"). Free text for this phase — no
--               locations table, no location-transfer workflow. The employee
--               custody model in employee_assets is untouched, and
--               employee_id stays NOT NULL: when an asset has an open
--               assignment the custodian is that employee, and location is
--               what the detail page falls back to otherwise.
--
-- Numbering follows 20260673 (finance_payment_requests.request_number): always
-- overwrite on insert so a caller can never seed their own code, allow the
-- one-time null -> value assignment for the backfill, and refuse every later
-- change for every role including admin. The difference is the counter: there
-- is no year in this format, so a plain PostgreSQL SEQUENCE is the whole
-- concurrency story — nextval() never returns the same value twice, under any
-- amount of concurrency, without a lock.
--
-- Status is NOT touched. 'returned' remains an event rather than a resting
-- asset status (20260722000000 §1), and no new status value is introduced.

-- ─── 1. Columns ────────────────────────────────────────────────────────────

ALTER TABLE public.assets
  ADD COLUMN IF NOT EXISTS asset_code text,
  ADD COLUMN IF NOT EXISTS location   text;

-- ─── 2. Counter ────────────────────────────────────────────────────────────
--
-- Six digits, so the format holds 999,999 assets before it widens. lpad() does
-- not truncate, so the millionth asset gets a seven-digit code rather than a
-- collision.

CREATE SEQUENCE IF NOT EXISTS public.asset_code_seq AS bigint START WITH 1;

CREATE OR REPLACE FUNCTION public.next_asset_code()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 'BOE-AST-' || lpad(nextval('public.asset_code_seq')::text, 6, '0');
$$;

-- Reachable only through the assign-on-insert trigger and the backfill below,
-- both of which run as the function owner. No client role may mint a code.
REVOKE EXECUTE ON FUNCTION public.next_asset_code() FROM public, anon, authenticated;

-- ─── 3. Backfill, oldest first ─────────────────────────────────────────────
--
-- Runs before the assign-on-insert trigger exists, so this loop is the only
-- writer touching asset_code at this point. created_at ASC with id as a stable
-- tie-breaker means the oldest asset gets BOE-AST-000001 and re-running the
-- migration on a partially-backfilled table cannot renumber anything (the
-- WHERE clause skips rows that already have a code).

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT id FROM public.assets
     WHERE asset_code IS NULL
     ORDER BY created_at ASC, id ASC
  LOOP
    UPDATE public.assets
       SET asset_code = public.next_asset_code()
     WHERE id = r.id;
  END LOOP;
END $$;

-- ─── 4. Assign on creation ─────────────────────────────────────────────────
--
-- Unconditional assignment: an INSERT that supplies asset_code has that value
-- discarded. The code is the database's to issue.

CREATE OR REPLACE FUNCTION public.assign_asset_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  new.asset_code := public.next_asset_code();
  RETURN new;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.assign_asset_code() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS assets_assign_code ON public.assets;

CREATE TRIGGER assets_assign_code
  BEFORE INSERT ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.assign_asset_code();

-- ─── 5. Immutability ───────────────────────────────────────────────────────
--
-- Allows the one-time null -> value assignment (the backfill above) and
-- refuses every later change. A trigger, not a policy: this must bind the
-- service role and direct SQL too, not only PostgREST clients.

CREATE OR REPLACE FUNCTION public.prevent_asset_code_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF old.asset_code IS NOT NULL AND new.asset_code IS DISTINCT FROM old.asset_code THEN
    RAISE EXCEPTION
      'ASSET_CODE_IMMUTABLE: asset_code cannot be changed once assigned (% -> %)',
      old.asset_code, new.asset_code
      USING ERRCODE = '42501';
  END IF;
  RETURN new;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prevent_asset_code_change() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS assets_protect_code ON public.assets;

CREATE TRIGGER assets_protect_code
  BEFORE UPDATE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.prevent_asset_code_change();

-- ─── 6. Uniqueness and NOT NULL ────────────────────────────────────────────
--
-- The unique index is the actual guarantee against duplicates, independent of
-- whether the backfill loop and the sequence behaved as expected.

CREATE UNIQUE INDEX IF NOT EXISTS assets_asset_code_uidx
  ON public.assets (asset_code);

ALTER TABLE public.assets
  ALTER COLUMN asset_code SET NOT NULL;
