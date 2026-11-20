-- 20270814000300_quotation_cards_and_briefs.sql
--
-- Quotations: report cards, and the price brief (owner, 20 Nov 2026).
--
-- 1. quotation_cards(from, to, person) -> jsonb. The numbers behind the cards on the Quotations home:
--      me    the person's own: open quotations (count, value), waiting on a senior, and for the period: made, sent to a client,
--            confirmed, value made, value confirmed, conversion (confirmed of those that went to a client)
--      desk  only for the pricing desk: requests waiting for the person, the oldest, answered in the period, average hours to answer
--      team  only for Admin / see all: the same numbers for the whole team and for each salesperson, and who made the most
--    `person` shows another person's cards (candidate by candidate): Admin / see all only.
--    The period counts quotations by the day they were MADE (India date). Conversion = confirmed / (sent + negotiating + confirmed + lost).
--
-- 2. The price brief: when the owner or the pricing desk sends a priced quotation back or shares it, the screen asks, per product, how the
--    price was worked out (optional). quotation_price_briefs_save stores each answered line as a pricing_feedback row (source quotation,
--    kind price_reason, comment = the explanation, expected_price = the price), marked done so the Price learning inbox is not flooded;
--    they stay readable under "all" for whoever teaches the price calculator. quotation_price_briefs_get returns the latest brief per
--    product name on a quotation, to pre-fill the next time.
--
-- WRITE: new functions; the CHECK on pricing_feedback.kind gains one value (no row changes). A same-day backup stands.
-- ROLLBACK: drop the three functions; restore pricing_feedback_kind_check without 'price_reason' (after deleting those rows).

do $$
begin
  if to_regprocedure('public.quotation_is_desk(uuid)') is null or to_regclass('public.quotation_requests') is null
     or to_regclass('public.pricing_feedback') is null then
    raise exception 'DEPENDENCY MISSING: quotation_requests (20270814000200) and pricing_feedback (20270715000000) must exist';
  end if;
end $$;

-- ─── 1. Report cards ──────────────────────────────────────────────────────────────────────────────────────────
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
           case when (q.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to then public.quotation_value_before_gst(q.id) end as v,
           q.status in ('draft', 'sent', 'negotiating') as is_open
    from public.quotations q where q.owner_id = v_uid)
  select jsonb_build_object(
    'person', v_uid, 'name', (select u.full_name from public.users u where u.id = v_uid),
    'open_count', count(*) filter (where is_open),
    'open_value', coalesce((select sum(public.quotation_value_before_gst(m2.id)) from mine m2 where m2.is_open), 0),
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

-- ─── 2. The price brief ───────────────────────────────────────────────────────────────────────────────────────
alter table public.pricing_feedback drop constraint pricing_feedback_kind_check;
alter table public.pricing_feedback add constraint pricing_feedback_kind_check
  check (kind in ('too_high', 'too_low', 'wrong_type', 'misread', 'other', 'correction', 'differs_taught', 'price_reason'));

create or replace function public.quotation_price_briefs_save(p_id uuid, p_items jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare a record; q public.quotations; it jsonb; v_n integer := 0;
begin
  select * into a from public.quotation_actor();
  if not (a.p_admin or (a.p_edit and a.p_view_all)) then
    raise exception 'QUOTATIONS_FORBIDDEN: only the pricing desk can brief a price' using errcode = '42501';
  end if;
  select * into q from public.quotations where id = p_id;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 200 then
    raise exception 'QUOTATION_INVALID: at most 200 products in a brief' using errcode = '22023';
  end if;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    continue when char_length(btrim(coalesce(it->>'reason', ''))) = 0 or char_length(btrim(coalesce(it->>'name', ''))) = 0;
    begin
      insert into public.pricing_feedback (created_by, source, kind, comment, expected_price, line_name, line_size, line_material, line_finish, line_qty,
                                           client_type, quotation_id, status, handled_by, handled_at)
      values (a.p_uid, 'quotation', 'price_reason', left(btrim(it->>'reason'), 1000), nullif(it->>'price', '')::numeric,
              left(btrim(it->>'name'), 240), nullif(left(btrim(coalesce(it->>'size', '')), 160), ''), nullif(left(btrim(coalesce(it->>'material', '')), 200), ''),
              nullif(left(btrim(coalesce(it->>'finish', '')), 600), ''), nullif(it->>'qty', '')::numeric, q.client_type, q.id, 'done', a.p_uid, now());
      v_n := v_n + 1;
    exception when check_violation or numeric_value_out_of_range or invalid_text_representation then
      raise exception 'QUOTATION_INVALID: check the brief for %', coalesce(it->>'name', 'a product') using errcode = '22023';
    end;
  end loop;
  return v_n;
end $$;
revoke all on function public.quotation_price_briefs_save(uuid, jsonb) from public, anon;
grant execute on function public.quotation_price_briefs_save(uuid, jsonb) to authenticated;

create or replace function public.quotation_price_briefs_get(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare a record; q public.quotations;
begin
  select * into a from public.quotation_actor();
  if not (a.p_admin or (a.p_edit and a.p_view_all)) then
    raise exception 'QUOTATIONS_FORBIDDEN: only the pricing desk can brief a price' using errcode = '42501';
  end if;
  select * into q from public.quotations where id = p_id;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002'; end if;
  return coalesce((select jsonb_object_agg(x.line_name, x.comment) from (
    select distinct on (f.line_name) f.line_name, f.comment from public.pricing_feedback f
    where f.quotation_id = p_id and f.kind = 'price_reason' order by f.line_name, f.created_at desc) x), '{}'::jsonb);
end $$;
revoke all on function public.quotation_price_briefs_get(uuid) from public, anon;
grant execute on function public.quotation_price_briefs_get(uuid) to authenticated;

do $$
declare v_fn text;
begin
  foreach v_fn in array array['public.quotation_cards(date, date, uuid)', 'public.quotation_price_briefs_save(uuid, jsonb)', 'public.quotation_price_briefs_get(uuid)'] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE') or not has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      raise exception 'QUOTATION_CARDS: % must be callable by signed-in people only', v_fn;
    end if;
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'pricing_feedback_kind_check' and conrelid = 'public.pricing_feedback'::regclass
                 and pg_get_constraintdef(oid) like '%price_reason%') then
    raise exception 'QUOTATION_CARDS: the feedback kind check does not accept price_reason';
  end if;
end $$;
