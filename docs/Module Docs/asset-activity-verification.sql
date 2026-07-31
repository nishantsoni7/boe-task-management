-- ============================================================================
-- Assets & Access — asset code + activity log verification
-- (20260726000000, 20260727000000)
-- ============================================================================
-- The database half of Task 2. Node tests cover presentation
-- (src/lib/assets/activity.test.ts, src/lib/assets/detail.test.ts); everything
-- below needs a real database because it is about sequences, triggers,
-- SECURITY DEFINER behaviour and RLS.
--
-- WRITES DATA. Everything happens inside a transaction that ends in ROLLBACK,
-- so no row survives — but read section 0 first and do not run it against
-- production while someone is mid-acceptance.
--
-- Run: npx supabase db query --linked -f "docs/Module Docs/asset-activity-verification.sql"
--
-- Expected: every line printed at the end reads PASS. Any FAIL, or any error
-- other than the deliberately-caught ones, means a migration is not doing its
-- job.
-- ============================================================================

BEGIN;

-- ─── 0. Fixtures ────────────────────────────────────────────────────────────
-- Three real users are needed. Replace the ids below with real public.users
-- ids before running — they are not guessable and this script deliberately
-- does not invent users.
--
--   admin  an active user with users.role = 'admin' (custody RPCs and the
--          request-review RPCs are exercised as this user)
--   a      any active non-admin employee (the custodian)
--
-- Same mechanism as assets-custody-integrity-verification.sql: ids live in a
-- temp table read through pg_temp.who(), because `supabase db query` posts the
-- file to an HTTP endpoint and a psql backslash command would be a syntax
-- error on line 1.

CREATE TEMP TABLE who_ids (label text primary key, id uuid);
INSERT INTO who_ids VALUES
  ('admin', '00000000-0000-0000-0000-000000000000'),   -- ← replace: an admin
  ('a',     '973b4337-9cae-4f66-8e7f-b158326cdc10');   -- ← replace: Aditya

CREATE OR REPLACE FUNCTION pg_temp.who(p_label text) RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT id FROM who_ids WHERE label = p_label $$;

CREATE TEMP TABLE t_ids (label text primary key, id uuid);

-- Assertions accumulate here: the CLI returns only the LAST statement's rows.
CREATE TEMP TABLE results (at timestamptz DEFAULT clock_timestamp(), line text);
GRANT ALL ON results TO authenticated;
GRANT ALL ON t_ids  TO authenticated;
GRANT SELECT ON who_ids TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.who(text) TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = pg_temp.who('admin') AND role = 'admin' AND is_active) THEN
    RAISE EXCEPTION 'Fixture error: who(''admin'') is not an active admin. Edit section 0.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = pg_temp.who('a') AND is_active) THEN
    RAISE EXCEPTION 'Fixture error: who(''a'') is not an active user. Edit section 0.';
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- PART A — asset_code (20260726000000)
-- ════════════════════════════════════════════════════════════════════════════

-- ─── A1. Every existing asset has a unique, well-formed code ────────────────

INSERT INTO results(line)
SELECT CASE WHEN count(*) FILTER (WHERE asset_code IS NULL) = 0
            THEN 'PASS — every existing asset has a code (' || count(*) || ' assets)'
            ELSE 'FAIL — ' || count(*) FILTER (WHERE asset_code IS NULL) || ' assets have no code' END
FROM public.assets;

INSERT INTO results(line)
SELECT CASE WHEN count(*) = 0
            THEN 'PASS — every asset code matches BOE-AST-NNNNNN'
            ELSE 'FAIL — ' || count(*) || ' codes are malformed' END
FROM public.assets WHERE asset_code !~ '^BOE-AST-[0-9]{6,}$';

INSERT INTO results(line)
SELECT CASE WHEN count(*) = count(DISTINCT asset_code)
            THEN 'PASS — all asset codes are distinct'
            ELSE 'FAIL — duplicate asset codes exist' END
FROM public.assets;

-- ─── A2. A new asset receives the next code, automatically ──────────────────

WITH ins AS (
  INSERT INTO public.assets (asset_type, asset_name, status, location)
  VALUES ('other', 'ZZ activity check — subject', 'available', 'Store Room')
  RETURNING id
)
INSERT INTO t_ids SELECT 'asset', id FROM ins;

INSERT INTO results(line)
SELECT CASE WHEN asset_code ~ '^BOE-AST-[0-9]{6,}$'
            THEN 'PASS — a new asset was issued ' || asset_code
            ELSE 'FAIL — new asset code is ' || coalesce(asset_code, 'NULL') END
FROM public.assets WHERE id = (SELECT id FROM t_ids WHERE label = 'asset');

-- ─── A3. Codes cannot collide, and a supplied code is discarded ─────────────
-- True concurrency cannot be staged inside one transaction; it does not need
-- to be. The generator is nextval() on a sequence, which never returns the
-- same value twice regardless of concurrency or rollback — this asserts the
-- generator IS that sequence, and that consecutive inserts differ.

INSERT INTO results(line)
SELECT CASE WHEN count(*) = 1
            THEN 'PASS — asset codes come from a sequence (concurrency-safe by construction)'
            ELSE 'FAIL — public.asset_code_seq does not exist' END
FROM pg_class WHERE relname = 'asset_code_seq' AND relkind = 'S';

WITH ins AS (
  -- A caller supplying their own code: the BEFORE INSERT trigger overwrites it.
  INSERT INTO public.assets (asset_type, asset_name, status, asset_code)
  VALUES ('other', 'ZZ activity check — second', 'available', 'BOE-AST-999999')
  RETURNING id
)
INSERT INTO t_ids SELECT 'asset2', id FROM ins;

INSERT INTO results(line)
SELECT CASE WHEN a2.asset_code <> a1.asset_code AND a2.asset_code <> 'BOE-AST-999999'
            THEN 'PASS — a client-supplied code is discarded and the next value issued'
            ELSE 'FAIL — client-supplied code survived, or codes collided' END
FROM public.assets a1, public.assets a2
WHERE a1.id = (SELECT id FROM t_ids WHERE label = 'asset')
  AND a2.id = (SELECT id FROM t_ids WHERE label = 'asset2');

-- ─── A4. asset_code is immutable, even for the owner ────────────────────────

DO $$
BEGIN
  UPDATE public.assets SET asset_code = 'BOE-AST-000999'
   WHERE id = (SELECT id FROM t_ids WHERE label = 'asset');
  INSERT INTO results(line) VALUES ('FAIL — asset_code was changed');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO results(line) VALUES ('PASS — asset_code change refused (owner, RLS bypassed)');
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- PART B — activity is written by the actions that matter
-- ════════════════════════════════════════════════════════════════════════════

-- ─── B1. Creation logged ────────────────────────────────────────────────────

INSERT INTO results(line)
SELECT CASE WHEN count(*) = 1
            THEN 'PASS — asset_created logged on insert'
            ELSE 'FAIL — expected 1 asset_created row, found ' || count(*) END
FROM public.asset_activity_log
WHERE asset_id = (SELECT id FROM t_ids WHERE label = 'asset') AND event_type = 'asset_created';

INSERT INTO results(line)
SELECT CASE WHEN details->>'location' = 'Store Room' AND details->>'asset_code' = a.asset_code
            THEN 'PASS — asset_created captured the code and initial location'
            ELSE 'FAIL — asset_created details are incomplete: ' || coalesce(details::text, 'NULL') END
FROM public.asset_activity_log l
JOIN public.assets a ON a.id = l.asset_id
WHERE l.asset_id = (SELECT id FROM t_ids WHERE label = 'asset') AND l.event_type = 'asset_created';

-- ─── B2. A direct edit logs only the fields that changed ────────────────────

UPDATE public.assets
   SET asset_name = 'ZZ activity check — renamed',
       location   = 'Design Department'
 WHERE id = (SELECT id FROM t_ids WHERE label = 'asset');

INSERT INTO results(line)
SELECT CASE WHEN jsonb_array_length(details->'changes') = 2
             AND (details->'changes') @> '[{"field":"asset_name"}]'::jsonb
             AND (details->'changes') @> '[{"field":"location"}]'::jsonb
            THEN 'PASS — asset_edited logged exactly the two changed fields'
            ELSE 'FAIL — asset_edited change set is wrong: ' || coalesce(details->>'changes', 'NULL') END
FROM public.asset_activity_log
WHERE asset_id = (SELECT id FROM t_ids WHERE label = 'asset') AND event_type = 'asset_edited';

-- ─── B3. A no-op save logs nothing ──────────────────────────────────────────

CREATE TEMP TABLE t_counts AS
SELECT count(*) AS before FROM public.asset_activity_log
WHERE asset_id = (SELECT id FROM t_ids WHERE label = 'asset');

UPDATE public.assets
   SET asset_name = asset_name,
       location   = location,
       serial_no  = serial_no
 WHERE id = (SELECT id FROM t_ids WHERE label = 'asset');

INSERT INTO results(line)
SELECT CASE WHEN count(*) = (SELECT before FROM t_counts)
            THEN 'PASS — a save that changed nothing wrote no activity'
            ELSE 'FAIL — a no-op edit created ' || (count(*) - (SELECT before FROM t_counts)) || ' rows' END
FROM public.asset_activity_log
WHERE asset_id = (SELECT id FROM t_ids WHERE label = 'asset');

-- ─── B4. A status change does not masquerade as an edit ─────────────────────
-- Custody events describe status; asset_edited must not repeat them.

INSERT INTO results(line)
SELECT CASE WHEN count(*) = 0
            THEN 'PASS — no asset_edited row mentions status'
            ELSE 'FAIL — status changes are being logged as edits' END
FROM public.asset_activity_log
WHERE event_type = 'asset_edited' AND details->'changes' @> '[{"field":"status"}]'::jsonb;

-- ─── B5. Custody: assign → accept → return, each logged once ────────────────

SET LOCAL role TO authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.who('admin'))::text, true);

SELECT public.assign_asset(
  (SELECT id FROM t_ids WHERE label = 'asset'),
  pg_temp.who('a')
);

INSERT INTO results(line)
SELECT CASE WHEN count(*) = 1
             AND max(actor_id::text)    = pg_temp.who('admin')::text
             AND max(employee_id::text) = pg_temp.who('a')::text
             AND max(details->>'new_status') = 'assigned'
            THEN 'PASS — asset_assigned logged with actor, employee and status movement'
            ELSE 'FAIL — asset_assigned row is wrong or missing' END
FROM public.asset_activity_log
WHERE asset_id = (SELECT id FROM t_ids WHERE label = 'asset') AND event_type = 'asset_assigned';

-- Acceptance, as the custodian.
SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.who('a'))::text, true);

SELECT public.accept_employee_asset(
  (SELECT id FROM public.employee_assets
    WHERE asset_id = (SELECT id FROM t_ids WHERE label = 'asset')
      AND status = 'pending_acceptance')
);

INSERT INTO results(line)
SELECT CASE WHEN count(*) = 1 AND max(actor_id::text) = pg_temp.who('a')::text
            THEN 'PASS — assignment_accepted logged, actor is the accepting employee'
            ELSE 'FAIL — assignment_accepted row is wrong or missing' END
FROM public.asset_activity_log
WHERE asset_id = (SELECT id FROM t_ids WHERE label = 'asset') AND event_type = 'assignment_accepted';

-- ─── B6. A refused custody action leaves no trace ───────────────────────────
-- The asset is already assigned, so this must raise — and must not log.

SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.who('admin'))::text, true);

DO $$
BEGIN
  PERFORM public.assign_asset(
    (SELECT id FROM t_ids WHERE label = 'asset'),
    pg_temp.who('a')
  );
  INSERT INTO results(line) VALUES ('FAIL — an already-assigned asset was assigned again');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO results(line) VALUES ('PASS — second assignment refused');
END $$;

INSERT INTO results(line)
SELECT CASE WHEN count(*) = 1
            THEN 'PASS — the refused assignment wrote no activity'
            ELSE 'FAIL — a failed action logged ' || count(*) || ' asset_assigned rows' END
FROM public.asset_activity_log
WHERE asset_id = (SELECT id FROM t_ids WHERE label = 'asset') AND event_type = 'asset_assigned';

-- ─── B7. Return, then mark lost ─────────────────────────────────────────────

SELECT public.return_asset((SELECT id FROM t_ids WHERE label = 'asset'));

INSERT INTO results(line)
SELECT CASE WHEN count(*) = 1
             AND max(employee_id::text) = pg_temp.who('a')::text
             AND max(details->>'new_status') = 'available'
            THEN 'PASS — asset_returned names the previous custodian and lands on available'
            ELSE 'FAIL — asset_returned row is wrong or missing' END
FROM public.asset_activity_log
WHERE asset_id = (SELECT id FROM t_ids WHERE label = 'asset') AND event_type = 'asset_returned';

INSERT INTO results(line)
SELECT CASE WHEN status = 'available'
            THEN 'PASS — a returned asset rests at available, never at returned'
            ELSE 'FAIL — asset status after return is ' || status END
FROM public.assets WHERE id = (SELECT id FROM t_ids WHERE label = 'asset');

SELECT public.mark_asset_lost((SELECT id FROM t_ids WHERE label = 'asset'));

INSERT INTO results(line)
SELECT CASE WHEN count(*) = 1 AND max(details->>'new_status') = 'lost'
            THEN 'PASS — asset_marked_lost logged'
            ELSE 'FAIL — asset_marked_lost row is wrong or missing' END
FROM public.asset_activity_log
WHERE asset_id = (SELECT id FROM t_ids WHERE label = 'asset') AND event_type = 'asset_marked_lost';

-- ─── B8. Ordering ───────────────────────────────────────────────────────────
-- created_at is clock_timestamp(), so rows written in one transaction still
-- order correctly. event_at alone cannot do this — it is now().

INSERT INTO results(line)
SELECT CASE WHEN count(*) = count(DISTINCT created_at)
            THEN 'PASS — every activity row has a distinct created_at to order by'
            ELSE 'FAIL — created_at collides, ordering is ambiguous' END
FROM public.asset_activity_log
WHERE asset_id = (SELECT id FROM t_ids WHERE label = 'asset');

-- ════════════════════════════════════════════════════════════════════════════
-- PART C — the log cannot be written, rewritten or erased by a client
-- ════════════════════════════════════════════════════════════════════════════
-- Still impersonating an ADMIN: if the strongest client role is refused,
-- everyone is.

INSERT INTO results(line)
SELECT CASE WHEN count(*) = 0
            THEN 'PASS — no INSERT/UPDATE/DELETE policy exists on asset_activity_log'
            ELSE 'FAIL — a write policy exists: ' || string_agg(policyname || ' (' || cmd || ')', ', ') END
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'asset_activity_log' AND cmd <> 'SELECT';

DO $$
BEGIN
  INSERT INTO public.asset_activity_log (asset_id, asset_code_snapshot, asset_name_snapshot, event_type, summary)
  VALUES ((SELECT id FROM t_ids WHERE label = 'asset'), 'BOE-AST-000000', 'forged', 'asset_created', 'forged');
  INSERT INTO results(line) VALUES ('FAIL — a client inserted activity directly');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO results(line) VALUES ('PASS — direct client INSERT refused by RLS');
END $$;

-- UPDATE and DELETE have no policy, so RLS filters them to zero rows rather
-- than erroring. Both are checked by effect.
WITH attempted AS (
  UPDATE public.asset_activity_log SET summary = 'rewritten'
   WHERE asset_id = (SELECT id FROM t_ids WHERE label = 'asset')
  RETURNING 1
)
INSERT INTO results(line)
SELECT CASE WHEN count(*) = 0
            THEN 'PASS — direct client UPDATE affects no rows'
            ELSE 'FAIL — a client rewrote ' || count(*) || ' activity rows' END
FROM attempted;

WITH attempted AS (
  DELETE FROM public.asset_activity_log
   WHERE asset_id = (SELECT id FROM t_ids WHERE label = 'asset')
  RETURNING 1
)
INSERT INTO results(line)
SELECT CASE WHEN count(*) = 0
            THEN 'PASS — direct client DELETE affects no rows'
            ELSE 'FAIL — a client deleted ' || count(*) || ' activity rows' END
FROM attempted;

-- ─── C2. An unauthorized reader sees nothing ────────────────────────────────
-- A signed-in identity with no users row at all: the SELECT policy's EXISTS
-- fails, so the timeline is empty rather than merely unlinked.

SELECT set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid())::text, true);

INSERT INTO results(line)
SELECT CASE WHEN count(*) = 0
            THEN 'PASS — a user without assets_access.view reads no activity'
            ELSE 'FAIL — an unauthorized reader saw ' || count(*) || ' rows' END
FROM public.asset_activity_log;

RESET role;

-- ─── C3. The append-only trigger binds the owner too ────────────────────────
-- RLS does not apply to the table owner, so this is what stops a service-role
-- or psql rewrite.

DO $$
BEGIN
  UPDATE public.asset_activity_log SET summary = 'rewritten by the owner'
   WHERE asset_id = (SELECT id FROM t_ids WHERE label = 'asset');
  INSERT INTO results(line) VALUES ('FAIL — the owner rewrote history');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO results(line) VALUES ('PASS — owner UPDATE refused by the append-only trigger');
END $$;

DO $$
BEGIN
  DELETE FROM public.asset_activity_log
   WHERE asset_id = (SELECT id FROM t_ids WHERE label = 'asset');
  INSERT INTO results(line) VALUES ('FAIL — the owner deleted history');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO results(line) VALUES ('PASS — owner DELETE refused by the append-only trigger');
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- PART D — change requests
-- ════════════════════════════════════════════════════════════════════════════

-- ─── D1. Submission is logged ───────────────────────────────────────────────

WITH ins AS (
  INSERT INTO public.asset_change_requests
    (asset_id, asset_name_snapshot, request_type, requested_by, reason, proposed_asset_name)
  VALUES (
    (SELECT id FROM t_ids WHERE label = 'asset2'),
    'ZZ activity check — second',
    'edit',
    pg_temp.who('a'),
    'The name is wrong',
    'ZZ activity check — corrected'
  )
  RETURNING id
)
INSERT INTO t_ids SELECT 'request_edit', id FROM ins;

INSERT INTO results(line)
SELECT CASE WHEN count(*) = 1 AND max(details->>'reason') = 'The name is wrong'
            THEN 'PASS — edit_requested logged with the requester''s reason'
            ELSE 'FAIL — edit_requested row is wrong or missing' END
FROM public.asset_activity_log
WHERE asset_id = (SELECT id FROM t_ids WHERE label = 'asset2') AND event_type = 'edit_requested';

-- ─── D2. Approval logs the decision AND the resulting edit ──────────────────

SET LOCAL role TO authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.who('admin'))::text, true);

SELECT public.approve_asset_change_request((SELECT id FROM t_ids WHERE label = 'request_edit'), 'Confirmed');

INSERT INTO results(line)
SELECT CASE WHEN count(*) FILTER (WHERE event_type = 'edit_request_approved') = 1
             AND count(*) FILTER (WHERE event_type = 'asset_edited') = 1
            THEN 'PASS — approval logged the decision and the field difference, one transaction'
            ELSE 'FAIL — approval produced ' || count(*) || ' rows: '
                 || coalesce(string_agg(event_type, ', '), 'none') END
FROM public.asset_activity_log
WHERE asset_id = (SELECT id FROM t_ids WHERE label = 'asset2')
  AND event_type IN ('edit_request_approved', 'asset_edited');

INSERT INTO results(line)
SELECT CASE WHEN source_type = 'asset_change_request'
             AND source_id = (SELECT id FROM t_ids WHERE label = 'request_edit')
            THEN 'PASS — the asset_edited row points back at the request that caused it'
            ELSE 'FAIL — source is ' || coalesce(source_type, 'NULL') END
FROM public.asset_activity_log
WHERE asset_id = (SELECT id FROM t_ids WHERE label = 'asset2') AND event_type = 'asset_edited';

INSERT INTO results(line)
SELECT CASE WHEN asset_name = 'ZZ activity check — corrected'
            THEN 'PASS — the approved change actually landed on the asset'
            ELSE 'FAIL — asset name is ' || asset_name END
FROM public.assets WHERE id = (SELECT id FROM t_ids WHERE label = 'asset2');

-- The transaction-local source must not leak onto the next edit.
RESET role;

UPDATE public.assets SET serial_no = 'SN-LATER'
 WHERE id = (SELECT id FROM t_ids WHERE label = 'asset2');

INSERT INTO results(line)
SELECT CASE WHEN count(*) FILTER (WHERE source_type IS NOT NULL) = 1
            THEN 'PASS — the request source did not leak onto a later, unrelated edit'
            ELSE 'FAIL — ' || count(*) FILTER (WHERE source_type IS NOT NULL) || ' edits claim a source' END
FROM public.asset_activity_log
WHERE asset_id = (SELECT id FROM t_ids WHERE label = 'asset2') AND event_type = 'asset_edited';

-- ─── D3. Rejection is logged and changes nothing ────────────────────────────

WITH ins AS (
  INSERT INTO public.asset_change_requests
    (asset_id, asset_name_snapshot, request_type, requested_by, reason)
  VALUES (
    (SELECT id FROM t_ids WHERE label = 'asset2'),
    'ZZ activity check — corrected',
    'remove',
    pg_temp.who('a'),
    'Duplicate entry'
  )
  RETURNING id
)
INSERT INTO t_ids SELECT 'request_remove', id FROM ins;

CREATE TEMP TABLE t_before AS
SELECT asset_name, serial_no, status FROM public.assets
WHERE id = (SELECT id FROM t_ids WHERE label = 'asset2');

SET LOCAL role TO authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.who('admin'))::text, true);

SELECT public.reject_asset_change_request((SELECT id FROM t_ids WHERE label = 'request_remove'), 'Not a duplicate');

INSERT INTO results(line)
SELECT CASE WHEN count(*) = 1 AND max(details->>'review_note') = 'Not a duplicate'
            THEN 'PASS — removal_request_rejected logged with the review note'
            ELSE 'FAIL — removal_request_rejected row is wrong or missing' END
FROM public.asset_activity_log
WHERE asset_id = (SELECT id FROM t_ids WHERE label = 'asset2') AND event_type = 'removal_request_rejected';

INSERT INTO results(line)
SELECT CASE WHEN a.asset_name = b.asset_name AND a.serial_no IS NOT DISTINCT FROM b.serial_no AND a.status = b.status
            THEN 'PASS — a rejected request left the asset untouched'
            ELSE 'FAIL — the asset changed during a rejection' END
FROM public.assets a, t_before b
WHERE a.id = (SELECT id FROM t_ids WHERE label = 'asset2');

RESET role;

-- ─── D4. History survives an approved removal ───────────────────────────────
-- The third asset is never assigned to anybody, which is the only kind that
-- may be removed at all (20260722000000 §3). Its history must outlive it.

WITH ins AS (
  INSERT INTO public.assets (asset_type, asset_name, status)
  VALUES ('other', 'ZZ activity check — removable', 'available')
  RETURNING id
)
INSERT INTO t_ids SELECT 'asset3', id FROM ins;

WITH ins AS (
  INSERT INTO public.asset_change_requests
    (asset_id, asset_name_snapshot, request_type, requested_by, reason)
  VALUES (
    (SELECT id FROM t_ids WHERE label = 'asset3'),
    'ZZ activity check — removable',
    'remove',
    pg_temp.who('a'),
    'Entered by mistake'
  )
  RETURNING id
)
INSERT INTO t_ids SELECT 'request_remove_ok', id FROM ins;

CREATE TEMP TABLE t_history AS
SELECT count(*) AS rows FROM public.asset_activity_log
WHERE asset_id = (SELECT id FROM t_ids WHERE label = 'asset3');

SET LOCAL role TO authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.who('admin'))::text, true);

SELECT public.approve_asset_change_request((SELECT id FROM t_ids WHERE label = 'request_remove_ok'), NULL);

RESET role;

INSERT INTO results(line)
SELECT CASE WHEN count(*) = 0
            THEN 'PASS — the approved removal deleted the asset'
            ELSE 'FAIL — the asset still exists' END
FROM public.assets WHERE id = (SELECT id FROM t_ids WHERE label = 'asset3');

INSERT INTO results(line)
SELECT CASE WHEN count(*) >= (SELECT rows FROM t_history) + 1
            THEN 'PASS — every activity row survived the deletion (' || count(*) || ' rows kept)'
            ELSE 'FAIL — activity was destroyed with the asset' END
FROM public.asset_activity_log
WHERE asset_name_snapshot = 'ZZ activity check — removable';

INSERT INTO results(line)
SELECT CASE WHEN count(*) FILTER (WHERE asset_id IS NOT NULL) = 0
             AND count(*) FILTER (WHERE asset_code_snapshot ~ '^BOE-AST-') = count(*)
            THEN 'PASS — orphaned rows keep the code and name snapshots and drop only the pointer'
            ELSE 'FAIL — orphaned activity is unreadable or still linked' END
FROM public.asset_activity_log
WHERE asset_name_snapshot = 'ZZ activity check — removable';

-- ─── D5. Deletion protection is unchanged ───────────────────────────────────
-- An asset that has ever been assigned still cannot be removed. This is the
-- guarantee the nullable asset_id FK must not have weakened.

DO $$
BEGIN
  DELETE FROM public.assets WHERE id = (SELECT id FROM t_ids WHERE label = 'asset');
  INSERT INTO results(line) VALUES ('FAIL — an asset with custody history was deleted');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO results(line) VALUES ('PASS — custody history still blocks deletion');
END $$;

-- ─── Results ────────────────────────────────────────────────────────────────

SELECT line FROM results ORDER BY at;

ROLLBACK;
