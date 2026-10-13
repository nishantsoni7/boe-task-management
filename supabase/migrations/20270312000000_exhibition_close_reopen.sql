-- Exhibition Leads — Admin closes and re-opens an exhibition in one step.
--
-- WHAT THIS IS
-- ------------
-- "Closed" already existed: update_exhibition(p_is_active => false) makes
-- create_exhibition_lead refuse new leads, and leads, ranking and export stay
-- readable. But it was reachable only by re-sending every field of the Edit
-- sheet, and nothing recorded who closed the exhibition or when. This adds:
--
--   set_exhibition_open(p_id, p_open)   Admin closes / re-opens one exhibition,
--                                       touching nothing else about it.
--   exhibitions.closed_at / closed_by   Stamped by a trigger whenever is_active
--                                       changes, from ANY path (this function or
--                                       update_exhibition), cleared on re-open.
--   list_exhibitions_admin()            Same list, now also carrying closed_at
--                                       and the closer's name.
--
-- The app reads is_active to decide whether the "Add Exhibition Lead" quick link,
-- the Add Lead navigation item and the Add Lead bar are shown at all: when every
-- exhibition is closed they disappear, with no deploy.
--
-- RULES (unchanged, restated because closing makes them matter)
-- -------------------------------------------------------------
--   * Admin only; the check is inside the function (exhibition_leads_actor()).
--   * Closing deletes and hides nothing. Leads of a closed exhibition stay listed.
--   * Their owner may still EDIT them (update_exhibition_lead has no exhibition
--     condition) — a salesperson keeps working the follow-ups after the fair.
--   * Removing a lead (archive_exhibition_lead / restore_exhibition_lead) is Admin
--     only, open or closed. No other role has a delete path.
--
-- ROLLBACK: drop function set_exhibition_open(uuid, boolean); drop trigger
-- exhibitions_stamp_closed on exhibitions and function exhibitions_stamp_closed();
-- drop columns closed_at, closed_by; recreate list_exhibitions_admin() from
-- 20270306000000.

do $$
begin
  if to_regprocedure('public.update_exhibition(uuid,text,text,date,date,boolean)') is null
     or to_regprocedure('public.list_exhibitions_admin()') is null then
    raise exception 'DEPENDENCY MISSING: 20270306000000_exhibition_management.sql must be applied first';
  end if;
end $$;

alter table public.exhibitions
  add column closed_at timestamptz,
  add column closed_by uuid references public.users(id);

-- A closed exhibition says when; an open one says nothing.
alter table public.exhibitions
  add constraint exhibitions_closed_consistent
  check (is_active = (closed_at is null)) not valid;

-- Rows that are already closed predate the stamp: their moment is unknown, so
-- the stamp is the migration's, not a guess at the real one.
update public.exhibitions set closed_at = now() where not is_active and closed_at is null;
alter table public.exhibitions validate constraint exhibitions_closed_consistent;

create or replace function public.exhibitions_stamp_closed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.is_active then
    new.closed_at := null;
    new.closed_by := null;
  elsif tg_op = 'UPDATE' then
    if old.is_active then
      new.closed_at := now();
      new.closed_by := auth.uid();
    else
      -- Already closed and staying closed: keep the original stamp.
      new.closed_at := old.closed_at;
      new.closed_by := old.closed_by;
    end if;
  else
    new.closed_at := now();
    new.closed_by := auth.uid();
  end if;
  return new;
end;
$$;

revoke all on function public.exhibitions_stamp_closed() from public, anon, authenticated;

create trigger exhibitions_stamp_closed
  before insert or update of is_active on public.exhibitions
  for each row execute function public.exhibitions_stamp_closed();

create or replace function public.set_exhibition_open(p_id uuid, p_open boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin boolean;
  v_old   public.exhibitions;
begin
  select a.p_is_admin into v_admin from public.exhibition_leads_actor() a;
  if not v_admin then
    raise exception 'EXHIBITION_LEADS_FORBIDDEN: Admin only' using errcode = '42501';
  end if;
  if p_open is null then
    raise exception 'EXHIBITION_LEADS_INVALID: Say whether it is open for new leads' using errcode = '22023';
  end if;
  select * into v_old from public.exhibitions e where e.id = p_id for update;
  if not found then
    raise exception 'EXHIBITION_LEADS_NOT_FOUND: Exhibition not found' using errcode = 'P0002';
  end if;
  if v_old.is_active = p_open then
    return jsonb_build_object('outcome', 'unchanged', 'id', p_id, 'is_active', p_open);
  end if;
  update public.exhibitions e set is_active = p_open where e.id = p_id;
  return jsonb_build_object('outcome', case when p_open then 'opened' else 'closed' end,
                            'id', p_id, 'is_active', p_open);
end;
$$;

revoke all on function public.set_exhibition_open(uuid, boolean) from public, anon;
grant execute on function public.set_exhibition_open(uuid, boolean) to authenticated;

create or replace function public.list_exhibitions_admin()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin boolean;
begin
  select a.p_is_admin into v_admin from public.exhibition_leads_actor() a;
  if not v_admin then
    raise exception 'EXHIBITION_LEADS_FORBIDDEN: Admin only' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', e.id, 'slug', e.slug, 'name', e.name, 'city', e.city,
        'starts_on', e.starts_on, 'ends_on', e.ends_on, 'is_active', e.is_active,
        'closed_at', e.closed_at,
        'closed_by_name', (select u.full_name from public.users u where u.id = e.closed_by),
        'leads', (select count(*) from public.exhibition_leads l where l.exhibition_id = e.id and l.archived_at is null),
        'archived', (select count(*) from public.exhibition_leads l where l.exhibition_id = e.id and l.archived_at is not null))
      order by e.starts_on desc, e.name)
    from public.exhibitions e), '[]'::jsonb);
end;
$$;

revoke all on function public.list_exhibitions_admin() from public, anon;
grant execute on function public.list_exhibitions_admin() to authenticated;

-- ═══ Executed self-check ════════════════════════════════════════════════════
do $$
begin
  if not has_function_privilege('authenticated', 'public.set_exhibition_open(uuid,boolean)'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public.set_exhibition_open(uuid,boolean)'::regprocedure, 'EXECUTE') then
    raise exception 'EXHIBITION_CLOSE_ACL: wrong execute grants on set_exhibition_open';
  end if;
  if has_function_privilege('authenticated', 'public.exhibitions_stamp_closed()'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public.exhibitions_stamp_closed()'::regprocedure, 'EXECUTE') then
    raise exception 'EXHIBITION_CLOSE_ACL: the stamp trigger function is callable by clients';
  end if;
  if has_table_privilege('authenticated', 'public.exhibitions', 'UPDATE') then
    raise exception 'EXHIBITION_CLOSE_ACL: exhibitions became writable by clients';
  end if;
end $$;
