-- 20270814000200_quotation_requests.sql
--
-- Quotation requests live INSIDE Quotations (owner, 20 Nov 2026: "remove the Quotation Request from the task management altogether ...
-- create a Quotation Request option in that module. Each sales candidate creates their own quotation and sends it either to the client or to
-- a senior, to take the prices or to get the prices verified.").
--
-- A request is now "this quotation was sent to a senior": quotation_requests (quotation, from, to, kind price | verify, note, status
-- pending | answered | withdrawn). The senior opens the quotation, prices or checks it, and sends it back with a note. The old requests that
-- are tasks stay where they are (read-only history); nothing in Tasks is changed or dropped here.
--
--   quotation_desk_people()                       who may be asked: an administrator, or a person with Quotations edit + see all (the pricing desk)
--   quotation_request_send(q, to, kind, note)     the quotation's editor asks; one open request per quotation
--   quotation_request_answer(id, note)            the person asked (or an administrator) sends it back
--   quotation_request_withdraw(id)                the asker (or an administrator) takes it back
--   quotation_ask_state(q)                        for the builder card: open request, last answer, what the caller may do
--   quotation_requests_list()                     for the Requests page: mine (asked by or sent to me); an administrator sees all
--   quotation_requests_count()                    pending requests sent to me (the menu badge)
--
-- WRITE: one new table (closed to the browser), the history kinds 'asked' and 'answered' added to quotation_events' CHECK, new functions.
-- ROLLBACK: drop the functions above; drop table public.quotation_requests; restore quotation_events_kind_check without 'asked' and 'answered'
--   (after deleting those events with the append-only trigger disabled).

do $$
begin
  if to_regprocedure('public.quotation_actor()') is null or to_regprocedure('public.quotation_value_before_gst(uuid)') is null
     or to_regprocedure('public.quotation_may_edit(uuid, uuid, uuid, boolean, boolean, boolean, boolean)') is null then
    raise exception 'DEPENDENCY MISSING: the Quotations module (20270614000000) must exist';
  end if;
end $$;

create table public.quotation_requests (
  id            uuid primary key default gen_random_uuid(),
  quotation_id  uuid not null references public.quotations (id) on delete cascade,
  requested_by  uuid not null references public.users (id),
  to_user       uuid not null references public.users (id),
  kind          text not null check (kind in ('price', 'verify')),
  note          text check (char_length(note) <= 1000),
  status        text not null default 'pending' check (status in ('pending', 'answered', 'withdrawn')),
  created_at    timestamptz not null default now(),
  answered_at   timestamptz,
  answered_by   uuid references public.users (id),
  answer_note   text check (char_length(answer_note) <= 1000),
  check (requested_by <> to_user)
);
create unique index quotation_requests_one_open on public.quotation_requests (quotation_id) where status = 'pending';
create index quotation_requests_to_idx on public.quotation_requests (to_user, status, created_at desc);
create index quotation_requests_by_idx on public.quotation_requests (requested_by, created_at desc);
alter table public.quotation_requests enable row level security;
revoke all on public.quotation_requests from public, anon, authenticated;

alter table public.quotation_events drop constraint quotation_events_kind_check;
alter table public.quotation_events add constraint quotation_events_kind_check
  check (kind in ('created', 'saved', 'status', 'shared', 'unshared', 'opened', 'converted', 'price', 'version', 'asked', 'answered'));

-- Internal: is this person on the pricing desk (an active administrator, or Quotations edit + see all)?
create or replace function public.quotation_is_desk(p_user uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.users u
    where u.id = p_user and u.is_active and coalesce(u.is_deleted, false) = false
      and (u.role = 'admin'
           or (public.resolve_permission(u.id, 'quotations', 'view') and public.resolve_permission(u.id, 'quotations', 'edit')
               and public.resolve_permission(u.id, 'quotations', 'view_all')))
  )
$$;
revoke all on function public.quotation_is_desk(uuid) from public, anon, authenticated;

create or replace function public.quotation_desk_people()
returns table (id uuid, full_name text)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.quotation_actor();
  return query
    select u.id, u.full_name from public.users u
    where u.id <> a.p_uid and public.quotation_is_desk(u.id)
    order by (u.role = 'admin') desc, u.full_name;
end $$;
revoke all on function public.quotation_desk_people() from public, anon;
grant execute on function public.quotation_desk_people() to authenticated;

create or replace function public.quotation_request_send(p_quotation uuid, p_to uuid, p_kind text, p_note text default null)
returns uuid language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record; q public.quotations; v_id uuid;
begin
  select * into a from public.quotation_actor();
  select * into q from public.quotations where id = p_quotation for update;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if not public.quotation_may_edit(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_create, a.p_edit, a.p_view_all) then
    raise exception 'QUOTATIONS_FORBIDDEN: you may not change this quotation' using errcode = '42501';
  end if;
  if q.status not in ('draft', 'sent', 'negotiating') then
    raise exception 'QUOTATION_LOCKED: a % quotation cannot be sent to a senior', q.status using errcode = '22023';
  end if;
  if p_kind not in ('price', 'verify') then raise exception 'QUOTATION_INVALID: choose what you need from them' using errcode = '22023'; end if;
  if p_to is null or p_to = a.p_uid or not public.quotation_is_desk(p_to) then
    raise exception 'QUOTATION_INVALID: choose a senior who can price quotations' using errcode = '22023';
  end if;
  if exists (select 1 from public.quotation_requests r where r.quotation_id = p_quotation and r.status = 'pending') then
    raise exception 'QUOTATION_LOCKED: this quotation is already with a senior' using errcode = '22023';
  end if;
  insert into public.quotation_requests (quotation_id, requested_by, to_user, kind, note)
  values (p_quotation, a.p_uid, p_to, p_kind, nullif(left(btrim(coalesce(p_note, '')), 1000), ''))
  returning id into v_id;
  insert into public.quotation_events (quotation_id, actor_id, kind, detail)
  values (p_quotation, a.p_uid, 'asked', jsonb_build_object('to', p_to, 'kind', p_kind, 'request', v_id));
  return v_id;
end $$;
revoke all on function public.quotation_request_send(uuid, uuid, text, text) from public, anon;
grant execute on function public.quotation_request_send(uuid, uuid, text, text) to authenticated;

create or replace function public.quotation_request_answer(p_id uuid, p_note text default null)
returns void language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record; r public.quotation_requests;
begin
  select * into a from public.quotation_actor();
  select * into r from public.quotation_requests where id = p_id for update;
  if r.id is null or not (r.to_user = a.p_uid or a.p_admin) then raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'pending' then raise exception 'QUOTATION_LOCKED: this request is already closed' using errcode = '22023'; end if;
  update public.quotation_requests set status = 'answered', answered_at = now(), answered_by = a.p_uid,
    answer_note = nullif(left(btrim(coalesce(p_note, '')), 1000), '') where id = p_id;
  insert into public.quotation_events (quotation_id, actor_id, kind, detail)
  values (r.quotation_id, a.p_uid, 'answered', jsonb_build_object('request', p_id, 'kind', r.kind));
end $$;
revoke all on function public.quotation_request_answer(uuid, text) from public, anon;
grant execute on function public.quotation_request_answer(uuid, text) to authenticated;

create or replace function public.quotation_request_withdraw(p_id uuid)
returns void language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record; r public.quotation_requests;
begin
  select * into a from public.quotation_actor();
  select * into r from public.quotation_requests where id = p_id for update;
  if r.id is null or not (r.requested_by = a.p_uid or a.p_admin) then raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'pending' then raise exception 'QUOTATION_LOCKED: this request is already closed' using errcode = '22023'; end if;
  update public.quotation_requests set status = 'withdrawn', answered_at = now(), answered_by = a.p_uid where id = p_id;
end $$;
revoke all on function public.quotation_request_withdraw(uuid) from public, anon;
grant execute on function public.quotation_request_withdraw(uuid) to authenticated;

-- One request as the screens show it.
create or replace function public.quotation_request_json(r public.quotation_requests)
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object('id', r.id, 'kind', r.kind, 'note', r.note, 'status', r.status, 'created_at', r.created_at,
    'answered_at', r.answered_at, 'answer_note', r.answer_note,
    'from_id', r.requested_by, 'from_name', (select u.full_name from public.users u where u.id = r.requested_by),
    'to_id', r.to_user, 'to_name', (select u.full_name from public.users u where u.id = r.to_user),
    'answered_by_name', (select u.full_name from public.users u where u.id = r.answered_by))
$$;
revoke all on function public.quotation_request_json(public.quotation_requests) from public, anon, authenticated;

create or replace function public.quotation_ask_state(p_quotation uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record; q public.quotations; v_open public.quotation_requests; v_last public.quotation_requests;
begin
  select * into a from public.quotation_actor();
  select * into q from public.quotations where id = p_quotation;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_open from public.quotation_requests where quotation_id = p_quotation and status = 'pending';
  select * into v_last from public.quotation_requests where quotation_id = p_quotation and status = 'answered' order by answered_at desc limit 1;
  return jsonb_build_object(
    'open', case when v_open.id is not null then public.quotation_request_json(v_open) end,
    'last', case when v_last.id is not null then public.quotation_request_json(v_last) end,
    'may_ask', v_open.id is null and q.status in ('draft', 'sent', 'negotiating')
               and public.quotation_may_edit(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_create, a.p_edit, a.p_view_all),
    'may_answer', v_open.id is not null and (v_open.to_user = a.p_uid or a.p_admin),
    'may_withdraw', v_open.id is not null and (v_open.requested_by = a.p_uid or a.p_admin));
end $$;
revoke all on function public.quotation_ask_state(uuid) from public, anon;
grant execute on function public.quotation_ask_state(uuid) to authenticated;

create or replace function public.quotation_requests_list()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.quotation_actor();
  return coalesce((
    select jsonb_agg(public.quotation_request_json(r) || jsonb_build_object(
      'quotation_id', q.id, 'quote_no', q.quote_no, 'client_name', q.client_name, 'project_name', q.project_name, 'quotation_status', q.status,
      'value', public.quotation_value_before_gst(q.id),
      'lead_no', (select l.lead_no from public.sales_leads l where l.id = q.lead_id)) order by r.created_at desc)
    from (select * from public.quotation_requests x
          where a.p_admin or x.requested_by = a.p_uid or x.to_user = a.p_uid
          order by x.created_at desc limit 500) r
    join public.quotations q on q.id = r.quotation_id), '[]'::jsonb);
end $$;
revoke all on function public.quotation_requests_list() from public, anon;
grant execute on function public.quotation_requests_list() to authenticated;

create or replace function public.quotation_requests_count()
returns integer language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.quotation_actor();
  return (select count(*)::int from public.quotation_requests r where r.status = 'pending' and r.to_user = a.p_uid);
end $$;
revoke all on function public.quotation_requests_count() from public, anon;
grant execute on function public.quotation_requests_count() to authenticated;

do $$
declare v_fn text;
begin
  foreach v_fn in array array['public.quotation_desk_people()', 'public.quotation_request_send(uuid, uuid, text, text)', 'public.quotation_request_answer(uuid, text)',
    'public.quotation_request_withdraw(uuid)', 'public.quotation_ask_state(uuid)', 'public.quotation_requests_list()', 'public.quotation_requests_count()'] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE') or not has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      raise exception 'QUOTATION_REQUESTS: % must be callable by signed-in people only', v_fn;
    end if;
  end loop;
  if has_table_privilege('anon', 'public.quotation_requests', 'SELECT') or has_table_privilege('authenticated', 'public.quotation_requests', 'SELECT') then
    raise exception 'QUOTATION_REQUESTS: the table must stay closed to the browser';
  end if;
end $$;
