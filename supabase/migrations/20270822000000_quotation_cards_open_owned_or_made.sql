-- 20270822000000_quotation_cards_open_owned_or_made.sql
--
-- Quotations: the "Open quotations" tile counts what the list counts (owner, 23 Nov 2026: "Fix the Open quotations tile too").
--
-- The tile read quotation_cards().me.open_count / open_value, which counted quotations the person OWNS only; the list header ("3 open"),
-- My quotations and the status chips come from quotation_list('mine'), which has always counted the ones a person owns OR made
-- (owner_id = me or created_by = me). The owner saw "0 / Rs 0" beside "3 open / Rs 25,48,300".
--
-- This re-creates quotation_cards with one change: open_count and open_value count quotations where the person is the owner OR the
-- maker, with the same three open statuses as the list (draft, sent, negotiating). A quotation both owned and made by the person
-- counts once. Everything else in the function is the 20270814000300 text, byte for byte: the period numbers (made, sent, confirmed,
-- values), the desk block and the team block still count by OWNER, so they still agree with each person's row in the team block.
--
-- WRITE: one function re-created (create or replace, same signature and grants). No table, column, row, policy or table grant changes,
--        so no backup is needed first. The code works with the old and the new function: it only reads open_count and open_value.
-- ROLLBACK: run the quotation_cards definition from 20270814000300_quotation_cards_and_briefs.sql again.

do $$
begin
  if to_regprocedure('public.quotation_cards(date, date, uuid)') is null or to_regprocedure('public.quotation_value_before_gst(uuid)') is null
     or to_regprocedure('public.quotation_actor()') is null then
    raise exception 'DEPENDENCY MISSING: quotation_cards (20270814000300) and quotation_value_before_gst / quotation_actor must exist';
  end if;
end $$;

create or replace function public.quotation_cards(p_from date, p_to date, p_person uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  a record; v_uid uuid; v_me jsonb; v_desk jsonb; v_team jsonb;
begin
  select * into a from public.quotation_actor();
  v_uid := coalesce(p_person, a.p_uid);
  if v_uid <> a.p_uid and not (a.p_admin or a.p_view_all) then
    raise exception 'QUOTATIONS_FORBIDDEN: you may only see your own cards' using errcode = '42501';
  end if;

  with mine as (
    select q.id, q.status, (q.created_at at time zone 'Asia/Kolkata')::date as made_on,
           case when (q.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to then public.quotation_value_before_gst(q.id) end as v
    from public.quotations q where q.owner_id = v_uid)
  select jsonb_build_object(
    'person', v_uid, 'name', (select u.full_name from public.users u where u.id = v_uid),
    'open_count', (select count(*) from public.quotations o where (o.owner_id = v_uid or o.created_by = v_uid) and o.status in ('draft', 'sent', 'negotiating')),
    'open_value', coalesce((select sum(public.quotation_value_before_gst(o.id)) from public.quotations o
                            where (o.owner_id = v_uid or o.created_by = v_uid) and o.status in ('draft', 'sent', 'negotiating')), 0),
    'waiting_senior', (select count(*) from public.quotation_requests r where r.requested_by = v_uid and r.status = 'pending'),
    'made', count(*) filter (where made_on between p_from and p_to),
    'sent', count(*) filter (where made_on between p_from and p_to and status in ('sent', 'negotiating', 'confirmed', 'lost')),
    'confirmed', count(*) filter (where made_on between p_from and p_to and status = 'confirmed'),
    'value_made', coalesce(sum(v), 0),
    'value_confirmed', coalesce(sum(v) filter (where status = 'confirmed'), 0))
  into v_me from mine;

  if public.quotation_is_desk(v_uid) then
    select jsonb_build_object(
      'waiting', count(*) filter (where r.status = 'pending'),
      'oldest_at', min(r.created_at) filter (where r.status = 'pending'),
      'answered', count(*) filter (where r.status = 'answered' and (r.answered_at at time zone 'Asia/Kolkata')::date between p_from and p_to),
      'avg_hours', round((avg(extract(epoch from (r.answered_at - r.created_at)) / 3600.0)
                          filter (where r.status = 'answered' and (r.answered_at at time zone 'Asia/Kolkata')::date between p_from and p_to))::numeric, 1))
    into v_desk from public.quotation_requests r where r.to_user = v_uid;
  end if;

  if a.p_admin or a.p_view_all then
    with team as (
      select q.owner_id, q.status, public.quotation_value_before_gst(q.id) as v
      from public.quotations q where (q.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to),
    per as (
      select t.owner_id as id, (select u.full_name from public.users u where u.id = t.owner_id) as name,
             count(*) as made, count(*) filter (where t.status in ('sent', 'negotiating', 'confirmed', 'lost')) as sent,
             count(*) filter (where t.status = 'confirmed') as confirmed, coalesce(sum(t.v), 0) as value,
             coalesce(sum(t.v) filter (where t.status = 'confirmed'), 0) as value_confirmed
      from team t group by t.owner_id)
    select jsonb_build_object(
      'made', coalesce(sum(made), 0), 'sent', coalesce(sum(sent), 0), 'confirmed', coalesce(sum(confirmed), 0),
      'value_made', coalesce(sum(value), 0), 'value_confirmed', coalesce(sum(value_confirmed), 0),
      'top', (select jsonb_build_object('id', p2.id, 'name', p2.name, 'made', p2.made) from per p2 order by p2.made desc, p2.value desc limit 1),
      'people', coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'made', made, 'sent', sent, 'confirmed', confirmed,
                                                      'value_made', value, 'value_confirmed', value_confirmed) order by made desc, value desc), '[]'::jsonb))
    into v_team from per;
  end if;

  return jsonb_build_object('me', v_me, 'desk', v_desk, 'team', v_team, 'from', p_from, 'to', p_to);
end $$;
revoke all on function public.quotation_cards(date, date, uuid) from public, anon;
grant execute on function public.quotation_cards(date, date, uuid) to authenticated;

do $$
declare v_fn text := 'public.quotation_cards(date, date, uuid)';
begin
  if has_function_privilege('anon', v_fn, 'EXECUTE') or not has_function_privilege('authenticated', v_fn, 'EXECUTE') then
    raise exception 'QUOTATION_CARDS_OPEN: % must be callable by signed-in people only', v_fn;
  end if;
  if pg_get_functiondef(v_fn::regprocedure) not like '%o.created_by = v_uid%' then
    raise exception 'QUOTATION_CARDS_OPEN: the new definition is not in place';
  end if;
end $$;
