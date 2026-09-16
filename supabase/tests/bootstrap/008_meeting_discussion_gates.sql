-- ═════════════════════════════════════════════════════════════════════════════
-- TEST-ONLY — the Meetings module entry gates from 20260905000000 §2
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THIS FILE MUST NEVER ENTER supabase/migrations, AND MUST NEVER DEPLOY.
--
-- 20260905000000 creates one RESTRICTIVE gate per module table from a map of
-- seven modules, then asserts exactly 27 exist — which a Meetings-only chain can
-- never satisfy. This reproduces the 'meetings' entry of that map with the
-- migration's own statement shape, so the six tables carry the gate they carry in
-- production. See 007_meeting_discussion_stubs.sql for module_entry_open().

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'meetings', 'meeting_attendees', 'meeting_orders', 'meeting_order_items',
    'meeting_activity_log', 'meeting_update_history'
  ] LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      v_table || '_module_entry_gate', v_table
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
      'USING (public.module_entry_open(%L)) WITH CHECK (public.module_entry_open(%L))',
      v_table || '_module_entry_gate', v_table, 'meetings', 'meetings'
    );
  END LOOP;
END $$;
