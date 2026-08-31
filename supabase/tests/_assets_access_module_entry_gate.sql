-- ═════════════════════════════════════════════════════════════════════════════
-- TEST-ONLY — the module entry gate, scoped to Assets & Access
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THIS FILE MUST NEVER ENTER supabase/migrations, AND MUST NEVER DEPLOY.
--
-- WHY IT EXISTS
-- -------------
-- 20261028000000 requires the RESTRICTIVE `access_records_module_entry_gate`
-- from 20260905000000 to be present: that gate is what makes the delegated
-- Access Register grant still depend on module entry, and the migration's own
-- post-conditions refuse to pass without it.
--
-- 20260905000000 CANNOT be applied to the scoped test database. It gates 27
-- tables across five modules and asserts that it created exactly 27 gates; a
-- database built from the Assets & Access chain alone holds 8 of those tables,
-- so the real file would raise "Expected 27 module entry gates, found 8" — a
-- correct refusal by a migration that is doing its job, and not something to
-- edit around.
--
-- So this file lays down the SAME gate for the SAME eight tables, and nothing
-- else. Both statements below are quoted verbatim from 20260905000000 — the
-- function body from its section 1, the policy shape from the format() call in
-- its section 2 — so what the test exercises is the real rule and not a
-- paraphrase of it.
--
-- WHAT THIS IS NOT
-- ----------------
-- It is not evidence about the other 19 gates, about the migration's own
-- assertion block, or about any module other than Assets & Access. It proves
-- exactly one thing: that on a database where access_records carries the real
-- gate, the delegation migration's policies behave as claimed.

-- ── The gate function, verbatim from 20260905000000 §1 ──────────────────────

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

-- ── The gate itself, on the eight assets_access tables ──────────────────────
--
-- Same list 20260905000000 §2 carries for 'assets_access', same skip-if-missing
-- behaviour, same RESTRICTIVE FOR ALL shape with both USING and WITH CHECK.

DO $$
DECLARE
  v_table  text;
  v_tables text[] := ARRAY[
    'assets', 'employee_assets', 'access_records', 'asset_documents',
    'asset_change_requests', 'asset_activity_log', 'asset_service_records',
    'asset_transfers'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
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
      v_table || '_module_entry_gate', v_table, 'assets_access', 'assets_access'
    );
  END LOOP;
END $$;

-- ── Assertions, in the shape 20260905000000 §3 uses ─────────────────────────

DO $$
DECLARE
  v_count int;
  v_bad   text;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND p.polname = c.relname || '_module_entry_gate';
  IF v_count <> 8 THEN
    RAISE EXCEPTION 'TEST GATE: expected 8 Assets & Access entry gates, found %', v_count;
  END IF;

  -- Every gate must be RESTRICTIVE. A permissive one would be OR-ed with the
  -- existing rules and would therefore GRANT access rather than restrict it.
  SELECT string_agg(p.polname, ', ') INTO v_bad
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  WHERE p.polname = c.relname || '_module_entry_gate'
    AND p.polpermissive;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'TEST GATE: these gates are PERMISSIVE and must not be: %', v_bad;
  END IF;

  RAISE NOTICE 'TEST GATE: 8 restrictive Assets & Access entry gates in place';
END $$;
