-- Meetings — fix: no meeting could be created at all.
--
-- THE DEFECT
-- ----------
-- 20260814000000 gave public.meetings this SELECT policy:
--
--     USING (public.can_view_meeting(id, auth.uid()))
--
-- can_view_meeting() is SECURITY DEFINER **STABLE**, and it answers the
-- question by re-querying public.meetings for that id.
--
-- A STABLE function sees the snapshot taken at the start of the statement. For
-- the row an INSERT is currently creating, that snapshot does not contain the
-- row — so the function returns false for it.
--
-- PostgreSQL applies the SELECT policy to `INSERT ... RETURNING`. The
-- application creates a meeting with
--
--     .insert({ ... }).select('id').single()
--
-- which is exactly `INSERT ... RETURNING id`. The insert itself passed
-- meetings_insert; the RETURNING clause then failed the SELECT policy, and
-- PostgREST returned 403 with "new row violates row-level security policy for
-- table meetings".
--
-- Effect in production: **creating a meeting was impossible for everyone,
-- including admins.** Verified live — the same INSERT succeeds when RETURNING
-- is removed and fails when it is present.
--
-- Nothing else was affected. Every other write in this module goes through a
-- SECURITY DEFINER function, which bypasses RLS entirely, and the one other
-- client INSERT (meeting_attendees) does not use RETURNING.
--
-- THE FIX
-- -------
-- A row-level policy already has the row in hand. Re-reading the table it is
-- filtering was redundant as well as wrong, so the predicate is inlined against
-- the row's own columns. This is the same rule as can_view_meeting(), stated
-- directly:
--
--   * the lead or the creator,
--   * anyone who attended,
--   * an admin, or someone holding meetings.manage.
--
-- It is also cheaper: one fewer correlated subquery against public.meetings for
-- every row the policy tests.
--
-- can_view_meeting() is KEPT and unchanged. The child tables
-- (meeting_orders, meeting_order_items, meeting_update_history,
-- meeting_activity_log) call it about their PARENT meeting, which already
-- exists in the snapshot by the time those rows are read — the STABLE snapshot
-- is correct there, and inlining it into four more policies would duplicate the
-- visibility rule five times over.

DROP POLICY IF EXISTS "meetings_select" ON public.meetings;

CREATE POLICY "meetings_select" ON public.meetings
  FOR SELECT TO authenticated
  USING (
    lead_id    = auth.uid()
    OR created_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.meeting_attendees a
      WHERE a.meeting_id = meetings.id
        AND a.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid()
        AND u.is_active
        AND u.role = 'admin'
    )
    OR public.resolve_permission(auth.uid(), 'meetings', 'manage')
  );

COMMENT ON POLICY "meetings_select" ON public.meetings IS
  'Visible to the lead, the creator, any attendee, an admin, or a meetings.manage holder. Stated against the row''s own columns rather than via can_view_meeting(): that function is STABLE and re-reads public.meetings, so it returned false for the row an INSERT ... RETURNING was creating and made meeting creation impossible (20260815000000).';
