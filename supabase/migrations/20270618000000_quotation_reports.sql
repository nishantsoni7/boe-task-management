-- 20270618000000_quotation_reports.sql
--
-- Quotations, phase 6: the Reports page. Approved by the owner on 2026-11-12. Read-only: no table, no write.
--
-- quotation_report(from, to, scope) returns every section of the page in one answer, computed from quotations and
-- their history (quotation_events) only; nothing is typed in. The period selects quotations STARTED between the two
-- dates (India dates). "Open by age" and "opened but not followed up" are about today, whatever the period.
--
-- WHO SEES WHAT (owner, 2026-11-12): Admin and see-all holders may ask for scope 'all' (the whole team); anyone
-- else always gets their own quotations (owner or creator), whatever they ask for.
--
-- ROLLBACK: drop function public.quotation_report(date, date, text).

create or replace function public.quotation_report(p_from date, p_to date, p_scope text default 'mine')
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  a record;
  v_all boolean;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_week date := date_trunc('week', (now() at time zone 'Asia/Kolkata'))::date;
  v jsonb;
begin
  select * into a from public.quotation_actor();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 800 then
    raise exception 'QUOTATION_INVALID: choose a period of up to two years' using errcode = '22023';
  end if;
  v_all := p_scope = 'all' and (a.p_admin or a.p_view_all);

  with mine as (
    select q.*, public.quotation_value_before_gst(q.id) as value, (q.created_at at time zone 'Asia/Kolkata')::date as started_on
    from public.quotations q
    where v_all or q.owner_id = a.p_uid or q.created_by = a.p_uid
  ),
  ev as (select e.* from public.quotation_events e join mine m on m.id = e.quotation_id),
  facts as (
    select m.*,
      (select min(e.at) from ev e where e.quotation_id = m.id and ((e.kind = 'status' and e.detail->>'to' = 'confirmed') or e.kind = 'converted')) as confirmed_at,
      (select e.detail->>'note' from ev e where e.quotation_id = m.id and e.kind = 'status' and e.detail->>'to' = 'lost' order by e.at desc limit 1) as lost_note,
      (m.status = 'negotiating' or exists (select 1 from ev e where e.quotation_id = m.id and e.kind = 'status' and e.detail->>'to' = 'negotiating')) as reached_negotiation,
      (m.sent_at is not null or m.status in ('negotiating', 'confirmed')) as reached_sent
    from mine m
  ),
  p as (select * from facts f where f.started_on between p_from and p_to),
  wk as (select * from facts f where f.started_on between v_week and v_week + 6),
  open_now as (select * from facts f where f.status in ('draft', 'sent', 'negotiating'))
  select jsonb_build_object(
    'scope', case when v_all then 'all' else 'mine' end,
    'may_see_all', a.p_admin or a.p_view_all,
    'from', p_from, 'to', p_to, 'today', v_today,
    'funnel', jsonb_build_object(
      'made',        jsonb_build_object('n', (select count(*) from p), 'value', (select coalesce(sum(value), 0) from p)),
      'sent',        jsonb_build_object('n', (select count(*) from p where reached_sent), 'value', (select coalesce(sum(value), 0) from p where reached_sent)),
      'negotiating', jsonb_build_object('n', (select count(*) from p where reached_negotiation), 'value', (select coalesce(sum(value), 0) from p where reached_negotiation)),
      'confirmed',   jsonb_build_object('n', (select count(*) from p where status = 'confirmed'), 'value', (select coalesce(sum(value), 0) from p where status = 'confirmed')),
      'lost',        jsonb_build_object('n', (select count(*) from p where status = 'lost'), 'value', (select coalesce(sum(value), 0) from p where status = 'lost')),
      'open',        jsonb_build_object('n', (select count(*) from p where status in ('draft', 'sent', 'negotiating')), 'value', (select coalesce(sum(value), 0) from p where status in ('draft', 'sent', 'negotiating')))
    ),
    'week', jsonb_build_object(
      'from', v_week, 'to', v_week + 6,
      'made', (select count(*) from wk), 'made_value', (select coalesce(sum(value), 0) from wk),
      'sent', (select count(*) from facts where (sent_at at time zone 'Asia/Kolkata')::date between v_week and v_week + 6),
      'confirmed', (select count(*) from facts where (confirmed_at at time zone 'Asia/Kolkata')::date between v_week and v_week + 6),
      'confirmed_value', (select coalesce(sum(value), 0) from facts where (confirmed_at at time zone 'Asia/Kolkata')::date between v_week and v_week + 6),
      'lost', (select count(*) from facts f where f.status = 'lost' and exists (select 1 from ev e where e.quotation_id = f.id and e.kind = 'status' and e.detail->>'to' = 'lost' and (e.at at time zone 'Asia/Kolkata')::date between v_week and v_week + 6))
    ),
    'by_owner', coalesce((
      select jsonb_agg(r order by r->>'name') from (
        select jsonb_build_object('name', coalesce((select u.full_name from public.users u where u.id = p.owner_id), '—'),
          'made', count(*), 'sent', count(*) filter (where reached_sent), 'confirmed', count(*) filter (where status = 'confirmed'),
          'lost', count(*) filter (where status = 'lost'), 'confirmed_value', coalesce(sum(value) filter (where status = 'confirmed'), 0),
          'win_rate', case when count(*) filter (where status in ('confirmed', 'lost')) = 0 then null
                           else round(100.0 * count(*) filter (where status = 'confirmed') / count(*) filter (where status in ('confirmed', 'lost'))) end) r
        from p group by p.owner_id) x), '[]'::jsonb),
    'by_client_type', coalesce((
      select jsonb_agg(r order by (r->>'made')::int desc) from (
        select jsonb_build_object('name', coalesce(p.client_type, 'not set'), 'made', count(*), 'confirmed', count(*) filter (where status = 'confirmed'),
          'lost', count(*) filter (where status = 'lost'), 'confirmed_value', coalesce(sum(value) filter (where status = 'confirmed'), 0),
          'win_rate', case when count(*) filter (where status in ('confirmed', 'lost')) = 0 then null
                           else round(100.0 * count(*) filter (where status = 'confirmed') / count(*) filter (where status in ('confirmed', 'lost'))) end) r
        from p group by coalesce(p.client_type, 'not set')) x), '[]'::jsonb),
    'by_source', coalesce((
      select jsonb_agg(r order by (r->>'made')::int desc) from (
        select jsonb_build_object('name', coalesce(nullif(btrim(p.source), ''), 'not set'), 'made', count(*), 'confirmed', count(*) filter (where status = 'confirmed'),
          'lost', count(*) filter (where status = 'lost'),
          'win_rate', case when count(*) filter (where status in ('confirmed', 'lost')) = 0 then null
                           else round(100.0 * count(*) filter (where status = 'confirmed') / count(*) filter (where status in ('confirmed', 'lost'))) end) r
        from p group by coalesce(nullif(btrim(p.source), ''), 'not set')) x), '[]'::jsonb),
    'speed', jsonb_build_object(
      'days_to_send', (select round((percentile_cont(0.5) within group (order by extract(epoch from sent_at - created_at) / 86400))::numeric, 1) from p where sent_at is not null),
      'sent_count', (select count(*) from p where sent_at is not null),
      'days_to_confirm', (select round((percentile_cont(0.5) within group (order by extract(epoch from confirmed_at - coalesce(sent_at, created_at)) / 86400))::numeric, 1) from p where confirmed_at is not null),
      'confirmed_count', (select count(*) from p where confirmed_at is not null)
    ),
    'ageing', coalesce((
      select jsonb_agg(jsonb_build_object('bucket', b.label, 'n', coalesce(x.n, 0), 'value', coalesce(x.value, 0)) order by b.ord)
      from (values (1, '0–7 days'), (2, '8–14 days'), (3, '15–30 days'), (4, 'over 30 days')) b(ord, label)
      left join (
        select case when d <= 7 then 1 when d <= 14 then 2 when d <= 30 then 3 else 4 end as ord, count(*) as n, sum(value) as value
        from (select value, v_today - (coalesce(sent_at, created_at) at time zone 'Asia/Kolkata')::date as d from open_now) o group by 1
      ) x on x.ord = b.ord), '[]'::jsonb),
    'opened_no_followup', coalesce((
      select jsonb_agg(r order by r->>'opened_at') from (
        select jsonb_build_object('id', o.id, 'quote_no', o.quote_no, 'client_name', o.client_name,
          'owner_name', (select u.full_name from public.users u where u.id = o.owner_id), 'opened_at', lo.at, 'value', o.value) r
        from open_now o
        cross join lateral (select max(e.at) as at from ev e where e.quotation_id = o.id and e.kind = 'opened') lo
        where lo.at is not null and lo.at < now() - interval '2 days'
          and not exists (select 1 from ev e where e.quotation_id = o.id and e.at > lo.at and e.kind in ('saved', 'status', 'shared', 'price', 'converted'))
        limit 50) x), '[]'::jsonb),
    'lost_reasons', coalesce((
      select jsonb_agg(jsonb_build_object('reason', reason, 'n', n) order by n desc, reason) from (
        select coalesce(nullif(btrim(lost_note), ''), 'no reason given') as reason, count(*) as n
        from p where status = 'lost' group by 1 order by 2 desc limit 20) x), '[]'::jsonb),
    'discount', coalesce((
      select jsonb_agg(jsonb_build_object('bucket', b.label, 'decided', coalesce(x.decided, 0), 'confirmed', coalesce(x.confirmed, 0),
               'win_rate', case when coalesce(x.decided, 0) = 0 then null else round(100.0 * x.confirmed / x.decided) end) order by b.ord)
      from (values (1, 'none'), (2, 'up to 5%'), (3, '5–10%'), (4, 'over 10%')) b(ord, label)
      left join (
        select case when discount_pct = 0 then 1 when discount_pct <= 5 then 2 when discount_pct <= 10 then 3 else 4 end as ord,
               count(*) as decided, count(*) filter (where status = 'confirmed') as confirmed
        from p where status in ('confirmed', 'lost') group by 1
      ) x on x.ord = b.ord), '[]'::jsonb),
    'price_waiting', (select count(*) from open_now o where public.quotation_price_state(o.id)->>'state' = 'requested')
  ) into v;
  return v;
end $$;
revoke all on function public.quotation_report(date, date, text) from public, anon;
grant execute on function public.quotation_report(date, date, text) to authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.quotation_report(date, date, text)', 'execute') then
    raise exception 'QUOTATION_REPORTS: quotation_report must not be open to anon';
  end if;
end $$;
