-- PI Drafts list: "Advance % received" for many PIs in one call.
--
-- WHY THIS EXISTS. The list needs, for every PI it prints, the same figure the
-- PI Draft detail page shows as the attached percentage — verified plus
-- awaiting-verification payments, as a percentage of Total before GST.
-- pi_submission_payment_summary(uuid) computes it for ONE PI and also builds the
-- payment rows, the PI-decision state and the exception position; calling it
-- once per row of a 200-row list would be 200 round trips for one number each.
--
-- THE RULE IS COPIED, NOT RE-INVENTED. It mirrors pi_submission_payment_summary
-- as defined in 20270227000000_order_submission_advance_on_total_before_gst.sql:
--   * allocations counted: status 'active' whose payment is verified
--     (finance_payment_status_is_verified) or pending_approval /
--     needs_clarification;
--   * base: total_before_gst, usable only when > 0, not NaN and not above the
--     grand total (when one is stored) — otherwise the percentage is NULL;
--   * percentage truncated (never rounded) to two places, so 39.999% does not
--     read as 40%.
--
-- ACCESS. SECURITY DEFINER, and every id is filtered through
-- can_view_order_submission(): an id the caller may not open yields NO row —
-- not a zero and not a NULL — so the function discloses nothing about it.
-- Authentication is required, as in the single-PI function.
--
-- Read-only; no table, column or policy changes. Rollback:
--   drop function public.pi_submissions_advance_percent(uuid[]);

create or replace function public.pi_submissions_advance_percent(p_submission_ids uuid[])
returns table (submission_id uuid, attached_percent numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  -- A list page is a working set (the page reads at most 200). A bound keeps
  -- this from being used as a bulk probe.
  if coalesce(array_length(p_submission_ids, 1), 0) > 500 then
    raise exception 'TOO_MANY_SUBMISSIONS: at most 500 PIs per call.' using errcode = '22023';
  end if;

  return query
  select
    s.id,
    case
      when s.total_before_gst is not null
           and s.total_before_gst <> 'NaN'::numeric
           and s.total_before_gst > 0
           and s.total_before_gst <= coalesce(s.grand_total, s.total_before_gst)
      then trunc(coalesce(p.attached, 0) * 100 / s.total_before_gst, 2)
      else null
    end
  from public.order_submissions s
  left join lateral (
    select sum(a.allocated_amount) as attached
    from public.finance_payment_allocations a
    join public.finance_payment_requests f on f.id = a.payment_request_id
    where a.order_submission_id = s.id
      and a.status = 'active'
      and (public.finance_payment_status_is_verified(f.status)
           or f.status in ('pending_approval', 'needs_clarification'))
  ) p on true
  where s.id = any (p_submission_ids)
    and public.can_view_order_submission(s.id);
end;
$$;

comment on function public.pi_submissions_advance_percent(uuid[]) is
  'Advance % received (verified + awaiting verification, of Total before GST, truncated to 2 dp) for each PI the caller may view; PIs the caller may not view return no row. Same rule as pi_submission_payment_summary().attached_percent.';

revoke execute on function public.pi_submissions_advance_percent(uuid[]) from public, anon;
grant  execute on function public.pi_submissions_advance_percent(uuid[]) to authenticated;
