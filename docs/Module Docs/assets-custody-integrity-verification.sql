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

\set employee_a '00000000-0000-0000-0000-000000000001'
\set employee_b '00000000-0000-0000-0000-000000000002'

CREATE TEMP TABLE t_ids (label text primary key, id uuid);

INSERT INTO t_ids
SELECT 'asset_history', id FROM (
  INSERT INTO public.assets (asset_type, asset_name, status)
  VALUES ('other', 'ZZ integrity check — with history', 'available')
  RETURNING id
) s;

INSERT INTO t_ids
SELECT 'asset_clean', id FROM (
  INSERT INTO public.assets (asset_type, asset_name, status)
  VALUES ('other', 'ZZ integrity check — never assigned', 'available')
  RETURNING id
) s;

INSERT INTO t_ids
SELECT 'assignment_a', id FROM (
  INSERT INTO public.employee_assets (asset_id, employee_id, assigned_by, status)
  VALUES (
    (SELECT id FROM t_ids WHERE label = 'asset_history'),
    :'employee_a'::uuid,
    :'employee_a'::uuid,
    'pending_acceptance'
  )
  RETURNING id
) s;

-- ─── 1. accept_employee_asset: the happy path ───────────────────────────────
-- Impersonate employee A the way PostgREST does: role + the JWT claim
-- auth.uid() reads.

SET LOCAL role TO authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'employee_a')::text, true);

SELECT public.accept_employee_asset((SELECT id FROM t_ids WHERE label = 'assignment_a'));

SELECT CASE WHEN status = 'accepted' AND accepted_at IS NOT NULL
            THEN 'PASS — employee accepted their own pending assignment'
            ELSE 'FAIL — acceptance did not land: status=' || status END
FROM public.employee_assets WHERE id = (SELECT id FROM t_ids WHERE label = 'assignment_a');

-- ─── 2. Protected fields are untouched by acceptance ────────────────────────
-- The RPC writes status and accepted_at only; everything else must still hold
-- the values written at assignment time.

SELECT CASE WHEN ea.asset_id    = (SELECT id FROM t_ids WHERE label = 'asset_history')
             AND ea.employee_id = :'employee_a'::uuid
             AND ea.assigned_by = :'employee_a'::uuid
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
  RAISE EXCEPTION 'FAIL — a second acceptance was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS — second acceptance refused (%)', SQLERRM;
END $$;

SELECT CASE WHEN ea.accepted_at = (SELECT accepted_at FROM t_accepted_at)
            THEN 'PASS — accepted_at did not move on the repeat attempt'
            ELSE 'FAIL — accepted_at was rewritten' END
FROM public.employee_assets ea WHERE ea.id = (SELECT id FROM t_ids WHERE label = 'assignment_a');

-- ─── 4. An employee cannot accept someone else's assignment ─────────────────
-- Employee B attempts A's assignment. Expect ASSET_ACCEPT_DENIED — the same
-- message a nonexistent id produces, so ids cannot be probed.

INSERT INTO t_ids
SELECT 'assignment_b_target', id FROM (
  INSERT INTO public.employee_assets (asset_id, employee_id, assigned_by, status)
  VALUES (
    (SELECT id FROM t_ids WHERE label = 'asset_clean'),
    :'employee_a'::uuid,
    :'employee_a'::uuid,
    'pending_acceptance'
  )
  RETURNING id
) s;

SELECT set_config('request.jwt.claims', json_build_object('sub', :'employee_b')::text, true);

DO $$
BEGIN
  PERFORM public.accept_employee_asset((SELECT id FROM t_ids WHERE label = 'assignment_b_target'));
  RAISE EXCEPTION 'FAIL — employee B accepted an assignment belonging to employee A';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS — cross-employee acceptance refused (%)', SQLERRM;
END $$;

SELECT CASE WHEN status = 'pending_acceptance' AND accepted_at IS NULL
            THEN 'PASS — the other employee''s row is untouched'
            ELSE 'FAIL — a foreign acceptance changed the row' END
FROM public.employee_assets WHERE id = (SELECT id FROM t_ids WHERE label = 'assignment_b_target');

-- ─── 5. Employees hold no direct UPDATE on employee_assets ──────────────────
-- The old employee_assets_own_accept policy is gone, so a hand-rolled UPDATE
-- must affect zero rows (PostgREST filters it out rather than erroring).

SELECT set_config('request.jwt.claims', json_build_object('sub', :'employee_a')::text, true);

WITH attempted AS (
  UPDATE public.employee_assets
     SET accepted_at = now() - interval '30 days'
   WHERE id = (SELECT id FROM t_ids WHERE label = 'assignment_a')
  RETURNING 1
)
SELECT CASE WHEN count(*) = 0
            THEN 'PASS — direct UPDATE by the owning employee affects no rows'
            ELSE 'FAIL — employee can still backdate acceptance directly' END
FROM attempted;

SELECT CASE WHEN count(*) = 0
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
  RAISE EXCEPTION 'FAIL — an asset with assignment history was deleted';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS — delete blocked for an asset with history (%)', SQLERRM;
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
  RAISE EXCEPTION 'FAIL — a returned asset lost its custody history to a delete';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS — delete still blocked after return (%)', SQLERRM;
END $$;

SELECT CASE WHEN count(*) = 1
            THEN 'PASS — the custody record survived both delete attempts'
            ELSE 'FAIL — custody history was destroyed' END
FROM public.employee_assets WHERE id = (SELECT id FROM t_ids WHERE label = 'assignment_a');

-- A never-assigned asset is still deletable (asset_clean's only assignment is
-- removed first, returning it to never-assigned).

DELETE FROM public.employee_assets WHERE id = (SELECT id FROM t_ids WHERE label = 'assignment_b_target');
DELETE FROM public.assets          WHERE id = (SELECT id FROM t_ids WHERE label = 'asset_clean');

SELECT CASE WHEN count(*) = 0
            THEN 'PASS — a never-assigned asset can still be deleted'
            ELSE 'FAIL — deletion of a clean asset was blocked' END
FROM public.assets WHERE id = (SELECT id FROM t_ids WHERE label = 'asset_clean');

-- ─── 7. Manager delete stays denied (permission cutover, 20260721000000) ────
-- role_permissions grants managers view/create/edit/manage on assets_access
-- and NOT delete, so the resolver must say false for every manager.

SELECT CASE WHEN count(*) FILTER (
              WHERE public.resolve_permission(u.id, 'assets_access', 'delete')
            ) = 0
            THEN 'PASS — no manager resolves delete on assets_access'
            ELSE 'FAIL — a manager can delete assets' END
FROM public.users u
WHERE u.role = 'manager' AND u.is_active;

SELECT CASE WHEN bool_and(public.resolve_permission(u.id, 'assets_access', 'manage'))
            THEN 'PASS — managers resolve manage on assets_access'
            ELSE 'FAIL — manager manage grant missing' END
FROM public.users u
WHERE u.role = 'manager' AND u.is_active;

-- ─── 8. Schema-level assertions ─────────────────────────────────────────────

SELECT CASE WHEN confdeltype = 'r'
            THEN 'PASS — employee_assets.asset_id FK is ON DELETE RESTRICT'
            ELSE 'FAIL — FK is still ' || confdeltype || ' (c = cascade shredder)' END
FROM pg_constraint WHERE conname = 'employee_assets_asset_id_fkey';

SELECT CASE WHEN count(*) = 1
            THEN 'PASS — assets_prevent_assigned_delete trigger present'
            ELSE 'FAIL — delete trigger missing' END
FROM pg_trigger WHERE tgname = 'assets_prevent_assigned_delete' AND NOT tgisinternal;

SELECT CASE WHEN count(*) = 0
            THEN 'PASS — no asset rests in the stranded returned state'
            ELSE 'FAIL — ' || count(*) || ' assets are still status=returned' END
FROM public.assets WHERE status = 'returned';

ROLLBACK;
