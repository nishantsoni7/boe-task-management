-- Assets & Access — delegated administration of the Access Register.
--
-- WHAT THIS IS
-- ------------
-- One new capability, `assets_access.manage_access_records`, displayed in
-- Control Center as "Manage Access Records". A holder may READ, ADD and EDIT
-- the access-login records of EVERY employee — exactly the workflow an
-- administrator has on the Access Register today, and nothing else.
--
-- WHY A NEW ACTION KEY, AND NOT ONE OF THE FIVE THAT EXIST
-- -------------------------------------------------------
-- `assign` is asset assignment and `manage` is custody correction
-- (return / mark lost / review). Both are already PROTECTED and both are
-- deliberately narrow — see 20260725000000, which exists precisely because one
-- key had grown to mean three unrelated decisions. Widening either of them to
-- cover employee credentials would repeat that mistake on the most sensitive
-- table the module owns. So this is its own key, granted on its own, and it
-- carries no asset authority whatsoever.
--
-- WHAT CHANGES FOR access_records
-- -------------------------------
-- 20260640 gave the table four policies: an own-row read for the employee, and
-- admin-only select / insert / update. 20260721000000 and 20260810000000 both
-- state, in their headers, that the table stays admin-only "until the
-- credential-storage rework" because `secret_value` is plaintext.
--
-- That reservation is honoured rather than dropped. What widens here is
-- exactly the three ADMINISTRATIVE policies, and only to a grant an
-- administrator must hand out one person at a time. What does NOT change:
--
--   * `secret_value` is still plaintext, and this migration adds no way to
--     read it that did not exist before for an administrator. The Access
--     Register screen never rendered it and now does not even SELECT it.
--   * there is still no DELETE policy on access_records, for anybody. An
--     access record is an accountability record; disabling is the workflow.
--   * `access_records_own_select` is untouched — an employee still reads their
--     own rows and nobody else's.
--   * the RESTRICTIVE `access_records_module_entry_gate` from 20260905000000
--     still applies. A holder who cannot enter Assets & Access reads nothing,
--     whatever this grant says. That is why the application half adds
--     `manage_access_records → view` to ACTION_DEPENDENCIES.
--
-- WHAT IT DOES NOT GRANT
-- ----------------------
-- No asset create / assign / edit / delete / manage, no change-request
-- approval, no Control Center authority, no member management, no other
-- module. It is checked by exactly three policies, all on access_records, and
-- by `can_manage_access_records()` — nothing else in the schema reads it.
--
-- GRANTS: THIS MIGRATION GIVES THE CAPABILITY TO NOBODY
-- ----------------------------------------------------
-- default_allowed = false, so it is DENIED for everyone until an administrator
-- says otherwise. Admin gets the usual role row so its effective-permission
-- display stays complete (the admin bypass inside the predicate does not depend
-- on that row existing).
--
-- Beyond those two, NOTHING is granted. There is no employee override, no role
-- rule and no department rule in this file, and no user id anywhere in it. The
-- first holder is chosen by an administrator in Control Center → Access Control
-- after release — see section 4, which states the reasoning, and section 5e,
-- which fails the migration if any employee grant exists when it finishes.
--
-- Forward-only. Every policy and function is replaced by name.

-- ═══ 1. Register the action ═════════════════════════════════════════════════
--
-- is_system = false: a custom action, the same shape as `assign`
-- (20260725000000) and Sample Tracking's dispatch / receive. Mirrors
-- src/lib/permissions/modules.ts, so `npm run permissions:check` stays clean.

INSERT INTO public.permission_actions (action_key, display_name, is_system)
VALUES ('manage_access_records', 'Manage Access Records', false)
ON CONFLICT (action_key) DO NOTHING;

INSERT INTO public.module_permission_actions (module_id, action_id, default_allowed)
SELECT pm.id, pa.id, false
FROM public.permission_modules pm
JOIN public.permission_actions pa ON pa.action_key = 'manage_access_records'
WHERE pm.module_key = 'assets_access'
ON CONFLICT (module_id, action_id) DO NOTHING;

INSERT INTO public.role_permissions (role, module_id, action_id, allowed)
SELECT 'admin', mpa.module_id, mpa.action_id, true
FROM public.module_permission_actions mpa
JOIN public.permission_modules pm ON pm.id = mpa.module_id
JOIN public.permission_actions  pa ON pa.id = mpa.action_id
WHERE pm.module_key = 'assets_access'
  AND pa.action_key = 'manage_access_records'
ON CONFLICT (role, module_id, action_id) DO NOTHING;

-- ═══ 2. The predicate ═══════════════════════════════════════════════════════
--
-- Written the same way as can_view_asset_inventory() (20260810000000):
-- SECURITY DEFINER because it reads permission tables the caller holds no
-- rights on, and `is_active` is part of the test so a deactivated account
-- reads nothing however its grants were left.
--
-- An ACTIVE admin passes unconditionally. That is the app-wide convention and
-- it is what makes requirement "an active admin retains access automatically"
-- true even if every permission row were deleted.

CREATE OR REPLACE FUNCTION public.can_manage_access_records()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
     WHERE id = auth.uid()
       AND is_active
       AND (role = 'admin'
            OR public.resolve_permission(auth.uid(), 'assets_access', 'manage_access_records'))
  );
$$;

COMMENT ON FUNCTION public.can_manage_access_records() IS
  'Admin, or an explicit assets_access.manage_access_records grant. Governs the '
  'Access Register only: read, add and edit access_records for every employee. '
  'Grants no asset authority and no Control Center authority.';

REVOKE EXECUTE ON FUNCTION public.can_manage_access_records() FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.can_manage_access_records() TO authenticated;

-- ═══ 3. access_records — the three administrative policies ══════════════════
--
-- Renamed off the "admin" prefix, exactly as 20260721000000 did for `assets`,
-- because they are no longer admin-only. The old names are dropped so
-- pg_policies shows one rule per command rather than a retired one beside a
-- new one.
--
-- Each is the previous rule with the role literal replaced by the predicate.
-- No branch is added or removed: same commands, same rows, same absence of a
-- DELETE policy.

DROP POLICY IF EXISTS "access_records_admin_select"  ON public.access_records;
DROP POLICY IF EXISTS "access_records_manage_select" ON public.access_records;

CREATE POLICY "access_records_manage_select" ON public.access_records
  FOR SELECT TO authenticated
  USING (public.can_manage_access_records());

DROP POLICY IF EXISTS "access_records_admin_insert"  ON public.access_records;
DROP POLICY IF EXISTS "access_records_manage_insert" ON public.access_records;

CREATE POLICY "access_records_manage_insert" ON public.access_records
  FOR INSERT TO authenticated
  WITH CHECK (public.can_manage_access_records());

DROP POLICY IF EXISTS "access_records_admin_update"  ON public.access_records;
DROP POLICY IF EXISTS "access_records_manage_update" ON public.access_records;

CREATE POLICY "access_records_manage_update" ON public.access_records
  FOR UPDATE TO authenticated
  USING     (public.can_manage_access_records())
  WITH CHECK(public.can_manage_access_records());

-- ═══ 4. THIS MIGRATION GRANTS THE CAPABILITY TO NOBODY ══════════════════════
--
-- There is no INSERT, UPDATE or DELETE on employee_permission_overrides here,
-- and no user id anywhere in this file. That is deliberate and it is the point
-- of the section: the migration DEFINES the permission and ENFORCES it, and who
-- holds it is an administrator's decision made in the product, not a fact
-- compiled into a schema change.
--
-- WHY NOT SEED THE FIRST HOLDER, WHEN OTHER MIGRATIONS HAVE
-- ---------------------------------------------------------
-- 20260903000000 and 20260723000000 both wrote employee overrides by user id.
-- Those were CORRECTIONS — a configuration that already existed in production
-- and had to be restated exactly. This is a NEW capability, so there is nothing
-- to restate, and a seeded grant would mean the permission arrived already
-- given to someone with no record of the decision in the place the business
-- reads such decisions.
--
-- It also keeps this file honest about a rollback: reverting the migration
-- removes an ability nobody was exercising, rather than silently revoking a
-- person's access.
--
-- HOW IT IS GRANTED INSTEAD
-- -------------------------
-- Control Center → Access Control → the employee → Assets & Access → Custom →
-- tick "Manage Access Records". The screen writes the employee_permission_
-- overrides row this migration deliberately does not, and ticking it brings
-- Module access with it (ACTION_DEPENDENCIES in src/lib/permissions/levels.ts,
-- because the RESTRICTIVE entry gate from 20260905000000 requires `view`).
--
-- Section 5 asserts the absence: not one employee, role or department rule may
-- grant this action when this migration finishes.

-- ═══ 5. Post-conditions ═════════════════════════════════════════════════════
--
-- Read-only. They fail the migration rather than let a half-applied state look
-- successful — the failure mode 20260723000000 exists to remember.

DO $$
DECLARE
  v_count int;
BEGIN
  -- 5a. The action is registered against Assets & Access, and DENIED by default.
  SELECT count(*) INTO v_count
  FROM public.module_permission_actions mpa
  JOIN public.permission_modules pm ON pm.id = mpa.module_id AND pm.module_key = 'assets_access'
  JOIN public.permission_actions  pa ON pa.id = mpa.action_id AND pa.action_key = 'manage_access_records'
  WHERE mpa.default_allowed = false;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'MANAGE_ACCESS_RECORDS: expected one denied-by-default registration, found %', v_count;
  END IF;

  -- 5b. It is registered against NO other module. One key, one module.
  SELECT count(*) INTO v_count
  FROM public.module_permission_actions mpa
  JOIN public.permission_modules pm ON pm.id = mpa.module_id
  JOIN public.permission_actions  pa ON pa.id = mpa.action_id AND pa.action_key = 'manage_access_records'
  WHERE pm.module_key <> 'assets_access';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'MANAGE_ACCESS_RECORDS: the action leaked onto % other module(s)', v_count;
  END IF;

  -- 5c. No role rule other than admin's. A manager title must not imply it.
  SELECT count(*) INTO v_count
  FROM public.role_permissions rp
  JOIN public.permission_modules pm ON pm.id = rp.module_id AND pm.module_key = 'assets_access'
  JOIN public.permission_actions  pa ON pa.id = rp.action_id AND pa.action_key = 'manage_access_records'
  WHERE rp.role <> 'admin' AND rp.allowed;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'MANAGE_ACCESS_RECORDS: % non-admin role rule(s) grant this action', v_count;
  END IF;

  -- 5d. No department rule either.
  SELECT count(*) INTO v_count
  FROM public.department_permissions dp
  JOIN public.permission_modules pm ON pm.id = dp.module_id AND pm.module_key = 'assets_access'
  JOIN public.permission_actions  pa ON pa.id = dp.action_id AND pa.action_key = 'manage_access_records'
  WHERE dp.allowed;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'MANAGE_ACCESS_RECORDS: % department rule(s) grant this action', v_count;
  END IF;

  -- 5e. NO EMPLOYEE HOLDS IT. This migration grants the capability to nobody;
  --     an administrator gives it out in Control Center afterwards. A grant
  --     appearing here would mean a user id had crept back into this file.
  SELECT count(*) INTO v_count
  FROM public.employee_permission_overrides eo
  JOIN public.permission_modules pm ON pm.id = eo.module_id AND pm.module_key = 'assets_access'
  JOIN public.permission_actions  pa ON pa.id = eo.action_id AND pa.action_key = 'manage_access_records'
  WHERE eo.allowed AND eo.revoked_at IS NULL;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'MANAGE_ACCESS_RECORDS: this migration must grant the action to nobody, '
                    'but % employee(s) hold it', v_count;
  END IF;

  -- 5f. access_records carries exactly the four policies it should, and still
  --     no DELETE policy for anyone.
  SELECT count(*) INTO v_count
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid AND c.relname = 'access_records'
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE p.polname IN ('access_records_own_select', 'access_records_manage_select',
                      'access_records_manage_insert', 'access_records_manage_update');
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'MANAGE_ACCESS_RECORDS: expected 4 named access_records policies, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid AND c.relname = 'access_records'
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE p.polcmd = 'd';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'MANAGE_ACCESS_RECORDS: access_records grew % DELETE policy(ies)', v_count;
  END IF;

  -- 5g. The module entry gate is still there and still RESTRICTIVE. Without it
  --     this grant would not require module entry.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid AND c.relname = 'access_records'
    WHERE p.polname = 'access_records_module_entry_gate' AND NOT p.polpermissive
  ) THEN
    RAISE EXCEPTION 'MANAGE_ACCESS_RECORDS: the RESTRICTIVE module entry gate on access_records is missing';
  END IF;

  RAISE NOTICE 'MANAGE_ACCESS_RECORDS: all post-conditions passed';
END $$;
