-- 20270617000000_quotation_pricing_desk.sql
--
-- Quotations, phase 5: the pricing desk. Approved by the owner on 2026-11-12.
--
-- PRICE HINTS. For a product name, what BOE charged before: approved PIs (order_submission_items of approved
-- order_submissions, the last three years) and earlier quotations (sent, negotiating, confirmed). Names match by
-- their words: every word of the asked name (3+ letters, a few filler words dropped, any "Room type · " prefix
-- dropped) must be in the candidate, which may carry at most three more words. Prices only, never client names.
-- Everyone who may open Quotations sees them (owner, 2026-11-12).
--
-- PRICE APPROVAL. A quotation NEEDS approval when its discount is above the limit, or a product is priced below the
-- limit % of its last ordered price (owner's starting limits: 5% and 90%; an administrator changes them, NULL = off).
-- The salesperson asks; the pricing desk (Admin, or edit + view_all) approves or sends it back with a note. An
-- answer belongs to the exact prices it was given for (a fingerprint of lines, quantities, rooms, discount and
-- extras): change a price and the quotation needs asking again. Until approved, quotation_share (turning the client
-- link on) and quotation_link_pi (Confirm -> PI draft) refuse. A link that was already on stays on.
--
-- Nothing here writes to an Orders table: approved PI lines are only read, inside SECURITY DEFINER functions.
--
-- ROLLBACK: drop the quotation_price_* functions and quotation_name_words; drop tables quotation_price_reviews and
-- quotation_price_settings; re-create quotation_get, quotation_share (20270614000000 / 20270615000000) and
-- quotation_link_pi (20270615000000).

-- ═══ 1. Limits (one row) and the review log ══════════════════════════════════
create table public.quotation_price_settings (
  id                boolean primary key default true check (id),
  max_discount_pct  numeric(5,2) check (max_discount_pct between 0 and 100),
  min_price_pct     numeric(5,2) check (min_price_pct between 1 and 100),
  updated_by        uuid references public.users(id),
  updated_at        timestamptz not null default now()
);
insert into public.quotation_price_settings (id, max_discount_pct, min_price_pct) values (true, 5, 90);

create table public.quotation_price_reviews (
  id            uuid primary key default gen_random_uuid(),
  quotation_id  uuid not null references public.quotations(id) on delete cascade,
  decision      text not null check (decision in ('requested', 'approved', 'returned')),
  fingerprint   text not null check (fingerprint ~ '^[0-9a-f]{32}$'),
  note          text check (char_length(note) <= 500),
  actor_id      uuid references public.users(id),
  at            timestamptz not null default now()
);
create index quotation_price_reviews_q on public.quotation_price_reviews (quotation_id, at desc);

create or replace function public.quotation_price_reviews_append_only()
returns trigger language plpgsql set search_path = public, pg_temp
as $$
begin
  raise exception 'QUOTATION_PRICE_REVIEWS_APPEND_ONLY';
end $$;
create trigger quotation_price_reviews_append_only before update or delete on public.quotation_price_reviews
  for each row execute function public.quotation_price_reviews_append_only();

alter table public.quotation_price_settings enable row level security;
alter table public.quotation_price_reviews enable row level security;
revoke all on public.quotation_price_settings, public.quotation_price_reviews from anon, authenticated;

alter table public.quotation_events drop constraint quotation_events_kind_check;
alter table public.quotation_events add constraint quotation_events_kind_check
  check (kind in ('created', 'saved', 'status', 'shared', 'unshared', 'opened', 'converted', 'price'));

-- ═══ 2. Name matching and price history ═════════════════════════════════════
create or replace function public.quotation_name_words(p text)
returns text[] language sql immutable set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct w order by w), '{}')
  from regexp_split_to_table(lower(regexp_replace(coalesce(p, ''), '^.*·', '')), '[^a-z0-9]+') w
  where length(w) >= 3
    and w not in ('with', 'and', 'the', 'for', 'set', 'per', 'room', 'rooms', 'nos', 'pcs', 'size', 'type', 'new')
$$;

-- For each asked name: the approved-PI prices and the last quoted price of similar products.
create or replace function public.quotation_price_history(p_names text[], p_exclude uuid)
returns table (name text, ordered jsonb, quoted jsonb)
language sql stable security definer set search_path = public, pg_temp
as $$
  with asked as (
    select distinct n as name, public.quotation_name_words(n) as w
    from unnest(p_names) n where n is not null and btrim(n) <> ''
  ),
  items as (
    select i.cost_per_piece::numeric as price, s.approved_at as at, public.quotation_name_words(i.product_name) as w
    from public.order_submission_items i join public.order_submissions s on s.id = i.submission_id
    where s.status = 'approved' and s.approved_at > now() - interval '3 years' and i.product_name is not null
  ),
  quotes as (
    select l.unit_price::numeric as price, q.updated_at as at, public.quotation_name_words(l.name) as w
    from public.quotation_lines l join public.quotations q on q.id = l.quotation_id
    where q.status in ('sent', 'negotiating', 'confirmed') and l.unit_price > 0 and l.is_optional = false
      and q.id is distinct from p_exclude
  ),
  om as (
    select a.name, i.price, i.at from asked a join items i
      on cardinality(a.w) > 0 and i.w @> a.w and cardinality(i.w) <= cardinality(a.w) + 3
  ),
  qm as (
    select a.name, x.price, x.at from asked a join quotes x
      on cardinality(a.w) > 0 and x.w @> a.w and cardinality(x.w) <= cardinality(a.w) + 3
  )
  select a.name,
    (select jsonb_build_object('last', (select o2.price from om o2 where o2.name = a.name order by o2.at desc limit 1),
              'last_at', max(o.at), 'min', min(o.price), 'max', max(o.price), 'count', count(*))
       from om o where o.name = a.name having count(*) > 0),
    (select jsonb_build_object('last', x.price, 'last_at', x.at) from qm x where x.name = a.name order by x.at desc limit 1)
  from asked a
$$;
revoke all on function public.quotation_price_history(text[], uuid) from public, anon, authenticated;

create or replace function public.quotation_price_hints(p_names text[], p_exclude uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.quotation_actor();
  if coalesce(array_length(p_names, 1), 0) > 80 then raise exception 'QUOTATION_INVALID: too many names' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('name', h.name, 'ordered', h.ordered, 'quoted', h.quoted))
                   from public.quotation_price_history(p_names, p_exclude) h), '[]'::jsonb);
end $$;
revoke all on function public.quotation_price_hints(text[], uuid) from public, anon;
grant execute on function public.quotation_price_hints(text[], uuid) to authenticated;

-- ═══ 3. The check, the fingerprint and the state ════════════════════════════
create or replace function public.quotation_price_fingerprint(p_id uuid)
returns text language sql stable security definer set search_path = public, pg_temp
as $$
  select md5(coalesce((select q.discount_pct::text || '|' || q.fabric_amount || '|' || q.packing_amount from public.quotations q where q.id = p_id), '')
    || '#' || coalesce((select string_agg(concat_ws('|', l.name, l.unit_price, l.qty_per_unit, l.qty_fixed, l.is_optional, ar.multiplier), '~' order by l.position)
                        from public.quotation_lines l left join public.quotation_areas ar on ar.id = l.area_id
                        where l.quotation_id = p_id), ''))
$$;
revoke all on function public.quotation_price_fingerprint(uuid) from public, anon, authenticated;

-- {needed, reasons:[{kind:'discount', pct, limit} | {kind:'below', line, price, last, pct, limit}]}
create or replace function public.quotation_price_check(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare st public.quotation_price_settings; q public.quotations; v_reasons jsonb := '[]'::jsonb;
begin
  select * into st from public.quotation_price_settings where id;
  select * into q from public.quotations where id = p_id;
  if q.id is null then return jsonb_build_object('needed', false, 'reasons', '[]'::jsonb); end if;
  if st.max_discount_pct is not null and q.discount_pct > st.max_discount_pct then
    v_reasons := v_reasons || jsonb_build_array(jsonb_build_object('kind', 'discount', 'pct', q.discount_pct, 'limit', st.max_discount_pct));
  end if;
  if st.min_price_pct is not null then
    v_reasons := v_reasons || coalesce((
      select jsonb_agg(jsonb_build_object('kind', 'below', 'line', l.name, 'price', l.unit_price, 'last', (h.ordered->>'last')::numeric,
               'pct', round(l.unit_price * 100.0 / (h.ordered->>'last')::numeric, 1), 'limit', st.min_price_pct) order by l.position)
      from public.quotation_lines l
      join public.quotation_price_history((select array_agg(x.name) from public.quotation_lines x where x.quotation_id = p_id and not x.is_optional), p_id) h
        on h.name = l.name
      where l.quotation_id = p_id and not l.is_optional and l.unit_price > 0 and h.ordered is not null
        and l.unit_price < (h.ordered->>'last')::numeric * st.min_price_pct / 100), '[]'::jsonb);
  end if;
  return jsonb_build_object('needed', jsonb_array_length(v_reasons) > 0, 'reasons', v_reasons);
end $$;
revoke all on function public.quotation_price_check(uuid) from public, anon, authenticated;

-- {needed, reasons, state: not_needed | to_ask | requested | approved | returned, blocked, note, by, at}
create or replace function public.quotation_price_state(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare c jsonb := public.quotation_price_check(p_id); fp text := public.quotation_price_fingerprint(p_id); r record; v_state text;
begin
  select pr.decision, pr.note, pr.at, (select u.full_name from public.users u where u.id = pr.actor_id) as by_name into r
    from public.quotation_price_reviews pr where pr.quotation_id = p_id and pr.fingerprint = fp order by pr.at desc limit 1;
  v_state := case when not (c->>'needed')::boolean then 'not_needed' when r.decision is null then 'to_ask' else r.decision end;
  return c || jsonb_build_object('state', v_state, 'blocked', (c->>'needed')::boolean and v_state <> 'approved',
                                  'note', r.note, 'by', r.by_name, 'at', r.at);
end $$;
revoke all on function public.quotation_price_state(uuid) from public, anon, authenticated;

-- ═══ 4. Ask, decide, queue, limits ══════════════════════════════════════════
create or replace function public.quotation_price_request(p_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record; q public.quotations; s jsonb;
begin
  select * into a from public.quotation_actor();
  select * into q from public.quotations where id = p_id for update;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if not public.quotation_may_edit(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_create, a.p_edit, a.p_view_all) then raise exception 'QUOTATIONS_FORBIDDEN: you may not change this quotation' using errcode = '42501'; end if;
  s := public.quotation_price_state(p_id);
  if s->>'state' = 'not_needed' then raise exception 'QUOTATION_INVALID: these prices need no approval' using errcode = '22023'; end if;
  if s->>'state' in ('requested', 'approved') then return s; end if;
  insert into public.quotation_price_reviews (quotation_id, decision, fingerprint, actor_id) values (p_id, 'requested', public.quotation_price_fingerprint(p_id), a.p_uid);
  insert into public.quotation_events (quotation_id, actor_id, kind, detail) values (p_id, a.p_uid, 'price', jsonb_build_object('decision', 'requested'));
  return public.quotation_price_state(p_id);
end $$;
revoke all on function public.quotation_price_request(uuid) from public, anon;
grant execute on function public.quotation_price_request(uuid) to authenticated;

create or replace function public.quotation_price_decide(p_id uuid, p_approve boolean, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record; q public.quotations; s jsonb; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into a from public.quotation_actor();
  if not (a.p_admin or (a.p_edit and a.p_view_all)) then raise exception 'QUOTATIONS_FORBIDDEN: only the pricing desk approves prices' using errcode = '42501'; end if;
  select * into q from public.quotations where id = p_id for update;
  if q.id is null then raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002'; end if;
  s := public.quotation_price_state(p_id);
  if s->>'state' = 'not_needed' then raise exception 'QUOTATION_INVALID: these prices need no approval' using errcode = '22023'; end if;
  if not p_approve and char_length(coalesce(v_note, '')) < 3 then raise exception 'QUOTATION_INVALID: say what to change' using errcode = '22023'; end if;
  insert into public.quotation_price_reviews (quotation_id, decision, fingerprint, note, actor_id)
  values (p_id, case when p_approve then 'approved' else 'returned' end, public.quotation_price_fingerprint(p_id), left(v_note, 500), a.p_uid);
  insert into public.quotation_events (quotation_id, actor_id, kind, detail)
  values (p_id, a.p_uid, 'price', jsonb_build_object('decision', case when p_approve then 'approved' else 'returned' end, 'note', v_note));
  return public.quotation_price_state(p_id);
end $$;
revoke all on function public.quotation_price_decide(uuid, boolean, text) from public, anon;
grant execute on function public.quotation_price_decide(uuid, boolean, text) to authenticated;

-- The desk's list: quotations whose current prices were sent for approval and not yet answered.
create or replace function public.quotation_price_queue()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.quotation_actor();
  if not (a.p_admin or (a.p_edit and a.p_view_all)) then raise exception 'QUOTATIONS_FORBIDDEN: only the pricing desk sees this list' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', q.id, 'quote_no', q.quote_no, 'client_name', q.client_name, 'project_name', q.project_name,
             'owner_name', (select u.full_name from public.users u where u.id = q.owner_id), 'value_before_gst', public.quotation_value_before_gst(q.id),
             'requested_at', st.at, 'reasons', st.reasons) order by st.at)
    from public.quotations q
    cross join lateral (select public.quotation_price_state(q.id) as s) x
    cross join lateral (select (x.s->>'at')::timestamptz as at, x.s->'reasons' as reasons) st
    where q.status in ('draft', 'sent', 'negotiating')
      and exists (select 1 from public.quotation_price_reviews pr where pr.quotation_id = q.id and pr.decision = 'requested')
      and x.s->>'state' = 'requested'), '[]'::jsonb);
end $$;
revoke all on function public.quotation_price_queue() from public, anon;
grant execute on function public.quotation_price_queue() to authenticated;

create or replace function public.quotation_price_settings_get()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.quotation_actor();
  return (select jsonb_build_object('max_discount_pct', s.max_discount_pct, 'min_price_pct', s.min_price_pct, 'updated_at', s.updated_at,
                                    'may_change', a.p_admin) from public.quotation_price_settings s where s.id);
end $$;
revoke all on function public.quotation_price_settings_get() from public, anon;
grant execute on function public.quotation_price_settings_get() to authenticated;

create or replace function public.quotation_price_settings_set(p_max_discount_pct numeric, p_min_price_pct numeric)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.quotation_actor();
  if not a.p_admin then raise exception 'QUOTATIONS_FORBIDDEN: only an administrator sets the price limits' using errcode = '42501'; end if;
  update public.quotation_price_settings set max_discount_pct = p_max_discount_pct, min_price_pct = p_min_price_pct,
    updated_by = a.p_uid, updated_at = now() where id;
  return public.quotation_price_settings_get();
exception when check_violation then
  raise exception 'QUOTATION_INVALID: a discount limit is 0 to 100, a price limit 1 to 100' using errcode = '22023';
end $$;
revoke all on function public.quotation_price_settings_set(numeric, numeric) from public, anon;
grant execute on function public.quotation_price_settings_set(numeric, numeric) to authenticated;

-- ═══ 5. quotation_get, quotation_share and quotation_link_pi with the price state ═══
create or replace function public.quotation_get(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record; q public.quotations;
begin
  select * into a from public.quotation_actor();
  select * into q from public.quotations where id = p_id;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then
    raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'quotation', to_jsonb(q),
    'owner_name', (select u.full_name from public.users u where u.id = q.owner_id),
    'may_edit', public.quotation_may_edit(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_create, a.p_edit, a.p_view_all),
    'pi', (select jsonb_build_object('id', s.id, 'draft_reference', s.draft_reference, 'status', s.status)
             from public.order_submissions s where s.id = q.pi_submission_id),
    'price', public.quotation_price_state(p_id) || jsonb_build_object('may_decide', a.p_admin or (a.p_edit and a.p_view_all)),
    'areas', coalesce((select jsonb_agg(to_jsonb(x) order by x.position) from public.quotation_areas x where x.quotation_id = p_id), '[]'::jsonb),
    'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.position) from public.quotation_lines l where l.quotation_id = p_id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(e order by e.at desc) from (
        select ev.kind, ev.detail, ev.at, (select u.full_name from public.users u where u.id = ev.actor_id) as actor_name
        from public.quotation_events ev where ev.quotation_id = p_id order by ev.at desc limit 30) e), '[]'::jsonb)
  );
end $$;
revoke all on function public.quotation_get(uuid) from public, anon;
grant execute on function public.quotation_get(uuid) to authenticated;

create or replace function public.quotation_share(p_id uuid, p_on boolean default true)
returns text language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record; q public.quotations; v_token text;
begin
  select * into a from public.quotation_actor();
  select * into q from public.quotations where id = p_id for update;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if not public.quotation_may_edit(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_create, a.p_edit, a.p_view_all) then raise exception 'QUOTATIONS_FORBIDDEN: you may not share this quotation' using errcode = '42501'; end if;
  if not p_on then
    if q.share_token is not null then
      update public.quotations set share_token = null where id = p_id;
      insert into public.quotation_events (quotation_id, actor_id, kind) values (p_id, a.p_uid, 'unshared');
    end if;
    return null;
  end if;
  if q.status = 'archived' then raise exception 'QUOTATION_LOCKED: an archived quotation cannot be shared' using errcode = '22023'; end if;
  if not exists (select 1 from public.quotation_lines l where l.quotation_id = p_id) then
    raise exception 'QUOTATION_INVALID: add at least one product before sharing' using errcode = '22023';
  end if;
  if q.share_token is null and (public.quotation_price_state(p_id)->>'blocked')::boolean then
    raise exception 'QUOTATION_LOCKED: these prices need the pricing desk''s approval before the client link is turned on' using errcode = '55000';
  end if;
  v_token := coalesce(q.share_token, replace(gen_random_uuid()::text, '-', ''));
  update public.quotations set share_token = v_token, shared_at = coalesce(shared_at, now()),
    status = case when status = 'draft' then 'sent' else status end,
    sent_at = case when status = 'draft' then coalesce(sent_at, now()) else sent_at end
  where id = p_id;
  if q.share_token is null then
    insert into public.quotation_events (quotation_id, actor_id, kind) values (p_id, a.p_uid, 'shared');
  end if;
  return v_token;
end $$;
revoke all on function public.quotation_share(uuid, boolean) from public, anon;
grant execute on function public.quotation_share(uuid, boolean) to authenticated;

create or replace function public.quotation_link_pi(p_id uuid, p_submission_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record; q public.quotations; s record;
begin
  select * into a from public.quotation_actor();
  select * into q from public.quotations where id = p_id for update;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then
    raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.quotation_may_edit(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_create, a.p_edit, a.p_view_all) then
    raise exception 'QUOTATIONS_FORBIDDEN: you may not confirm this quotation' using errcode = '42501';
  end if;
  select os.id, os.created_by, os.status, os.draft_reference into s
    from public.order_submissions os where os.id = p_submission_id for update;
  if s.id is null or s.created_by is distinct from a.p_uid then
    raise exception 'QUOTATION_INVALID: that PI draft is not yours' using errcode = '22023';
  end if;
  if q.pi_submission_id = p_submission_id then
    return jsonb_build_object('status', q.status, 'pi_submission_id', p_submission_id, 'draft_reference', s.draft_reference);
  end if;
  if q.pi_submission_id is not null then
    raise exception 'QUOTATION_LOCKED: this quotation is already linked to a PI' using errcode = '55000';
  end if;
  if exists (select 1 from public.quotations o where o.pi_submission_id = p_submission_id) then
    raise exception 'QUOTATION_INVALID: that PI draft already belongs to another quotation' using errcode = '22023';
  end if;
  if q.status not in ('sent', 'negotiating') then
    raise exception 'QUOTATION_LOCKED: only a Sent or Negotiating quotation can be confirmed into a PI' using errcode = '55000';
  end if;
  if (public.quotation_price_state(p_id)->>'blocked')::boolean then
    raise exception 'QUOTATION_LOCKED: these prices need the pricing desk''s approval before a PI is made' using errcode = '55000';
  end if;
  if s.status <> 'draft' then
    raise exception 'QUOTATION_INVALID: that PI is no longer a draft' using errcode = '22023';
  end if;
  update public.quotations set status = 'confirmed', pi_submission_id = p_submission_id, pi_linked_at = now() where id = p_id;
  insert into public.quotation_events (quotation_id, actor_id, kind, detail)
  values (p_id, a.p_uid, 'converted', jsonb_build_object('from', q.status, 'pi_submission_id', p_submission_id, 'draft_reference', s.draft_reference));
  return jsonb_build_object('status', 'confirmed', 'pi_submission_id', p_submission_id, 'draft_reference', s.draft_reference);
end $$;
revoke all on function public.quotation_link_pi(uuid, uuid) from public, anon;
grant execute on function public.quotation_link_pi(uuid, uuid) to authenticated;

-- ═══ 6. Self-check ═══════════════════════════════════════════════════════════
do $$
begin
  if (select count(*) from public.quotation_price_settings) <> 1 then raise exception 'QUOTATION_PRICING: one settings row expected'; end if;
  if has_table_privilege('authenticated', 'public.quotation_price_reviews', 'select')
     or has_table_privilege('authenticated', 'public.quotation_price_settings', 'select') then
    raise exception 'QUOTATION_PRICING: the pricing tables must stay closed to client roles';
  end if;
  if has_function_privilege('authenticated', 'public.quotation_price_history(text[], uuid)', 'execute')
     or has_function_privilege('anon', 'public.quotation_price_hints(text[], uuid)', 'execute') then
    raise exception 'QUOTATION_PRICING: internal pricing functions must stay closed';
  end if;
  if public.quotation_name_words('Boho room · King bed with headboard') <> array['bed', 'headboard', 'king'] then
    raise exception 'QUOTATION_PRICING: quotation_name_words gives %', public.quotation_name_words('Boho room · King bed with headboard');
  end if;
end $$;
