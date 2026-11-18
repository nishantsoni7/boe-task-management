-- The logo mark on a quotation's pictures is optional per quotation (owner, 18 Nov 2026: "a toggle in each quotation
-- where a sales candidate or senior can go and disable it. By default it will be enabled"). On unless somebody who may
-- edit the quotation turns it off; the change is live (the client link and the PDF follow it at once).
--
-- A NEW small table, so no existing table or row changes: one row only for a quotation where the mark was ever switched,
-- none meaning "on". Closed to every client role; read and written only by the two functions below (and, for serving the
-- clean picture, by the server with the service role).
--
--   quotation_picture_mark_get(id)      -> true / false, or null when the caller may not see the quotation
--   quotation_picture_mark_set(id, on)  -> the new value; the same people who may edit the quotation; not an archived one
--
-- Rollback: drop both functions and the table (every quotation then shows the mark again).

begin;

create table public.quotation_picture_marks (
  quotation_id uuid primary key references public.quotations(id) on delete cascade,
  enabled      boolean not null,
  changed_by   uuid references public.users(id),
  changed_at   timestamptz not null default now()
);
alter table public.quotation_picture_marks enable row level security;
revoke all on table public.quotation_picture_marks from public, anon, authenticated;

create or replace function public.quotation_picture_mark_get(p_id uuid)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record; q public.quotations;
begin
  if auth.uid() is null or not public.module_entry_open('quotations') then return null; end if;
  select * into a from public.quotation_actor();
  select * into q from public.quotations where id = p_id;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then return null; end if;
  return coalesce((select m.enabled from public.quotation_picture_marks m where m.quotation_id = p_id), true);
end $$;
revoke all on function public.quotation_picture_mark_get(uuid) from public, anon;
grant execute on function public.quotation_picture_mark_get(uuid) to authenticated;

create or replace function public.quotation_picture_mark_set(p_id uuid, p_on boolean)
returns boolean language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record; q public.quotations;
begin
  if p_on is null then raise exception 'QUOTATION_INVALID: say whether the logo is on' using errcode = '22023'; end if;
  select * into a from public.quotation_actor();
  select * into q from public.quotations where id = p_id for update;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if not public.quotation_may_edit(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_create, a.p_edit, a.p_view_all) then
    raise exception 'QUOTATIONS_FORBIDDEN: you may not change this quotation' using errcode = '42501';
  end if;
  if q.status = 'archived' then raise exception 'QUOTATION_LOCKED: an archived quotation cannot be changed' using errcode = '22023'; end if;
  insert into public.quotation_picture_marks (quotation_id, enabled, changed_by, changed_at)
  values (p_id, p_on, a.p_uid, now())
  on conflict (quotation_id) do update set enabled = excluded.enabled, changed_by = excluded.changed_by, changed_at = excluded.changed_at;
  insert into public.quotation_events (quotation_id, actor_id, kind, detail)
  values (p_id, a.p_uid, 'saved', jsonb_build_object('picture_mark', p_on));
  return p_on;
end $$;
revoke all on function public.quotation_picture_mark_set(uuid, boolean) from public, anon;
grant execute on function public.quotation_picture_mark_set(uuid, boolean) to authenticated;

do $$
begin
  if has_table_privilege('authenticated', 'public.quotation_picture_marks', 'select')
     or has_table_privilege('anon', 'public.quotation_picture_marks', 'select') then
    raise exception 'QUOTATION_PICTURE_MARKS: the table must stay closed to client roles';
  end if;
  if has_function_privilege('anon', 'public.quotation_picture_mark_get(uuid)', 'execute')
     or has_function_privilege('anon', 'public.quotation_picture_mark_set(uuid, boolean)', 'execute') then
    raise exception 'QUOTATION_PICTURE_MARKS: anon may call a function';
  end if;
end $$;

commit;
