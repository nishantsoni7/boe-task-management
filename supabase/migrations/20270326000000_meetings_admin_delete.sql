-- Meetings — an administrator may permanently delete ANY meeting with all its data.
--
-- WHY. Dummy / test meetings pile up. Today nothing can remove one that has an order or
-- a discussion in it (meetings_prevent_delete_with_content / _with_discussion refuse, and
-- meeting_order_evidence.meeting_id has no cascade), by design: those guards protect real
-- records from an editor. An administrator needs one deliberate door around them.
--
-- WHAT THIS ADDS
--   meeting_deletion_audit            one row per administrator deletion (who, what, counts)
--   admin_delete_meeting(uuid)        Admin only. Deletes the meeting and everything inside it,
--                                     returns the counts and the storage paths now unreferenced
--   meetings_prevent_delete_with_content() / _with_discussion()  re-created with the same
--                                     bodies plus one bypass: a transaction-local marker naming
--                                     this meeting, set only by admin_delete_meeting() after it
--                                     checked the caller. Clients hold no way to set it.
--
-- WHAT GOES: the meeting, attendees, orders and SKU lines, update history, activity log,
-- evidence rows, this meeting's discussion appearances and its per-meeting trail rows
-- (update / added_to_agenda / carried_forward).
-- WHAT STAYS: tasks (the link on the SKU line goes with the line; the task is untouched),
-- discussion ISSUES (they live across meetings; an open issue with no appearance is the
-- Inbox, so one that only lived here simply returns there), and the issue-level trail rows
-- (captured / task_linked / resolved / reopened), whose meeting_id becomes NULL.
-- STORAGE FILES are removed by the API route after this commits, using the paths returned
-- here (a product photo is only returned when no other meeting line still references it).
--
-- PRODUCTION SAFETY. One table and one function are added; two trigger functions are
-- re-created with unchanged behaviour for everyone but the marked deletion. Re-runnable.
--
-- ROLLBACK
--   drop function if exists public.admin_delete_meeting(uuid);
--   drop table if exists public.meeting_deletion_audit;
--   -- then re-apply 20260814000000 (§meetings_prevent_delete_with_content) and
--   -- 20261213000000 §17b for the previous trigger bodies.
--   -- Meetings already deleted stay deleted; the audit table records them.

-- ═══ 1. Audit ═════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.meeting_deletion_audit (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id    uuid        NOT NULL,
  title         text        NOT NULL,
  meeting_type  text        NOT NULL,
  meeting_date  date        NOT NULL,
  status        text        NOT NULL,
  counts        jsonb       NOT NULL,
  deleted_by    uuid        NOT NULL REFERENCES public.users(id),
  deleted_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.meeting_deletion_audit IS
  'One row per administrator deletion of a meeting (admin_delete_meeting). Written only by that function; no client role holds INSERT, UPDATE or DELETE.';

ALTER TABLE public.meeting_deletion_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "meeting_deletion_audit_admin_select" ON public.meeting_deletion_audit;
CREATE POLICY "meeting_deletion_audit_admin_select" ON public.meeting_deletion_audit
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid() AND u.role::text = 'admin' AND u.is_active
  ));

REVOKE ALL ON public.meeting_deletion_audit FROM anon, authenticated;
GRANT SELECT ON public.meeting_deletion_audit TO authenticated;

-- ═══ 2. The two refusals gain one marked exception ════════════════════════

CREATE OR REPLACE FUNCTION public.meetings_prevent_delete_with_content()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_setting('app.admin_deleting_meeting', true) = OLD.id::text THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM public.meeting_orders WHERE meeting_id = OLD.id) THEN
    RAISE EXCEPTION 'MEETING_HAS_CONTENT: This meeting already has orders under review and cannot be deleted'
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.meetings_prevent_delete_with_discussion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_setting('app.admin_deleting_meeting', true) = OLD.id::text THEN
    RETURN OLD;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.meeting_discussion_appearances a
    WHERE a.meeting_id = OLD.id
      AND (
        a.placement <> 'automatic'
        OR a.latest_update    IS NOT NULL
        OR a.decision         IS NOT NULL
        OR a.next_review_date IS NOT NULL
        OR a.discussed_at     IS NOT NULL
        OR a.meeting_order_id IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM public.meeting_order_evidence ev
          WHERE ev.discussion_appearance_id = a.id
        )
        OR EXISTS (
          SELECT 1 FROM public.meeting_discussion_events e
          WHERE e.appearance_id = a.id
            AND e.event_type IN ('update', 'task_linked', 'resolved', 'reopened')
        )
      )
  ) OR EXISTS (
    SELECT 1 FROM public.meeting_discussion_events e
    WHERE e.meeting_id = OLD.id
      AND e.event_type IN ('update', 'task_linked', 'resolved', 'reopened')
  ) THEN
    RAISE EXCEPTION 'MEETING_HAS_DISCUSSION: Issues have already been discussed in this meeting, so it cannot be deleted'
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;

-- ═══ 3. The administrator's delete ════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.admin_delete_meeting(p_meeting_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_meeting   public.meetings;
  v_counts    jsonb;
  v_evidence  text[];
  v_images    text[];
  v_orphans   text[];
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = v_uid AND u.role::text = 'admin' AND u.is_active
      AND coalesce(u.is_deleted, false) = false
  ) THEN
    RAISE EXCEPTION 'MEETING_FORBIDDEN: Only an administrator can delete a meeting'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_meeting FROM public.meetings WHERE id = p_meeting_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_NOT_FOUND: This meeting no longer exists'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT coalesce(array_agg(storage_path), '{}') INTO v_evidence
    FROM public.meeting_order_evidence WHERE meeting_id = p_meeting_id;

  SELECT coalesce(array_agg(DISTINCT i.image_path), '{}') INTO v_images
    FROM public.meeting_order_items i
    JOIN public.meeting_orders o ON o.id = i.meeting_order_id
   WHERE o.meeting_id = p_meeting_id AND i.image_path IS NOT NULL;

  v_counts := jsonb_build_object(
    'orders',    (SELECT count(*) FROM public.meeting_orders WHERE meeting_id = p_meeting_id),
    'items',     (SELECT count(*) FROM public.meeting_order_items i
                    JOIN public.meeting_orders o ON o.id = i.meeting_order_id
                   WHERE o.meeting_id = p_meeting_id),
    'updates',   (SELECT count(*) FROM public.meeting_update_history WHERE meeting_id = p_meeting_id),
    'evidence',  coalesce(array_length(v_evidence, 1), 0),
    'attendees', (SELECT count(*) FROM public.meeting_attendees WHERE meeting_id = p_meeting_id),
    'issues',    (SELECT count(*) FROM public.meeting_discussion_appearances WHERE meeting_id = p_meeting_id)
  );

  PERFORM set_config('app.admin_deleting_meeting', p_meeting_id::text, true);

  DELETE FROM public.meeting_order_evidence WHERE meeting_id = p_meeting_id;

  DELETE FROM public.meeting_discussion_events
   WHERE meeting_id = p_meeting_id
     AND event_type IN ('update', 'added_to_agenda', 'carried_forward');

  DELETE FROM public.meetings WHERE id = p_meeting_id;

  PERFORM set_config('app.admin_deleting_meeting', '', true);

  -- A product photo may be shared by another meeting's line: only the unreferenced go.
  SELECT coalesce(array_agg(p), '{}') INTO v_orphans
    FROM unnest(v_images) AS p
   WHERE NOT EXISTS (SELECT 1 FROM public.meeting_order_items i WHERE i.image_path = p);

  INSERT INTO public.meeting_deletion_audit (
    meeting_id, title, meeting_type, meeting_date, status, counts, deleted_by
  ) VALUES (
    v_meeting.id, v_meeting.title, v_meeting.meeting_type, v_meeting.meeting_date,
    v_meeting.status, v_counts, v_uid
  );

  RETURN jsonb_build_object(
    'counts',         v_counts,
    'evidence_paths', to_jsonb(v_evidence),
    'image_paths',    to_jsonb(v_orphans)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_delete_meeting(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.admin_delete_meeting(uuid) TO authenticated;
