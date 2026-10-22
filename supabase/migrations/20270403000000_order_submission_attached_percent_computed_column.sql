-- PI Drafts list: the advance percentage as a column of the same read.
--
-- WHY. The list read the rows, and only then asked pi_submissions_advance_percent() for
-- the percentages of THOSE ids: two dependent round trips (about 230 ms each on the
-- live site) before the first row could print its Advance %. A PostgREST "computed
-- column" lets the same select ask for the figure by name:
--
--     select id, status, ..., attached_percent from order_submissions
--
-- so the rows and their percentages arrive in ONE round trip.
--
-- THE RULE IS NOT COPIED A THIRD TIME. This function calls the batch function from
-- 20270327000000, which mirrors pi_submission_payment_summary(); so the percentage is
-- by construction the one the PI detail page's payment card shows, and the batch
-- function still decides who may see what: it returns no row for a PI the caller may
-- not view (can_view_order_submission), so this returns NULL for it.
--
-- ACCESS. SECURITY DEFINER because the batch function reads the finance tables on the
-- caller's behalf; the row handed in is one the caller's own select (RLS) already
-- returned, and the batch function checks visibility again. Not callable by anon.
--
-- Read-only; no table, column or policy changes. Rollback:
--   drop function public.attached_percent(public.order_submissions);

create or replace function public.attached_percent(p_submission public.order_submissions)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.attached_percent
    from public.pi_submissions_advance_percent(array[p_submission.id]) p
   limit 1
$$;

comment on function public.attached_percent(public.order_submissions) is
  'Advance % received for one PI row (verified + awaiting verification, of Total before GST, truncated to 2 dp), selectable as a column of order_submissions. Calls pi_submissions_advance_percent(), so it is the same figure and the same visibility rule. 20270403000000.';

revoke execute on function public.attached_percent(public.order_submissions) from public, anon;
grant  execute on function public.attached_percent(public.order_submissions) to authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.attached_percent(public.order_submissions)', 'EXECUTE') then
    raise exception 'attached_percent proof: anon must not call it';
  end if;
  if not has_function_privilege('authenticated', 'public.attached_percent(public.order_submissions)', 'EXECUTE') then
    raise exception 'attached_percent proof: signed-in users must be able to call it';
  end if;
end;
$$;
