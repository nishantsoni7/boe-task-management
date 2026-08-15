-- Parent `view` gates in the database, for the remaining permission-engine
-- modules. The Sample Tracking equivalent is 20260904000000.
--
-- THE RULE
-- --------
-- For a non-admin, effective module `view` must be true before ANY existing
-- ownership, assignment, participant, view_all or child-action rule can grant
-- SELECT, INSERT, UPDATE or DELETE on that module's tables.
--
-- HOW: RESTRICTIVE POLICIES, NOT REWRITES
-- ---------------------------------------
-- 20260904000000 rewrote each Sample Tracking policy to carry the gate inline.
-- That was right for eleven policies on one table; it is the wrong instrument
-- for ~90 policies across 27 tables, where every rewrite is a chance to alter a
-- rule by accident.
--
-- PostgreSQL's RESTRICTIVE policies express exactly this. A restrictive policy
-- is AND-ed with the OR of every permissive policy on the table, so:
--
--   * every existing rule keeps its precise meaning — none is edited or dropped;
--   * no child action, ownership branch or view_all grant can route around it;
--   * a permissive policy added later is gated automatically, which an inline
--     rewrite would not achieve.
--
-- WHAT IS DELIBERATELY NOT GATED
-- ------------------------------
--   employee_records  `users` is read by every module in the product (every
--                     full_name join in tasks, orders, meetings, finance and
--                     samples). Gating it on employee_records:view would close
--                     the whole application to all 20 non-admins, none of whom
--                     hold that grant. Its own admin-role policies already stand.
--   showroom_qr       showroom_products / _categories / _inquiries / _inquiry_items
--                     back the PUBLIC customer QR pages as well as the admin
--                     screens. A restrictive policy TO authenticated would not
--                     touch anon, but it would close the public catalogue to any
--                     signed-in employee browsing it. Splitting the public and
--                     administrative surfaces is a product change, not a gate.
--   performance       performance_app_opens and daily_work_logs are self-service
--                     EOD records every employee writes about themselves. Only
--                     1 of 20 non-admins holds performance:view, so gating would
--                     stop EOD logging for 19 people. The module's screens are
--                     already gated in the app; its data is not module data in
--                     the same sense.
--
-- Those three are recorded here rather than half-implemented. Each needs a
-- product decision, not a policy.
--
-- SCOPE
-- -----
-- Additive and idempotent. Creates one function and one restrictive policy per
-- table. No existing policy is dropped, edited or reordered. No grant, override,
-- role or department row is touched. No table, column, index or trigger changes.
--
-- NOT APPLIED BY THIS BRANCH. Deploy order is in the branch report; the
-- frontend gates (PR #25) are already live, so this is additive to them.

-- ── 1. The gate ─────────────────────────────────────────────────────────────
--
-- One parameterised function rather than one per module. STABLE, so PostgreSQL
-- forbids it from writing; SECURITY DEFINER for the same reason
-- resolve_permission is — it must read permission tables the caller's own RLS
-- would hide. Fully schema-qualified, so search_path cannot redirect it.
--
-- The admin branch mirrors sample_tracking_module_open(). It is redundant
-- (role_permissions grants every action to 'admin', seeded by 20260660) and is
-- kept anyway so no permission-table edit can lock an administrator out.

CREATE OR REPLACE FUNCTION public.module_entry_open(p_module_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid()
        AND u.role = 'admin'
    )
    OR public.resolve_permission(auth.uid(), p_module_key, 'view');
$$;

COMMENT ON FUNCTION public.module_entry_open(text) IS
  'Parent authorization gate: admin, or effective <module>:view. Used as a RESTRICTIVE '
  'policy so ownership, assignment, view_all and child-action rules are only reached '
  'once module entry passes.';

-- ── 2. The gates, one per module data table ─────────────────────────────────
--
-- FOR ALL with both USING and WITH CHECK covers all four commands: SELECT and
-- DELETE consult USING, INSERT consults WITH CHECK, UPDATE consults both.
--
-- TO authenticated only. `anon` is untouched (no public surface exists on these
-- tables), and the service role bypasses RLS entirely, so the API routes that
-- legitimately act for the system are unaffected.

DO $$
DECLARE
  v_module text;
  v_table  text;
  v_tables text[];
  v_map    jsonb := jsonb_build_object(
    'task_management', jsonb_build_array(
      'tasks', 'task_attachments', 'task_activity_log', 'user_top_tasks'
    ),
    'assets_access', jsonb_build_array(
      'assets', 'employee_assets', 'access_records', 'asset_documents',
      'asset_change_requests', 'asset_activity_log', 'asset_service_records',
      'asset_transfers'
    ),
    'meetings', jsonb_build_array(
      'meetings', 'meeting_attendees', 'meeting_orders', 'meeting_order_items',
      'meeting_activity_log', 'meeting_update_history'
    ),
    'orders', jsonb_build_array(
      'orders', 'order_activity_log', 'order_requests', 'order_request_activity',
      'order_request_attachments', 'order_change_requests'
    ),
    'finance', jsonb_build_array(
      'finance_payment_requests', 'finance_payment_request_activity_log',
      'payment_proof_attachments'
    )
  );
BEGIN
  FOR v_module IN SELECT jsonb_object_keys(v_map) LOOP
    SELECT array_agg(value::text) INTO v_tables
    FROM jsonb_array_elements_text(v_map -> v_module) AS value;

    FOREACH v_table IN ARRAY v_tables LOOP
      -- A table this deployment does not have is skipped rather than faked.
      -- Reported by the assertion block below.
      IF to_regclass('public.' || quote_ident(v_table)) IS NULL THEN
        RAISE NOTICE 'skipping missing table %', v_table;
        CONTINUE;
      END IF;

      EXECUTE format(
        'DROP POLICY IF EXISTS %I ON public.%I',
        v_table || '_module_entry_gate', v_table
      );

      EXECUTE format(
        'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
        'USING (public.module_entry_open(%L)) WITH CHECK (public.module_entry_open(%L))',
        v_table || '_module_entry_gate', v_table, v_module, v_module
      );
    END LOOP;
  END LOOP;
END $$;

-- ── 3. Assertions ───────────────────────────────────────────────────────────
--
-- Read-only. They fail the migration rather than let a partially applied gate
-- look successful — the failure mode 20260723000000 exists to remember.

DO $$
DECLARE
  v_expected int := 27;
  v_actual   int;
  v_bad      text;
BEGIN
  SELECT count(*) INTO v_actual
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND p.polname = c.relname || '_module_entry_gate';

  IF v_actual <> v_expected THEN
    RAISE EXCEPTION 'Expected % module entry gates, found %', v_expected, v_actual;
  END IF;

  -- Every gate must be RESTRICTIVE. A permissive one would be OR-ed with the
  -- existing rules and would therefore GRANT access rather than restrict it —
  -- the single most dangerous way this migration could be wrong.
  SELECT string_agg(p.polname, ', ') INTO v_bad
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  WHERE p.polname = c.relname || '_module_entry_gate'
    AND p.polpermissive;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'These gates are PERMISSIVE and would grant access: %', v_bad;
  END IF;

  -- Every gate must resolve the parent action, and cover all four commands.
  SELECT string_agg(p.polname, ', ') INTO v_bad
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  WHERE p.polname = c.relname || '_module_entry_gate'
    AND (
      coalesce(pg_get_expr(p.polqual, p.polrelid), '') NOT LIKE '%module_entry_open%'
      OR coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') NOT LIKE '%module_entry_open%'
      OR p.polcmd <> '*'
    );

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'These gates are incomplete: %', v_bad;
  END IF;

  -- The three deliberately ungated modules must stay ungated: a future edit
  -- that quietly adds them here would close the product for most employees.
  SELECT string_agg(c.relname, ', ') INTO v_bad
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  WHERE p.polname = c.relname || '_module_entry_gate'
    AND c.relname IN (
      'users', 'positions',
      'showroom_products', 'showroom_categories', 'showroom_inquiries', 'showroom_inquiry_items',
      'performance_app_opens', 'daily_work_logs'
    );

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'These tables must NOT be gated without a product decision: %', v_bad;
  END IF;
END $$;
