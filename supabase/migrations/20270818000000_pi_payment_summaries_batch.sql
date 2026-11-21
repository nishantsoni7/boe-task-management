-- PI payment summaries for many PIs in one call.
--
-- WHY THIS EXISTS. The approver's "New PIs to approve" card draws a payment chip on each PI row, taken
-- from pi_submission_payment_summary(uuid), which answers for ONE PI. The Orders page called it once per
-- row: up to 12 requests side by side, from a browser in India to a database in Tokyo, in the last round
-- before the card can draw. Each extra simultaneous call finishes about 70 ms later (CHANGELOG 2026-10-22),
-- so the chips were the widest round on the page. This answers for all of them in one call.
--
-- THE RULE IS NOT COPIED. It calls pi_submission_payment_summary(uuid) once per id, so every answer is the
-- one that function gives, whatever its text is now or later becomes (it has been re-emitted three times).
-- Nothing about payments, percentages or the PI decision is decided here.
--
-- ACCESS. SECURITY INVOKER: this function touches no table. Each id goes through the single function, which
-- is SECURITY DEFINER, requires authentication and refuses a PI the caller may not view
-- (can_view_order_submission, errcode 42501). Here that refusal yields NO row for that id, like
-- pi_submissions_advance_percent: not a zero and not a null, so nothing is disclosed about a PI the caller
-- cannot open. Any OTHER error is not swallowed: the whole call fails and the screen asks per PI, as it did.
--
-- Bounded: at most 50 ids per call, so it cannot be used as a bulk probe. One answer per distinct id, in the
-- order the ids were first given.
--
-- Read-only; no table, column or policy changes. Rollback:
--   drop function public.pi_submissions_payment_summaries(uuid[]);

create or replace function public.pi_submissions_payment_summaries(p_submission_ids uuid[])
returns table (submission_id uuid, summary jsonb)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if coalesce(array_length(p_submission_ids, 1), 0) > 50 then
    raise exception 'TOO_MANY_SUBMISSIONS: at most 50 PIs per call.' using errcode = '22023';
  end if;

  for v_id in
    select d.id
    from (
      select u.id, min(u.ord) as ord
      from unnest(p_submission_ids) with ordinality as u(id, ord)
      group by u.id
    ) d
    order by d.ord
  loop
    begin
      submission_id := v_id;
      summary := public.pi_submission_payment_summary(v_id);
      return next;
    exception when insufficient_privilege then
      -- 42501: a PI this caller may not view (or no such PI). No row for it.
      null;
    end;
  end loop;
end;
$$;

comment on function public.pi_submissions_payment_summaries(uuid[]) is
  'pi_submission_payment_summary() for each of up to 50 PIs in one call: one row (submission_id, summary) per distinct id the caller may view, in the order first given; an id the caller may not view returns no row. Calls the single-PI function, so every summary is exactly its answer.';

revoke execute on function public.pi_submissions_payment_summaries(uuid[]) from public, anon;
grant  execute on function public.pi_submissions_payment_summaries(uuid[]) to authenticated;
