-- ============================================================================
-- Assets & Access — custody integrity verification (20260722000000)
-- ============================================================================
-- The database half of the three integrity fixes. Node tests cover the UI
-- rules (src/lib/assets/lifecycle.test.ts); these cases need a real database
-- because they are about RLS, SECURITY DEFINER behaviour and triggers.
--
-- WRITES DATA. Everything happens inside a transaction that ends in ROLLBACK,
-- so no row survives — but do not run it against production while someone is
-- mid-acceptance, and read section 0 first.
--
-- Run: npx supabase db query --linked -f "docs/Module Docs/assets-custody-integrity-verification.sql"
--
-- Expected: every SELECT below prints PASS. Any FAIL, or any error other than
-- the two deliberately-caught ones, means the migration is not doing its job.
-- ============================================================================

BEGIN;

-- ─── 0. Fixtures ────────────────────────────────────────────────────────────
-- Two real users are needed (acceptance is auth.uid()-bound). Replace these
-- two ids with real public.users ids before running — they are not guessable
-- and this script deliberately does not invent users.
--
-- The ids live in a table read through pg_temp.who(), NOT in psql \set
-- variables: `supabase db query` posts this file to an HTTP endpoint instead
-- of piping it through psql, so a backslash meta-command is a syntax error on
-- the first line and the script never runs at all.

CREATE TEMP TABLE who_ids (label text primary key, id uuid);
INSERT INTO who_ids VALUES
  ('a', '973b4337-9cae-4f66-8e7f-b158326cdc10'),   -- Aditya
  ('b', 'fcf8bbf9-0cc4-4a6e-ba64-1143b14ef4a2');   -- Jasvi

CREATE OR REPLACE FUNCTION pg_temp.who(p_label text) RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT id FROM who_ids WHERE label = p_label $$;

CREATE TEMP TABLE t_ids (label text primary key, id uuid);

-- Assertions accumulate here: the CLI returns only the LAST statement's rows,
-- so a script printing each check inline would report nothing at all.
CREATE TEMP TABLE results (at timestamptz DEFAULT clock_timestamp(), line text);
GRANT ALL ON results TO authenticated;

-- The script drops to the `authenticated` role to impersonate employees, and
-- that role cannot touch a temp table created by the owner without this.
GRANT ALL ON t_ids TO authenticated;
GRANT SELECT ON who_ids TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.who(text) TO authenticated;

-- A data-modifying statement cannot sit in a plain subquery — it has to be a
-- CTE. (This is what the first real run of this script caught.)

WITH ins AS (
  INSERT INTO public.assets (asset_type, asset_name, status)
  VALUES ('other', 'ZZ integrity check — with history', 'available')
  RETURNING id
)
INSERT INTO t_ids SELECT 'asset_history', id FROM ins;

WITH ins AS (
  INSERT INTO public.assets (asset_type, asset_name, status)
  VALUES ('other', 'ZZ integrity check — never assigned', 'available')
  RETURNING id
)
INSERT INTO t_ids SELECT 'asset_clean', id FROM ins;

WITH ins AS (
  INSERT INTO public.employee_assets (asset_id, employee_id, assigned_by, status)
  VALUES (
    (SELECT id FROM t_ids WHERE label = 'asset_history'),
    pg_temp.who('a'),
    pg_temp.who('a'),
    'pending_acceptance'
  )
  RETURNING id
)
INSERT INTO t_ids SELECT 'assignment_a', id FROM ins;

-- ─── 1. accept_employee_asset: the happy path ───────────────────────────────
-- Impersonate employee A the way PostgREST does: role + the JWT claim
-- auth.uid() reads.

SET LOCAL role TO authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.who('a'))::text, true);

SELECT public.accept_employee_asset((SELECT id FROM t_ids WHERE label = 'assignment_a'));

INSERT INTO results(line) SELECT CASE WHEN status = 'accepted' AND accepted_at IS NOT NULL
            THEN 'PASS — employee accepted their own pending assignment'
            ELSE 'FAIL — acceptance did not land: status=' || status END
FROM public.employee_assets WHERE id = (SELECT id FROM t_ids WHERE label = 'assignment_a');

-- ─── 2. Protected fields are untouched by acceptance ────────────────────────
-- The RPC writes status and accepted_at only; everything else must still hold
-- the values written at assignment time.

INSERT INTO results(line) SELECT CASE WHEN ea.asset_id    = (SELECT id FROM t_ids WHERE label = 'asset_history')
             AND ea.employee_id = pg_temp.who('a')
             AND ea.assigned_by = pg_temp.who('a')
             AND ea.returned_at IS NULL
             AND ea.lost_at     IS NULL
            THEN 'PASS — asset_id/employee_id/assigned_by/returned_at/lost_at unchanged'
            ELSE 'FAIL — acceptance mutated a protected field' END
FROM public.employee_assets ea WHERE ea.id = (SELECT id FROM t_ids WHERE label = 'assignment_a');

-- ─── 3. Repeated acceptance does not mutate the record ──────────────────────
-- Expect ASSET_ACCEPT_INVALID, and accepted_at must not move.

CREATE TEMP TABLE t_accepted_at AS
SELECT accepted_at FROM public.employee_assets
WHERE id = (SELECT id FROM t_ids WHERE label = 'assignment_a');

DO $$
BEGIN
  PERFORM public.accept_employee_asset((SELECT id FROM t_ids WHERE label = 'assignment_a'));
  INSERT INTO results(line) VALUES ('FAIL — a second acceptance was allowed');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO results(line) VALUES ('PASS — second acceptance refused');
END $$;

INSERT INTO results(line) SELECT CASE WHEN ea.accepted_at = (SELECT accepted_at FROM t_accepted_at)
            THEN 'PASS — accepted_at did not move on the repeat attempt'
            ELSE 'FAIL — accepted_at was rewritten' END
FROM public.employee_assets ea WHERE ea.id = (SELECT id FROM t_ids WHERE label = 'assignment_a');

-- ─── 4. An employee cannot accept someone else's assignment ─────────────────
-- Employee B attempts A's assignment. Expect ASSET_ACCEPT_DENIED — the same
-- message a nonexistent id produces, so ids cannot be probed.

-- Fixture, not a test: employee A holds no 'manage', so this insert has to
-- happen as the owner. Section 1 already dropped to `authenticated`, so step
-- back out for the write and return afterwards.
RESET role;

WITH ins AS (
  INSERT INTO public.employee_assets (asset_id, employee_id, assigned_by, status)
  VALUES (
    (SELECT id FROM t_ids WHERE label = 'asset_clean'),
    pg_temp.who('a'),
    pg_temp.who('a'),
    'pending_acceptance'
  )
  RETURNING id
)
INSERT INTO t_ids SELECT 'assignment_b_target', id FROM ins;

SET LOCAL role TO authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.who('b'))::text, true);

DO $$
BEGIN
  PERFORM public.accept_employee_asset((SELECT id FROM t_ids WHERE label = 'assignment_b_target'));
  INSERT INTO results(line) VALUES ('FAIL — employee B accepted an assignment belonging to employee A');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO results(line) VALUES ('PASS — cross-employee acceptance refused');
END $$;

INSERT INTO results(line) SELECT CASE WHEN status = 'pending_acceptance' AND accepted_at IS NULL
            THEN 'PASS — the other employee''s row is untouched'
            ELSE 'FAIL — a foreign acceptance changed the row' END
FROM public.employee_assets WHERE id = (SELECT id FROM t_ids WHERE label = 'assignment_b_target');

-- ─── 5. Employees hold no direct UPDATE on employee_assets ──────────────────
-- The old employee_assets_own_accept policy is gone, so a hand-rolled UPDATE
-- must affect zero rows (PostgREST filters it out rather than erroring).

SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.who('a'))::text, true);

WITH attempted AS (
  UPDATE public.employee_assets
     SET accepted_at = now() - interval '30 days'
   WHERE id = (SELECT id FROM t_ids WHERE label = 'assignment_a')
  RETURNING 1
)
INSERT INTO results(line) SELECT CASE WHEN count(*) = 0
            THEN 'PASS — direct UPDATE by the owning employee affects no rows'
            ELSE 'FAIL — employee can still backdate acceptance directly' END
FROM attempted;

INSERT INTO results(line) SELECT CASE WHEN count(*) = 0
            THEN 'PASS — no UPDATE policy remains for employees'
            ELSE 'FAIL — an employee UPDATE policy is still present: ' || string_agg(policyname, ', ') END
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'employee_assets'
  AND cmd = 'UPDATE' AND policyname = 'employee_assets_own_accept';

RESET role;

-- ─── 6. Delete protection: history is permanent ─────────────────────────────
-- Runs as the migration owner, i.e. with RLS out of the picture, so this
-- proves the TRIGGER blocks it rather than a policy.

DO $$
BEGIN
  DELETE FROM public.assets WHERE id = (SELECT id FROM t_ids WHERE label = 'asset_history');
  INSERT INTO results(line) VALUES ('FAIL — an asset with assignment history was deleted');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO results(line) VALUES ('PASS — delete blocked for an asset with history');
END $$;

-- Still blocked after the custody period closes — a returned asset keeps its
-- record. This is the case the old UI guard missed entirely.

UPDATE public.employee_assets
   SET status = 'returned', returned_at = now()
 WHERE id = (SELECT id FROM t_ids WHERE label = 'assignment_a');

UPDATE public.assets SET status = 'available'
 WHERE id = (SELECT id FROM t_ids WHERE label = 'asset_history');

DO $$
BEGIN
  DELETE FROM public.assets WHERE id = (SELECT id FROM t_ids WHERE label = 'asset_history');
  INSERT INTO results(line) VALUES ('FAIL — a returned asset lost its custody history to a delete');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO results(line) VALUES ('PASS — delete still blocked after return');
END $$;

INSERT INTO results(line) SELECT CASE WHEN count(*) = 1
            THEN 'PASS — the custody record survived both delete attempts'
            ELSE 'FAIL — custody history was destroyed' END
FROM public.employee_assets WHERE id = (SELECT id FROM t_ids WHERE label = 'assignment_a');

-- A never-assigned asset is still deletable (asset_clean's only assignment is
-- removed first, returning it to never-assigned).

DELETE FROM public.employee_assets WHERE id = (SELECT id FROM t_ids WHERE label = 'assignment_b_target');
DELETE FROM public.assets          WHERE id = (SELECT id FROM t_ids WHERE label = 'asset_clean');

INSERT INTO results(line) SELECT CASE WHEN count(*) = 0
            THEN 'PASS — a never-assigned asset can still be deleted'
            ELSE 'FAIL — deletion of a clean asset was blocked' END
FROM public.assets WHERE id = (SELECT id FROM t_ids WHERE label = 'asset_clean');

-- ─── 7. The manager role confers nothing (corrected by 20260723000000) ─────
--
-- An earlier draft of this file asserted the opposite — that managers resolve
-- 'manage' — because 20260721000000 §3 seeded view/create/edit/manage for the
-- manager role. 20260723000000 removes that seed: asset authority is granted
-- per employee in Control Center, never by role name. A manager must resolve
-- nothing here beyond the 'view' baseline every employee gets.

INSERT INTO results(line) SELECT CASE WHEN count(*) = 0
            THEN 'PASS — no manager resolves create/edit/delete/manage on assets_access'
            ELSE 'FAIL — a manager holds asset write authority by role' END
FROM public.users u
CROSS JOIN LATERAL (VALUES ('create'), ('edit'), ('delete'), ('manage')) AS a(action_key)
WHERE u.role = 'manager' AND u.is_active
  AND public.resolve_permission(u.id, 'assets_access', a.action_key);

INSERT INTO results(line) SELECT CASE WHEN bool_and(public.resolve_permission(u.id, 'assets_access', 'view'))
            THEN 'PASS — managers keep the view baseline'
            ELSE 'FAIL — a manager cannot see the inventory' END
FROM public.users u
WHERE u.role = 'manager' AND u.is_active;

-- ─── 8. Schema-level assertions ─────────────────────────────────────────────

INSERT INTO results(line) SELECT CASE WHEN confdeltype = 'r'
            THEN 'PASS — employee_assets.asset_id FK is ON DELETE RESTRICT'
            ELSE 'FAIL — FK is still ' || confdeltype::text || ' (c = cascade shredder)' END
FROM pg_constraint WHERE conname = 'employee_assets_asset_id_fkey';

INSERT INTO results(line) SELECT CASE WHEN count(*) = 1
            THEN 'PASS — assets_prevent_assigned_delete trigger present'
            ELSE 'FAIL — delete trigger missing' END
FROM pg_trigger WHERE tgname = 'assets_prevent_assigned_delete' AND NOT tgisinternal;

INSERT INTO results(line) SELECT CASE WHEN count(*) = 0
            THEN 'PASS — no asset rests in the stranded returned state'
            ELSE 'FAIL — ' || count(*) || ' assets are still status=returned' END
FROM public.assets WHERE status = 'returned';

RESET role;

SELECT line FROM results ORDER BY at;

ROLLBACK;
