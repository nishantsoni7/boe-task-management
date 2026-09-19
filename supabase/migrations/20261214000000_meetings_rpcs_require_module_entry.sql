-- Meetings — every write RPC requires Meetings module entry.
--
-- THE DEFECT
-- ----------
-- 20260905000000 made Meetings 'view' the parent gate of the module with a
-- RESTRICTIVE module_entry_open('meetings') policy on every meeting table. That
-- reaches table reads and table writes. It does not reach a SECURITY DEFINER
-- function, which runs as its owner with RLS bypassed.
--
-- Every Meetings write RPC authorizes through public.assert_meeting_editor(),
-- which asks public.can_edit_meeting() (both 20260814000000). Neither checks
-- module entry. So a user whose Meetings 'view' has been taken away
-- (employee_permission_overrides allowed = false) still WROTE through
--
--   add_meeting_order                save_meeting_order_update
--   remove_meeting_order             add_meeting_order_item
--   save_meeting_item_update         link_meeting_item_task
--   set_meeting_status               import_meeting_rows
--   set_meeting_item_image_path      add_meeting_order_evidence
--
-- when they were the meeting's lead or creator, or held Meetings 'edit' or
-- 'manage' — while every direct read of the same tables returned nothing.
--
-- THE FIX
-- -------
-- The two shared guards are re-emitted with module entry added. Every RPC above
-- calls assert_meeting_editor(), so no caller is re-emitted:
--
--   * assert_meeting_editor() refuses FIRST, straight after authentication and
--     before the meeting is looked up, so a refused caller cannot learn whether
--     the meeting exists or is completed. set_meeting_status() passes
--     p_allow_completed = true and is covered by the same line.
--   * can_edit_meeting() answers false without module entry, so the predicate
--     and the guard never disagree, and any later definer function that asks the
--     predicate directly inherits the rule.
--
-- module_entry_open() reads auth.uid() — the CALLER. Every caller of
-- can_edit_meeting() in the repository passes auth.uid() as p_user_id (the RLS
-- policies, the storage policies, and assert_meeting_editor()). Where p_user_id
-- is somebody else, the added condition can only narrow the answer, never widen
-- it.
--
-- The refusal is the sentence PR #164's discussion RPCs use
-- ('MEETING_FORBIDDEN: You do not have access to Meetings', 42501). The prefix
-- is already in src/lib/meetings/errors.ts GUARD_PREFIXES, so the reader sees
-- "You do not have access to Meetings." and no application change is needed.
--
-- DELIBERATELY UNCHANGED
-- ----------------------
--   * can_view_meeting(uuid, uuid) — a boolean predicate that writes nothing.
--     Every table and storage read that uses it already sits behind the
--     RESTRICTIVE module entry gate, and it runs per row on the child tables'
--     SELECT policies, where a second permission resolution per row is a cost
--     with no protection gained.
--   * meeting_evidence_path_recorded(text) — a boolean predicate whose only
--     consumer is the storage DELETE policy. Making it answer false without
--     entry would turn that policy's `NOT ...` into a yes.
--   * Signatures, defaults, volatility, owner, search_path and grants — both
--     functions keep exactly one overload each (no PGRST203).
--
-- DATA IMPACT
--   None. Two function bodies. No table, row, policy or permission is touched.
--
-- ROLLBACK / CORRECTIVE FORWARD
--   Forward-only. Re-emitting the 20260814000000 definitions reopens the defect;
--   do not do that. A correction re-emits these two functions again.

-- ═══ 1. can_edit_meeting — module entry added ══════════════════════════════

CREATE OR REPLACE FUNCTION public.can_edit_meeting(
  p_meeting_id      uuid,
  p_user_id         uuid    DEFAULT auth.uid(),
  p_allow_completed boolean DEFAULT false
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  -- Meetings module entry for the CALLER (module_entry_open reads auth.uid()).
  -- Without it, being the lead or creator, or holding edit / manage, is not
  -- enough (20261214000000).
  SELECT p_user_id IS NOT NULL AND public.module_entry_open('meetings') AND EXISTS (
    SELECT 1
    FROM public.meetings m
    JOIN public.users u ON u.id = p_user_id AND u.is_active
    WHERE m.id = p_meeting_id
      AND (p_allow_completed OR m.status <> 'completed')
      AND (
        u.role = 'admin'
        OR m.lead_id    = p_user_id
        OR m.created_by = p_user_id
        OR public.resolve_permission(p_user_id, 'meetings', 'edit')
        OR public.resolve_permission(p_user_id, 'meetings', 'manage')
      )
  );
$$;

REVOKE EXECUTE ON FUNCTION public.can_edit_meeting(uuid, uuid, boolean) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.can_edit_meeting(uuid, uuid, boolean) TO authenticated;

-- ═══ 2. assert_meeting_editor — module entry refused first ═════════════════

CREATE OR REPLACE FUNCTION public.assert_meeting_editor(
  p_meeting_id      uuid,
  p_allow_completed boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  -- Before the meeting is looked up: a caller outside the module learns nothing
  -- about it, not even whether it exists or is completed (20261214000000).
  IF NOT public.module_entry_open('meetings') THEN
    RAISE EXCEPTION 'MEETING_FORBIDDEN: You do not have access to Meetings'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.meetings WHERE id = p_meeting_id) THEN
    RAISE EXCEPTION 'MEETING_MISSING: This meeting no longer exists' USING ERRCODE = '42501';
  END IF;

  IF NOT p_allow_completed
     AND EXISTS (SELECT 1 FROM public.meetings WHERE id = p_meeting_id AND status = 'completed') THEN
    RAISE EXCEPTION 'MEETING_COMPLETED: This meeting is completed and is now read-only. Reopen it to make a correction.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.can_edit_meeting(p_meeting_id, v_uid, p_allow_completed) THEN
    RAISE EXCEPTION 'MEETING_FORBIDDEN: You do not have permission to change this meeting'
      USING ERRCODE = '42501';
  END IF;

  RETURN v_uid;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.assert_meeting_editor(uuid, boolean) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.assert_meeting_editor(uuid, boolean) TO authenticated;

-- ═══ 3. Assertions ═════════════════════════════════════════════════════════
--
-- Read-only, and executed on apply: if any of this is not true the migration
-- rolls back.

DO $$
DECLARE
  v_def  text;
  v_fn   text;
  v_bad  text;
BEGIN
  -- One overload each. A second one would make PostgREST refuse every call
  -- (PGRST203) and leave the old body reachable.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'can_edit_meeting') <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'assert_meeting_editor') <> 1 THEN
    RAISE EXCEPTION 'can_edit_meeting / assert_meeting_editor must each have exactly one overload';
  END IF;

  -- Still definer functions with a pinned search_path.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
  FROM pg_proc p
  WHERE p.oid IN ('public.can_edit_meeting(uuid,uuid,boolean)'::regprocedure,
                  'public.assert_meeting_editor(uuid,boolean)'::regprocedure)
    AND (NOT p.prosecdef
         OR NOT COALESCE(p.proconfig::text LIKE '%search_path=public, pg_temp%', false));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'lost SECURITY DEFINER or its pinned search_path: %', v_bad;
  END IF;

  v_def := pg_get_functiondef('public.can_edit_meeting(uuid,uuid,boolean)'::regprocedure);
  IF v_def NOT LIKE '%public.module_entry_open(''meetings'')%' THEN
    RAISE EXCEPTION 'can_edit_meeting does not require Meetings module entry';
  END IF;

  -- The entry refusal comes before the meeting is looked up.
  v_def := pg_get_functiondef('public.assert_meeting_editor(uuid,boolean)'::regprocedure);
  IF strpos(v_def, 'IF NOT public.module_entry_open(''meetings'') THEN') = 0
     OR strpos(v_def, 'MEETING_FORBIDDEN: You do not have access to Meetings') = 0 THEN
    RAISE EXCEPTION 'assert_meeting_editor does not refuse a caller without Meetings module entry';
  END IF;
  IF strpos(v_def, 'IF NOT public.module_entry_open(''meetings'') THEN') > strpos(v_def, 'MEETING_MISSING:') THEN
    RAISE EXCEPTION 'assert_meeting_editor looks the meeting up before checking module entry';
  END IF;

  -- Grants: signed-in users only.
  IF NOT has_function_privilege('authenticated', 'public.can_edit_meeting(uuid,uuid,boolean)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.assert_meeting_editor(uuid,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.can_edit_meeting(uuid,uuid,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.assert_meeting_editor(uuid,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'can_edit_meeting / assert_meeting_editor grants changed';
  END IF;

  -- Every write RPC this fix relies on still authorizes through the guard.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.add_meeting_order(uuid,text,text,text,date,text)',
    'public.save_meeting_order_update(uuid,text,text,date,text,text,date,boolean)',
    'public.remove_meeting_order(uuid)',
    'public.add_meeting_order_item(uuid,text,text,numeric,text,text,text,text,text,date,text,text,text)',
    'public.save_meeting_item_update(uuid,text,text,date,text,text,text,boolean,boolean)',
    'public.link_meeting_item_task(uuid,uuid)',
    'public.set_meeting_status(uuid,text)',
    'public.import_meeting_rows(uuid,jsonb)',
    'public.set_meeting_item_image_path(uuid,text)',
    'public.add_meeting_order_evidence(uuid,text,text)'
  ] LOOP
    IF pg_get_functiondef(v_fn::regprocedure) NOT LIKE '%public.assert_meeting_editor(%' THEN
      RAISE EXCEPTION '% no longer authorizes through assert_meeting_editor', v_fn;
    END IF;
  END LOOP;
END $$;
