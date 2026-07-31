-- ============================================================================
-- Assets & Access — permission model + change-request workflow verification
-- ============================================================================
-- Covers what the Node tests cannot: RLS decisions, SECURITY DEFINER
-- authorization, and the atomicity of approval. Companion to
-- assets-custody-integrity-verification.sql (custody rules) — run both.
--
-- WRITES DATA, then ROLLBACKs. Nothing survives. Requires migrations
-- 20260721000000 through 20260724000000 to be applied first.
--
-- Substitute three real public.users ids in the `who` fixture below:
--   creator   — the one non-admin who may add assets (Aditya)
--   viewer    — an ordinary employee, view only
--   admin_id  — the administrator (Nishant)
--
-- Run: npx supabase db query --linked -f "docs/Module Docs/assets-change-requests-verification.sql"
-- Expected: every line prints PASS.
-- ============================================================================

BEGIN;

-- The ids live in a table read through pg_temp.who(), NOT in psql \set
-- variables. `supabase db query` posts the file to an HTTP endpoint rather
-- than piping it through psql, so a backslash meta-command is a syntax error
-- on line 1 and the whole script never runs — which is exactly how the first
-- version of this file failed.

CREATE TEMP TABLE who_ids (label text primary key, id uuid);
INSERT INTO who_ids VALUES
  ('creator',  '973b4337-9cae-4f66-8e7f-b158326cdc10'),
  ('viewer',   'fcf8bbf9-0cc4-4a6e-ba64-1143b14ef4a2'),
  ('admin_id', '6507df9f-cdeb-4ebd-849f-8498c165d596');

CREATE OR REPLACE FUNCTION pg_temp.who(p_label text) RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT id FROM who_ids WHERE label = p_label $$;

CREATE TEMP TABLE t (label text primary key, id uuid);

-- Assertions accumulate here: the CLI returns only the LAST statement's rows,
-- so a script printing each check inline would report nothing at all.
CREATE TEMP TABLE results (at timestamptz DEFAULT clock_timestamp(), line text);
GRANT ALL ON results TO authenticated;

-- Impersonate the way PostgREST does: the authenticated role plus the JWT
-- claim auth.uid() reads.
CREATE OR REPLACE FUNCTION pg_temp.become(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user)::text, true);
END $$;

-- Once the script is running as `authenticated`, it still needs to reach its
-- own scratch table and helper.
GRANT ALL ON t TO authenticated;
GRANT SELECT ON who_ids TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.become(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.who(text) TO authenticated;

-- ─── 1. Effective permissions match the product rule ───────────────────────

INSERT INTO results(line) SELECT CASE WHEN bool_and(ok) THEN 'PASS — effective permissions match the intended model'
            ELSE 'FAIL — ' || string_agg(who || ':' || act, ', ') FILTER (WHERE NOT ok) END
FROM (
  SELECT 'creator' AS who, r.action_key AS act,
         r.allowed = (r.action_key IN ('view','create')) AS ok
  FROM public.resolve_effective_permissions(pg_temp.who('creator'), 'assets_access') r
  UNION ALL
  SELECT 'viewer', r.action_key, r.allowed = (r.action_key = 'view')
  FROM public.resolve_effective_permissions(pg_temp.who('viewer'), 'assets_access') r
  UNION ALL
  SELECT 'admin', r.action_key, r.allowed
  FROM public.resolve_effective_permissions(pg_temp.who('admin_id'), 'assets_access') r
) s;

INSERT INTO results(line) SELECT CASE WHEN count(*) = 0
            THEN 'PASS — no role_permissions row grants this module by role name (admin aside)'
            ELSE 'FAIL — ' || count(*)::text || ' non-admin role grants exist' END
FROM public.role_permissions rp
JOIN public.permission_modules pm ON pm.id = rp.module_id
WHERE pm.module_key = 'assets_access' AND rp.role <> 'admin' AND rp.allowed;

-- ─── 2. Direct writes: creator may insert, nobody else may edit or delete ──

SELECT pg_temp.become(pg_temp.who('creator'));

INSERT INTO public.assets (asset_type, asset_name, serial_no, specifications, status)
VALUES ('other', 'ZZ request check — created by creator', 'ZZ-1', '8GB', 'available');

INSERT INTO t SELECT 'asset', id FROM public.assets WHERE asset_name = 'ZZ request check — created by creator';

INSERT INTO results(line) SELECT CASE WHEN count(*) = 1 THEN 'PASS — the authorised non-admin can create an asset'
            ELSE 'FAIL — create was refused' END
FROM t WHERE label = 'asset';

-- Same user, no 'edit': the UPDATE must affect zero rows (RLS filters it).
WITH attempted AS (
  UPDATE public.assets SET asset_name = 'ZZ hacked' WHERE id = (SELECT id FROM t WHERE label='asset') RETURNING 1
)
INSERT INTO results(line) SELECT CASE WHEN count(*) = 0 THEN 'PASS — creator cannot edit assets directly'
            ELSE 'FAIL — creator edited an asset without the edit permission' END FROM attempted;

WITH attempted AS (
  DELETE FROM public.assets WHERE id = (SELECT id FROM t WHERE label='asset') RETURNING 1
)
INSERT INTO results(line) SELECT CASE WHEN count(*) = 0 THEN 'PASS — creator cannot delete assets directly'
            ELSE 'FAIL — creator deleted an asset without the delete permission' END FROM attempted;

-- An assignment write needs 'manage', which no non-admin holds.
--
-- A DO block, not a CTE: a failing INSERT policy RAISES 42501, whereas
-- UPDATE and DELETE simply filter the row out and affect zero rows. The two
-- cases need different shapes.
DO $$
BEGIN
  INSERT INTO public.employee_assets (asset_id, employee_id, assigned_by, status)
  VALUES ((SELECT id FROM t WHERE label='asset'), pg_temp.who('viewer'), pg_temp.who('creator'), 'pending_acceptance');
  INSERT INTO results(line) VALUES ('FAIL — a non-manage user created an assignment');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO results(line) VALUES ('PASS — assignment management is refused without manage');
END $$;

-- The view-only employee cannot create at all.
SELECT pg_temp.become(pg_temp.who('viewer'));

DO $$
BEGIN
  INSERT INTO public.assets (asset_type, asset_name, status)
  VALUES ('other', 'ZZ viewer should not create', 'available');
  INSERT INTO results(line) VALUES ('FAIL — a view-only employee created an asset');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO results(line) VALUES ('PASS — view-only employee refused asset creation');
END $$;

-- ─── 3. Filing requests ────────────────────────────────────────────────────

INSERT INTO public.asset_change_requests (asset_id, asset_name_snapshot, request_type, reason, proposed_asset_name)
VALUES ((SELECT id FROM t WHERE label='asset'), 'ZZ request check', 'edit', 'Name is wrong', 'ZZ renamed by request');

INSERT INTO t SELECT 'edit_req', id FROM public.asset_change_requests WHERE request_type='edit' AND reason='Name is wrong';

INSERT INTO results(line) SELECT CASE WHEN requested_by = pg_temp.who('viewer') AND status = 'pending'
            THEN 'PASS — a non-admin can file an edit request, defaulted to themselves'
            ELSE 'FAIL — request not filed correctly' END
FROM public.asset_change_requests WHERE id = (SELECT id FROM t WHERE label='edit_req');

-- Spoofing requested_by must be refused by the insert policy.
DO $$
BEGIN
  INSERT INTO public.asset_change_requests (asset_id, asset_name_snapshot, request_type, reason, requested_by)
  VALUES ((SELECT id FROM t WHERE label='asset'), 'ZZ', 'remove', 'spoof attempt', pg_temp.who('creator'));
  INSERT INTO results(line) VALUES ('FAIL — requested_by was successfully spoofed');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO results(line) VALUES ('PASS — requested_by cannot be spoofed');
END $$;

-- A second identical pending request is refused by the partial unique index.
DO $$
BEGIN
  INSERT INTO public.asset_change_requests (asset_id, asset_name_snapshot, request_type, reason, proposed_asset_name)
  VALUES ((SELECT id FROM t WHERE label='asset'), 'ZZ request check', 'edit', 'again', 'ZZ other name');
  INSERT INTO results(line) VALUES ('FAIL — a duplicate pending edit request was allowed');
EXCEPTION WHEN unique_violation THEN
  INSERT INTO results(line) VALUES ('PASS — duplicate pending request refused');
END $$;

-- A removal request is a different type, so it is allowed alongside the edit.
INSERT INTO public.asset_change_requests (asset_id, asset_name_snapshot, request_type, reason)
VALUES ((SELECT id FROM t WHERE label='asset'), 'ZZ request check', 'remove', 'No longer needed');

INSERT INTO t SELECT 'remove_req', id FROM public.asset_change_requests WHERE request_type='remove' AND reason='No longer needed';

INSERT INTO results(line) SELECT CASE WHEN count(*) = 1 THEN 'PASS — a removal request can coexist with an edit request'
            ELSE 'FAIL — removal request not filed' END
FROM t WHERE label = 'remove_req';

-- ─── 3b. Custody operations are atomic and permission-gated ────────────────
-- After 20260725000000 the three custody functions no longer share one
-- permission: assign_asset wants 'assign', return_asset and mark_asset_lost
-- want 'manage'. The creator holds none of them, so all three refuse.

DO $$
BEGIN
  PERFORM public.assign_asset((SELECT id FROM t WHERE label='asset'), pg_temp.who('viewer'));
  INSERT INTO results(line) VALUES ('FAIL — a user without assign assigned an asset');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO results(line) VALUES ('PASS — assign_asset refused without assign');
END $$;

DO $$
BEGIN
  PERFORM public.mark_asset_lost((SELECT id FROM t WHERE label='asset'));
  INSERT INTO results(line) VALUES ('FAIL — a user without manage marked an asset lost');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO results(line) VALUES ('PASS — mark_asset_lost refused without manage');
END $$;

-- 'assign' is its own action (20260725000000). Granting it must NOT bring
-- return or mark-lost with it. Simulated with a temporary employee override
-- for the creator, rolled back with everything else.
RESET role;
INSERT INTO public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
SELECT pg_temp.who('creator'), pm.id, pa.id, true, pg_temp.who('admin_id')
FROM public.permission_modules pm, public.permission_actions pa
WHERE pm.module_key = 'assets_access' AND pa.action_key = 'assign'
ON CONFLICT (user_id, module_id, action_id)
DO UPDATE SET allowed = true, revoked_at = NULL, revoked_by = NULL;

INSERT INTO results(line) SELECT CASE WHEN public.resolve_permission(pg_temp.who('creator'), 'assets_access', 'assign')
             AND NOT public.resolve_permission(pg_temp.who('creator'), 'assets_access', 'manage')
            THEN 'PASS — the assign override grants assign and not manage'
            ELSE 'FAIL — assign override did not resolve as expected' END;

SELECT pg_temp.become(pg_temp.who('creator'));

DO $$
BEGIN
  PERFORM public.return_asset((SELECT id FROM t WHERE label='asset'));
  INSERT INTO results(line) VALUES ('FAIL — assign permission was accepted by return_asset');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO results(line) VALUES ('PASS — assign alone cannot return an asset');
END $$;

DO $$
BEGIN
  PERFORM public.mark_asset_lost((SELECT id FROM t WHERE label='asset'));
  INSERT INTO results(line) VALUES ('FAIL — assign permission was accepted by mark_asset_lost');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO results(line) VALUES ('PASS — assign alone cannot mark an asset lost');
END $$;

-- …but it CAN assign, and assigned_by must be the caller, not a parameter.
SELECT public.assign_asset((SELECT id FROM t WHERE label='asset'), pg_temp.who('viewer'));

INSERT INTO results(line) SELECT CASE WHEN count(*) = 1
            THEN 'PASS — assign permission can assign, with assigned_by taken from auth.uid()'
            ELSE 'FAIL — assign_asset did not record the calling user' END
FROM public.employee_assets ea
WHERE ea.asset_id = (SELECT id FROM t WHERE label='asset')
  AND ea.status = 'pending_acceptance'
  AND ea.assigned_by = pg_temp.who('creator');

-- A second assignment of the same asset must be refused.
DO $$
BEGIN
  PERFORM public.assign_asset((SELECT id FROM t WHERE label='asset'), pg_temp.who('admin_id'));
  INSERT INTO results(line) VALUES ('FAIL — an already-held asset was assigned again');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO results(line) VALUES ('PASS — an unavailable asset cannot be assigned again');
END $$;

-- Hand the asset back to the admin path and re-check the atomic pairing.
RESET role;
UPDATE public.employee_permission_overrides eo
   SET revoked_at = now(), revoked_by = pg_temp.who('admin_id')
  FROM public.permission_modules pm, public.permission_actions pa
 WHERE eo.module_id = pm.id AND eo.action_id = pa.id
   AND pm.module_key = 'assets_access' AND pa.action_key = 'assign'
   AND eo.user_id = pg_temp.who('creator');

INSERT INTO results(line) SELECT CASE WHEN NOT public.resolve_permission(pg_temp.who('creator'), 'assets_access', 'assign')
            THEN 'PASS — revoking the override removes the assign permission'
            ELSE 'FAIL — assign survived revocation' END;

SELECT pg_temp.become(pg_temp.who('admin_id'));
SELECT public.return_asset((SELECT id FROM t WHERE label='asset'));
SELECT public.assign_asset((SELECT id FROM t WHERE label='asset'), pg_temp.who('viewer'));

INSERT INTO results(line) SELECT CASE WHEN a.status = 'assigned'
             AND (SELECT count(*) FROM public.employee_assets ea
                   WHERE ea.asset_id = a.id AND ea.status = 'pending_acceptance') = 1
            THEN 'PASS — assign moved the assignment and assets.status together'
            ELSE 'FAIL — assign left the two tables disagreeing' END
FROM public.assets a WHERE a.id = (SELECT id FROM t WHERE label='asset');

-- Acceptance is the assignee's, and only theirs.
SELECT pg_temp.become(pg_temp.who('creator'));
DO $$
BEGIN
  PERFORM public.accept_employee_asset(
    (SELECT id FROM public.employee_assets WHERE asset_id = (SELECT id FROM t WHERE label='asset') AND status='pending_acceptance'));
  INSERT INTO results(line) VALUES ('FAIL — a third party accepted someone else''s assignment');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO results(line) VALUES ('PASS — only the assignee may accept');
END $$;

SELECT pg_temp.become(pg_temp.who('viewer'));
SELECT public.accept_employee_asset(
  (SELECT id FROM public.employee_assets WHERE asset_id = (SELECT id FROM t WHERE label='asset') AND status='pending_acceptance'));

-- Scoped to the OPEN custody period. This asset has been assigned, returned
-- and assigned again by now, so an unfiltered read here returns the closed
-- row as well and reports a false FAIL for it.
INSERT INTO results(line) SELECT CASE WHEN count(*) = 1
            THEN 'PASS — the assignee accepted their own assignment, timestamp set server-side'
            ELSE 'FAIL — acceptance did not land on the open custody period' END
FROM public.employee_assets
WHERE asset_id = (SELECT id FROM t WHERE label='asset')
  AND status = 'accepted' AND accepted_at IS NOT NULL;

-- Return closes custody and frees the asset, again in one statement.
SELECT pg_temp.become(pg_temp.who('admin_id'));
SELECT public.return_asset((SELECT id FROM t WHERE label='asset'));

-- Again scoped to what the operation is responsible for: no custody period
-- may be left open, and every closed one carries a returned_at. Counting all
-- 'returned' rows and expecting exactly 1 fails on the second cycle purely
-- because the first cycle left a legitimate closed row behind.
INSERT INTO results(line) SELECT CASE WHEN a.status = 'available'
             AND NOT EXISTS (SELECT 1 FROM public.employee_assets ea
                              WHERE ea.asset_id = a.id
                                AND ea.status IN ('pending_acceptance','accepted'))
             AND NOT EXISTS (SELECT 1 FROM public.employee_assets ea
                              WHERE ea.asset_id = a.id
                                AND ea.status = 'returned' AND ea.returned_at IS NULL)
            THEN 'PASS — return freed the asset and closed the assignment together'
            ELSE 'FAIL — return left an inconsistent state' END
FROM public.assets a WHERE a.id = (SELECT id FROM t WHERE label='asset');

-- ─── 3c. 'assign' and 'manage' are genuinely separate grants ───────────────
--
-- Everything above catches insufficient_privilege, but the RPCs raise 42501
-- for BOTH an authorization refusal (ASSET_CUSTODY_DENIED) and a state
-- refusal (ASSET_CUSTODY_INVALID). A test that only reads the SQLSTATE cannot
-- tell "you may not do this" from "this asset is not in a state to do it to",
-- and would keep passing if the permission check were removed entirely. These
-- checks read the message.

RESET role;

CREATE OR REPLACE FUNCTION pg_temp.outcome(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN 'ALLOWED';
EXCEPTION WHEN OTHERS THEN
  RETURN split_part(SQLERRM, ':', 1);
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.outcome(text) TO authenticated;

INSERT INTO public.assets (asset_type, asset_name, status)
VALUES ('other', 'ZZ assign-permission check — free', 'available');
INSERT INTO t SELECT 'free_asset', id FROM public.assets WHERE asset_name = 'ZZ assign-permission check — free';

INSERT INTO public.assets (asset_type, asset_name, status)
VALUES ('other', 'ZZ assign-permission check — held', 'available');
INSERT INTO t SELECT 'held_asset', id FROM public.assets WHERE asset_name = 'ZZ assign-permission check — held';

SELECT pg_temp.become(pg_temp.who('admin_id'));
SELECT public.assign_asset((SELECT id FROM t WHERE label='held_asset'), pg_temp.who('creator'));

INSERT INTO results(line) SELECT CASE WHEN a.status = 'assigned'
            THEN 'PASS — an administrator can assign without any override'
            ELSE 'FAIL — admin assign did not take effect' END
FROM public.assets a WHERE a.id = (SELECT id FROM t WHERE label='held_asset');

-- The creator's assign override was revoked earlier in 3b. The RPC — not just
-- resolve_permission — must refuse them now.
SELECT pg_temp.become(pg_temp.who('creator'));

INSERT INTO results(line) SELECT CASE WHEN pg_temp.outcome(
       'SELECT public.assign_asset(''' || (SELECT id FROM t WHERE label='free_asset') ||
       '''::uuid, ''' || pg_temp.who('viewer') || '''::uuid)') = 'ASSET_CUSTODY_DENIED'
       THEN 'PASS — assign_asset refuses the creator once the override is revoked'
       ELSE 'FAIL — a revoked override still passed assign_asset' END;

-- A view-only employee is refused too.
SELECT pg_temp.become(pg_temp.who('viewer'));

INSERT INTO results(line) SELECT CASE WHEN pg_temp.outcome(
       'SELECT public.assign_asset(''' || (SELECT id FROM t WHERE label='free_asset') ||
       '''::uuid, ''' || pg_temp.who('creator') || '''::uuid)') = 'ASSET_CUSTODY_DENIED'
       THEN 'PASS — a view-only employee cannot assign'
       ELSE 'FAIL — a view-only employee assigned an asset' END;

-- Now give the viewer 'manage' and nothing else. This is the case the split
-- exists for: someone trusted to take assets back and write them off is NOT
-- thereby trusted to hand them out.
RESET role;
INSERT INTO public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
SELECT pg_temp.who('viewer'), pm.id, pa.id, true, pg_temp.who('admin_id')
FROM public.permission_modules pm, public.permission_actions pa
WHERE pm.module_key = 'assets_access' AND pa.action_key = 'manage'
ON CONFLICT (user_id, module_id, action_id)
DO UPDATE SET allowed = true, revoked_at = NULL, revoked_by = NULL;

INSERT INTO results(line) SELECT CASE WHEN public.resolve_permission(pg_temp.who('viewer'), 'assets_access', 'manage')
             AND NOT public.resolve_permission(pg_temp.who('viewer'), 'assets_access', 'assign')
            THEN 'PASS — the manage override grants manage and not assign'
            ELSE 'FAIL — manage override did not resolve as expected' END;

SELECT pg_temp.become(pg_temp.who('viewer'));

INSERT INTO results(line) SELECT CASE WHEN pg_temp.outcome(
       'SELECT public.assign_asset(''' || (SELECT id FROM t WHERE label='free_asset') ||
       '''::uuid, ''' || pg_temp.who('creator') || '''::uuid)') = 'ASSET_CUSTODY_DENIED'
       THEN 'PASS — a manage-only user cannot assign'
       ELSE 'FAIL — manage was accepted by assign_asset' END;

-- …but manage really is in force, so return and mark-lost do work for them.
INSERT INTO results(line) SELECT CASE WHEN pg_temp.outcome(
       'SELECT public.return_asset(''' || (SELECT id FROM t WHERE label='held_asset') || '''::uuid)') = 'ALLOWED'
       THEN 'PASS — a manage-only user can return an asset'
       ELSE 'FAIL — manage was refused by return_asset' END;

INSERT INTO results(line) SELECT CASE WHEN pg_temp.outcome(
       'SELECT public.mark_asset_lost(''' || (SELECT id FROM t WHERE label='held_asset') || '''::uuid)') = 'ALLOWED'
       THEN 'PASS — a manage-only user can mark an asset lost'
       ELSE 'FAIL — manage was refused by mark_asset_lost' END;

-- The open-assignment guard is distinct from the availability guard. Force
-- assets.status back to 'available' behind the RPC's back while a custody
-- period is still open, so the second IF in assign_asset is the one that
-- fires rather than the status check in front of it.
RESET role;
INSERT INTO public.employee_assets (asset_id, employee_id, assigned_by, status)
VALUES ((SELECT id FROM t WHERE label='free_asset'), pg_temp.who('viewer'), pg_temp.who('admin_id'), 'accepted');
UPDATE public.assets SET status = 'available' WHERE id = (SELECT id FROM t WHERE label='free_asset');

SELECT pg_temp.become(pg_temp.who('admin_id'));

INSERT INTO results(line) SELECT CASE WHEN pg_temp.outcome(
       'SELECT public.assign_asset(''' || (SELECT id FROM t WHERE label='free_asset') ||
       '''::uuid, ''' || pg_temp.who('creator') || '''::uuid)') = 'ASSET_CUSTODY_INVALID'
       THEN 'PASS — an asset with an open custody period cannot be assigned again'
       ELSE 'FAIL — a duplicate open assignment was created' END;

INSERT INTO results(line) SELECT CASE WHEN count(*) = 1
            THEN 'PASS — the refused assign wrote nothing'
            ELSE 'FAIL — the refused assign left ' || count(*) || ' open custody rows' END
FROM public.employee_assets
WHERE asset_id = (SELECT id FROM t WHERE label='free_asset')
  AND status IN ('pending_acceptance','accepted');

-- Revoking manage takes the custody operations away again.
RESET role;
UPDATE public.employee_permission_overrides eo
   SET revoked_at = now(), revoked_by = pg_temp.who('admin_id')
  FROM public.permission_modules pm, public.permission_actions pa
 WHERE eo.module_id = pm.id AND eo.action_id = pa.id
   AND pm.module_key = 'assets_access' AND pa.action_key = 'manage'
   AND eo.user_id = pg_temp.who('viewer');

SELECT pg_temp.become(pg_temp.who('viewer'));

INSERT INTO results(line) SELECT CASE WHEN pg_temp.outcome(
       'SELECT public.return_asset(''' || (SELECT id FROM t WHERE label='free_asset') || '''::uuid)') = 'ASSET_CUSTODY_DENIED'
       THEN 'PASS — revoking manage removes return_asset again'
       ELSE 'FAIL — manage survived revocation' END;

SELECT pg_temp.become(pg_temp.who('viewer'));

-- ─── 4. Only an admin reviews ──────────────────────────────────────────────

DO $$
BEGIN
  PERFORM public.approve_asset_change_request((SELECT id FROM t WHERE label='edit_req'));
  INSERT INTO results(line) VALUES ('FAIL — a non-admin approved a request');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO results(line) VALUES ('PASS — non-admin approval refused');
END $$;

DO $$
BEGIN
  PERFORM public.reject_asset_change_request((SELECT id FROM t WHERE label='edit_req'));
  INSERT INTO results(line) VALUES ('FAIL — a non-admin rejected a request');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO results(line) VALUES ('PASS — non-admin rejection refused');
END $$;

-- No UPDATE policy exists, so a client cannot self-approve either.
WITH attempted AS (
  UPDATE public.asset_change_requests SET status = 'approved'
   WHERE id = (SELECT id FROM t WHERE label='edit_req') RETURNING 1
)
INSERT INTO results(line) SELECT CASE WHEN count(*) = 0 THEN 'PASS — a client cannot move a request to approved'
            ELSE 'FAIL — request status was changed directly' END FROM attempted;

-- ─── 5. Admin approval applies only the proposed fields ────────────────────

SELECT pg_temp.become(pg_temp.who('admin_id'));
SELECT public.approve_asset_change_request((SELECT id FROM t WHERE label='edit_req'), 'Looks right');

INSERT INTO results(line) SELECT CASE WHEN a.asset_name = 'ZZ renamed by request'
             AND a.serial_no = 'ZZ-1' AND a.specifications = '8GB' AND a.asset_type = 'other'
            THEN 'PASS — approval applied only the proposed field'
            ELSE 'FAIL — approval changed fields the request did not propose' END
FROM public.assets a WHERE a.id = (SELECT id FROM t WHERE label='asset');

INSERT INTO results(line) SELECT CASE WHEN status='approved' AND reviewed_by = pg_temp.who('admin_id') AND reviewed_at IS NOT NULL
            THEN 'PASS — the request records the reviewer and the time'
            ELSE 'FAIL — review fields not recorded' END
FROM public.asset_change_requests WHERE id = (SELECT id FROM t WHERE label='edit_req');

-- A reviewed request cannot be processed twice.
DO $$
BEGIN
  PERFORM public.approve_asset_change_request((SELECT id FROM t WHERE label='edit_req'));
  INSERT INTO results(line) VALUES ('FAIL — an already-approved request was approved again');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO results(line) VALUES ('PASS — second review refused');
END $$;

-- ─── 6. Removal approval respects custody history ──────────────────────────
-- Give the asset a custody record, then confirm removal approval fails safely
-- and leaves BOTH the asset and the request untouched.

INSERT INTO public.employee_assets (asset_id, employee_id, assigned_by, status)
VALUES ((SELECT id FROM t WHERE label='asset'), pg_temp.who('viewer'), pg_temp.who('admin_id'), 'pending_acceptance');

DO $$
BEGIN
  PERFORM public.approve_asset_change_request((SELECT id FROM t WHERE label='remove_req'));
  INSERT INTO results(line) VALUES ('FAIL — an asset with assignment history was removed by approval');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO results(line) VALUES ('PASS — removal approval blocked by custody history');
END $$;

INSERT INTO results(line) SELECT CASE WHEN (SELECT count(*) FROM public.assets WHERE id = (SELECT id FROM t WHERE label='asset')) = 1
             AND (SELECT status FROM public.asset_change_requests WHERE id = (SELECT id FROM t WHERE label='remove_req')) = 'pending'
            THEN 'PASS — blocked approval is atomic: asset kept, request still pending'
            ELSE 'FAIL — blocked approval left inconsistent state' END;

-- ─── 7. Removal approval succeeds for an eligible asset ────────────────────

SELECT pg_temp.become(pg_temp.who('creator'));

INSERT INTO public.assets (asset_type, asset_name, status)
VALUES ('other', 'ZZ never assigned', 'available');
INSERT INTO t SELECT 'clean_asset', id FROM public.assets WHERE asset_name = 'ZZ never assigned';

INSERT INTO public.asset_change_requests (asset_id, asset_name_snapshot, request_type, reason)
VALUES ((SELECT id FROM t WHERE label='clean_asset'), 'ZZ never assigned', 'remove', 'Entered by mistake');
INSERT INTO t SELECT 'clean_req', id FROM public.asset_change_requests WHERE reason='Entered by mistake';

SELECT pg_temp.become(pg_temp.who('admin_id'));
SELECT public.approve_asset_change_request((SELECT id FROM t WHERE label='clean_req'), 'Agreed');

INSERT INTO results(line) SELECT CASE WHEN (SELECT count(*) FROM public.assets WHERE id = (SELECT id FROM t WHERE label='clean_asset')) = 0
            THEN 'PASS — an eligible asset is removed on approval'
            ELSE 'FAIL — approved removal did not delete the asset' END;

INSERT INTO results(line) SELECT CASE WHEN status = 'approved' AND asset_id IS NULL
            THEN 'PASS — the approval record survives the asset it removed'
            ELSE 'FAIL — approval record lost or left dangling' END
FROM public.asset_change_requests WHERE id = (SELECT id FROM t WHERE label='clean_req');

-- ─── 8. Rejection leaves the asset alone ───────────────────────────────────

SELECT public.reject_asset_change_request((SELECT id FROM t WHERE label='remove_req'), 'Still in use');

INSERT INTO results(line) SELECT CASE WHEN (SELECT status FROM public.asset_change_requests WHERE id=(SELECT id FROM t WHERE label='remove_req')) = 'rejected'
             AND (SELECT count(*) FROM public.assets WHERE id=(SELECT id FROM t WHERE label='asset')) = 1
            THEN 'PASS — rejection records the decision and leaves the asset unchanged'
            ELSE 'FAIL — rejection did not behave correctly' END;

-- ─── 9. Requester visibility ───────────────────────────────────────────────

SELECT pg_temp.become(pg_temp.who('creator'));

INSERT INTO results(line) SELECT CASE WHEN count(*) = 0
            THEN 'PASS — a requester cannot read another employee''s requests'
            ELSE 'FAIL — cross-employee request visibility' END
FROM public.asset_change_requests WHERE requested_by <> pg_temp.who('creator');

RESET role;

RESET role;

SELECT line FROM results ORDER BY at;

ROLLBACK;
