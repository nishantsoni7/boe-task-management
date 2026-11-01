-- Confirmed Orders list: "Advance" for every Order the reader may open, in one call.
--
-- WHY THIS EXISTS. The list needs, for every Order it prints, the percentage the
-- Order page's Payment card measures against the 40% rule.
-- order_advance_readiness(uuid) answers for ONE Order and also builds the hold and
-- the exception; one call per row would be one round trip per Order for one number.
--
-- THE RULE IS NOT COPIED. Each row is order_advance_position()'s own 'percent':
-- verified money only, of the Total before GST (order_advance_base), truncated
-- to two places so 39.999% does not read as 40%. NULL when no base is known,
-- never 0.
--
-- ACCESS. SECURITY DEFINER, and the same question order_advance_readiness() asks:
-- can_view_order_as_actor(), the unscoped rule. A visibility scope reveals Orders,
-- never money (20270221000000), so an Order only a scope admits gets NO row and the
-- list draws a dash. Authentication is required, as in pi_submissions_advance_percent.
--
-- Read-only; no table, column or policy changes. Rollback:
--   drop function public.orders_advance_percent();

create or replace function public.orders_advance_percent()
returns table (order_id uuid, advance_percent numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  return query
  select o.id, (public.order_advance_position(o.id) ->> 'percent')::numeric
  from public.orders o
  where public.can_view_order_as_actor(o.id);
end;
$$;

comment on function public.orders_advance_percent() is
  'Advance % (verified, of Total before GST, truncated to 2 dp) for each Order the caller may open; order_advance_position()''s own figure. An Order the caller may not open returns no row; NULL means no base is known. 20270517000100.';

revoke execute on function public.orders_advance_percent() from public, anon;
grant  execute on function public.orders_advance_percent() to authenticated;
