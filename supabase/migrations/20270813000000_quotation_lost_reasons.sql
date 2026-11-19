-- 20270813000000_quotation_lost_reasons.sql
--
-- Quotations: a quotation marked Lost carries one of the lead's eleven Dead reasons (owner approved 2026-11-20: "Yes, build it"),
-- so the report counts reasons instead of every different wording ("Price high" and "price too high" were two lines).
--
--   * quotation_set_status(id, status, note, reason): the fourth argument is new and optional. For Lost, a reason of the lead's
--     eleven (price_too_high, chose_another_supplier, not_responding, quantity_too_small, project_cancelled, delivery_time,
--     retail_enquiry, wrong_number, no_requirement, not_relevant, other) is kept in the history entry beside the note; "other"
--     needs a note of three characters. A call WITHOUT a reason works as before (a note of three characters), so nothing older
--     breaks. The three-argument function is dropped: the new one answers the same calls.
--   * quotation_report: the "Why quotations were lost" section groups by the reason key when there is one, and by the note's
--     text as before when there is not (quotations lost before this change). Each item says whether it is a key (`keyed`).
--     Everything else in the report is the function of 20270618000000, unchanged.
--
-- WRITE: no table, column or data changes (the reason lives in the existing history entry's detail). Two functions replaced.
--   No backup is needed. Apply BEFORE the merge: the new Lost box sends the fourth argument.
--
-- ROLLBACK: re-run the definitions of public.quotation_set_status (20270614000000) and public.quotation_report (20270618000000),
--   after dropping the four-argument quotation_set_status.

do $$
begin
  if to_regprocedure('public.quotation_actor()') is null or to_regprocedure('public.quotation_may_edit(uuid, uuid, uuid, boolean, boolean, boolean, boolean)') is null
     or to_regprocedure('public.quotation_set_status(uuid, text, text)') is null or to_regprocedure('public.quotation_report(date, date, text)') is null then
    raise exception 'DEPENDENCY MISSING: quotation_actor, quotation_may_edit, quotation_set_status(3) and quotation_report must exist';
  end if;
end $$;

drop function public.quotation_set_status(uuid, text, text);

create or replace function public.quotation_set_status(p_id uuid, p_status text, p_note text default null, p_reason text default null)
returns text language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record; q public.quotations;
begin
  select * into a from public.quotation_actor();
  select * into q from public.quotations where id = p_id for update;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if not public.quotation_may_edit(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_create, a.p_edit, a.p_view_all) then raise exception 'QUOTATIONS_FORBIDDEN: you may not change this quotation' using errcode = '42501'; end if;
  if p_status not in ('draft', 'sent', 'negotiating', 'confirmed', 'lost', 'archived') then
    raise exception 'QUOTATION_INVALID: status' using errcode = '22023';
  end if;
  if p_reason is not null and p_reason not in ('price_too_high', 'chose_another_supplier', 'not_responding', 'quantity_too_small', 'project_cancelled',
                                               'delivery_time', 'retail_enquiry', 'wrong_number', 'no_requirement', 'not_relevant', 'other') then
    raise exception 'QUOTATION_INVALID: reason' using errcode = '22023';
  end if;
  if q.status = 'confirmed' and p_status <> 'confirmed' and not a.p_admin then
    raise exception 'QUOTATIONS_FORBIDDEN: only an administrator can reopen a confirmed quotation' using errcode = '42501';
  end if;
  -- With a reason, only "other" needs words; without one (an older caller) the note is the reason, as before.
  if p_status = 'lost' and (p_reason is null or p_reason = 'other') and char_length(btrim(coalesce(p_note, ''))) < 3 then
    raise exception 'QUOTATION_INVALID: say why it was lost' using errcode = '22023';
  end if;
  if q.status = p_status then return q.status; end if;
  update public.quotations set status = p_status,
    sent_at = case when p_status = 'sent' then coalesce(sent_at, now()) else sent_at end
  where id = p_id;
  insert into public.quotation_events (quotation_id, actor_id, kind, detail)
  values (p_id, a.p_uid, 'status',
          jsonb_build_object('from', q.status, 'to', p_status, 'note', nullif(btrim(coalesce(p_note, '')), ''))
          || case when p_status = 'lost' and p_reason is not null then jsonb_build_object('reason', p_reason) else '{}'::jsonb end);
  return p_status;
end $$;
revoke all on function public.quotation_set_status(uuid, text, text, text) from public, anon;
grant execute on function public.quotation_set_status(uuid, text, text, text) to authenticated;

-- ═══ The report: the lost reasons by reason ═══════════════════════════════════════════════════════════════════════════════
-- The function of 20270618000000 with two changes: `lost_reason` in the facts, and the lost_reasons section grouped by it.

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
      (select e.detail->>'reason' from ev e where e.quotation_id = m.id and e.kind = 'status' and e.detail->>'to' = 'lost' order by e.at desc limit 1) as lost_reason,
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
      select jsonb_agg(jsonb_build_object('reason', reason, 'keyed', keyed, 'n', n) order by n desc, reason) from (
        select coalesce(lost_reason, nullif(btrim(lost_note), ''), 'no reason given') as reason, (lost_reason is not null) as keyed, count(*) as n
        from p where status = 'lost' group by 1, 2 order by 3 desc limit 20) x), '[]'::jsonb),
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
