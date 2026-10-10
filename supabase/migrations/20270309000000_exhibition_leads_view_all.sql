-- Exhibition Leads: a "View All Leads" permission — read-only sight of everyone's leads, and out of the ranking.
--
-- WHY. Some people (a manager outside Sales) need to SEE every lead the way Admin does, without being
-- Admin and without being a competitor on the leaderboard. This adds one action, 'view_all', to the
-- exhibition_leads module (the same global action key Orders and Finance already use; Control Center shows
-- it for this module as "View All Leads").
--
-- WHAT A HOLDER GETS (and only this)
--   * the "All Exhibition Leads" list, with its collector / owner / archived filters, and any lead's sheet
--     and card photograph — READ ONLY. Every write (edit, note, reassign, archive, attach a photo) still
--     requires Admin or being the lead's current owner: those functions are not touched.
--   * the people list the filters need (names only).
--   * NOT the CSV export, NOT the Ranking page, NOT Exhibitions management: those stay Admin.
--
-- WHAT A HOLDER LOSES: the ranking. Someone who holds view_all is left out of the fair ranking and of the
-- leaderboard on Add Lead / My Leads — even if they have collected leads (the leads themselves are untouched
-- and stay in their owner's list). Admin (role) is not affected: Admin is never "a holder".
--
-- NOBODY IS GRANTED IT HERE. The default is off. An administrator grants it per person or department in
-- Control Center (Permissions → Exhibition Leads).
--
-- ADDITIVE except for six functions re-created with exactly the changes named above (their bodies are
-- otherwise the text of 20270305000000 / 20270307000000 / 20270308000000):
--   exhibition_leads_page, get_exhibition_lead, exhibition_lead_people, exhibition_lead_ranking,
--   exhibition_lead_standings, exhibition_lead_card_readable.
--
-- ROLLBACK: re-create those six functions from the migrations named above, drop exhibition_leads_viewer()
-- and exhibition_leads_my_access(), and delete the module_permission_actions / role_permissions rows added
-- in section 1 (and any grants of view_all that were made on this module).

do $$
begin
  if to_regclass('public.exhibition_leads') is null
     or to_regprocedure('public.exhibition_leads_actor()') is null
     or to_regprocedure('public.exhibition_lead_card_readable(text,text)') is null
     or to_regprocedure('public.exhibition_lead_standings(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20270305000000, 20270307000000 and 20270308000000 must be applied first';
  end if;
  if not exists (select 1 from public.permission_actions where action_key = 'view_all') then
    raise exception 'DEPENDENCY MISSING: the global view_all action (20260903000000) must exist';
  end if;
end $$;

-- ═══ 1. Register the action (default off) ═══════════════════════════════════
insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key = 'view_all'
where pm.module_key = 'exhibition_leads'
on conflict (module_id, action_id) do nothing;

-- Admin (role) holds it like every other action of the module.
insert into public.role_permissions (role, module_id, action_id, allowed)
select 'admin', mpa.module_id, mpa.action_id, true
from public.module_permission_actions mpa
join public.permission_modules pm on pm.id = mpa.module_id and pm.module_key = 'exhibition_leads'
join public.permission_actions pa on pa.id = mpa.action_id and pa.action_key = 'view_all'
on conflict (role, module_id, action_id) do nothing;

-- ═══ 2. Who is a "view-all holder" ══════════════════════════════════════════
-- A person WITHOUT the Admin role who may use the module and holds view_all. Admin is deliberately not
-- included: Admin already sees everything and stays on the ranking as before.
create or replace function public.exhibition_leads_viewer(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.users u
    where u.id = p_uid
      and u.role <> 'admin'
      and public.exhibition_leads_user_eligible(u.id)
      and public.resolve_permission(u.id, 'exhibition_leads', 'view_all')
  );
$$;

revoke all on function public.exhibition_leads_viewer(uuid) from public, anon, authenticated;

-- What the screens need to decide what to show: the caller's own answer, nothing about anyone else.
create or replace function public.exhibition_leads_my_access()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid;
  v_admin boolean;
begin
  select a.p_uid, a.p_is_admin into v_uid, v_admin from public.exhibition_leads_actor() a;
  return jsonb_build_object('is_admin', v_admin, 'view_all', v_admin or public.exhibition_leads_viewer(v_uid));
end;
$$;

revoke all on function public.exhibition_leads_my_access() from public, anon;
grant execute on function public.exhibition_leads_my_access() to authenticated;

-- ═══ 3. The read functions, one line each ═══════════════════════════════════

create or replace function public.exhibition_leads_page(
  p_filter jsonb default '{}'::jsonb, p_limit integer default 25, p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid;
  v_admin   boolean;
  v_today   date := (now() at time zone 'Asia/Kolkata')::date;
  v_limit   integer := greatest(0, least(coalesce(p_limit, 25), 100));
  v_offset  integer := greatest(0, coalesce(p_offset, 0));
  v_exh     uuid;
  v_result  jsonb;
begin
  select a.p_uid, a.p_is_admin into v_uid, v_admin from public.exhibition_leads_actor() a;
  -- A view-all holder reads the whole list exactly as Admin does; every write still checks Admin or owner.
  v_admin := v_admin or public.exhibition_leads_viewer(v_uid);
  p_filter := coalesce(p_filter, '{}'::jsonb);
  v_exh := nullif(p_filter ->> 'exhibition_id', '')::uuid;

  with f as materialized (
    select * from public.exhibition_leads_filtered(v_uid, v_admin, p_filter)
  ),
  page as (
    select * from f order by created_at desc, id desc limit v_limit offset v_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from f),
    'date_counts', coalesce((
      select jsonb_agg(jsonb_build_object('date', d, 'count', n) order by d desc)
      from (select (created_at at time zone 'Asia/Kolkata')::date d, count(*) n from f group by 1) x), '[]'::jsonb),
    'rows', coalesce((
      select jsonb_agg(public.exhibition_lead_json(p.id) order by p.created_at desc, p.id desc) from page p), '[]'::jsonb),
    'summary', jsonb_build_object(
      'active_valid', (select count(*) from f where archived_at is null),
      'hot', (select count(*) from f where archived_at is null and lead_type = 'hot'),
      'overdue', (select count(*) from f
                   where archived_at is null
                     and status not in ('converted', 'not_proceeding')
                     and next_follow_up_on < v_today)
    ),
    'mine', jsonb_build_object(
      -- "My Leads" is what I currently own; "collected" is what I originally took.
      'owned_today', (select count(*) from public.exhibition_leads l
                       where l.owner_id = v_uid and l.archived_at is null
                         and (v_exh is null or l.exhibition_id = v_exh)
                         and l.created_at >= (v_today::timestamp at time zone 'Asia/Kolkata')
                         and l.created_at <  ((v_today + 1)::timestamp at time zone 'Asia/Kolkata')),
      'owned_total', (select count(*) from public.exhibition_leads l
                       where l.owner_id = v_uid and l.archived_at is null
                         and (v_exh is null or l.exhibition_id = v_exh)),
      'collected_total', (select count(*) from public.exhibition_leads l
                           where l.collected_by = v_uid and l.archived_at is null
                             and (v_exh is null or l.exhibition_id = v_exh))
    ),
    'cities', coalesce((
      select jsonb_agg(c order by c) from (
        select distinct l.project_city c from public.exhibition_leads l
        where l.project_city is not null
          and (v_admin or l.owner_id = v_uid)
          and (v_exh is null or l.exhibition_id = v_exh)) y), '[]'::jsonb),
    'today', v_today
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.exhibition_leads_page(jsonb, integer, integer) from public, anon;
grant execute on function public.exhibition_leads_page(jsonb, integer, integer) to authenticated;

create or replace function public.get_exhibition_lead(p_lead_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid;
  v_admin boolean;
  v_lead  public.exhibition_leads;
begin
  select a.p_uid, a.p_is_admin into v_uid, v_admin from public.exhibition_leads_actor() a;
  v_admin := v_admin or public.exhibition_leads_viewer(v_uid);
  select * into v_lead from public.exhibition_leads l where l.id = p_lead_id;
  if not found or not (v_admin or v_lead.owner_id = v_uid) then
    raise exception 'EXHIBITION_LEADS_NOT_FOUND: Lead not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'lead', public.exhibition_lead_json(v_lead.id),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'event_type', e.event_type, 'note', e.note, 'detail', e.detail,
        'created_at', e.created_at, 'actor_id', e.actor_id,
        'actor_name', (select u.full_name from public.users u where u.id = e.actor_id))
        order by e.created_at desc, e.id desc)
      from public.exhibition_lead_events e where e.lead_id = v_lead.id), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_exhibition_lead(uuid) from public, anon;
grant execute on function public.get_exhibition_lead(uuid) to authenticated;

create or replace function public.exhibition_lead_people(p_exhibition_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid;
  v_admin boolean;
begin
  select a.p_uid, a.p_is_admin into v_uid, v_admin from public.exhibition_leads_actor() a;
  if not (v_admin or public.exhibition_leads_viewer(v_uid)) then
    raise exception 'EXHIBITION_LEADS_FORBIDDEN: Admin only' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', u.id, 'name', u.full_name, 'eligible', el.ok)
                     order by u.full_name)
    from public.users u
    cross join lateral (select public.exhibition_leads_user_eligible(u.id) ok) el
    where el.ok
       or exists (select 1 from public.exhibition_leads l
                  where (l.collected_by = u.id or l.owner_id = u.id)
                    and (p_exhibition_id is null or l.exhibition_id = p_exhibition_id))
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.exhibition_lead_people(uuid) from public, anon;
grant execute on function public.exhibition_lead_people(uuid) to authenticated;

-- ═══ 4. Out of the ranking ══════════════════════════════════════════════════

create or replace function public.exhibition_lead_ranking(p_exhibition_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin boolean;
  v_exh   public.exhibitions;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  select a.p_is_admin into v_admin from public.exhibition_leads_actor() a;
  if not v_admin then
    raise exception 'EXHIBITION_LEADS_FORBIDDEN: Admin only' using errcode = '42501';
  end if;
  select * into v_exh from public.exhibitions e where e.id = p_exhibition_id;
  if not found then
    raise exception 'EXHIBITION_LEADS_NOT_FOUND: Exhibition not found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'exhibition', jsonb_build_object('id', v_exh.id, 'name', v_exh.name,
                                     'starts_on', v_exh.starts_on, 'ends_on', v_exh.ends_on),
    'today', v_today,
    'is_final', v_today > v_exh.ends_on,
    'days', (select jsonb_agg(d::date order by d) from generate_series(v_exh.starts_on, v_exh.ends_on, interval '1 day') d),
    'rows', coalesce((
      with credit as (
        select l.collected_by, (l.created_at at time zone 'Asia/Kolkata')::date d, count(*) n
        from public.exhibition_leads l
        where l.exhibition_id = v_exh.id
          and l.archived_at is null
          and (l.created_at at time zone 'Asia/Kolkata')::date between v_exh.starts_on and v_exh.ends_on
        group by 1, 2
      ),
      people as (
        select u.id, u.full_name from public.users u
        where not public.exhibition_leads_viewer(u.id)
          and ((u.role <> 'admin' and public.exhibition_leads_user_eligible(u.id))
               or u.id in (select collected_by from credit))
      )
      select jsonb_agg(jsonb_build_object(
          'user_id', p.id,
          'name', p.full_name,
          'per_day', coalesce((select jsonb_object_agg(c.d::text, c.n) from credit c where c.collected_by = p.id), '{}'::jsonb),
          'total', coalesce((select sum(c.n) from credit c where c.collected_by = p.id), 0))
        order by coalesce((select sum(c.n) from credit c where c.collected_by = p.id), 0) desc, p.full_name)
      from people p), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.exhibition_lead_ranking(uuid) from public, anon;
grant execute on function public.exhibition_lead_ranking(uuid) to authenticated;

create or replace function public.exhibition_lead_standings(p_exhibition_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid;
  v_exh   public.exhibitions;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  select a.p_uid into v_uid from public.exhibition_leads_actor() a;
  select * into v_exh from public.exhibitions e where e.id = p_exhibition_id;
  if not found then
    raise exception 'EXHIBITION_LEADS_NOT_FOUND: Exhibition not found' using errcode = 'P0002';
  end if;

  return (
    with credit as (
      select l.collected_by,
             count(*) as total,
             count(*) filter (where (l.created_at at time zone 'Asia/Kolkata')::date = v_today) as today
      from public.exhibition_leads l
      where l.exhibition_id = v_exh.id
        and l.archived_at is null
        and (l.created_at at time zone 'Asia/Kolkata')::date between v_exh.starts_on and v_exh.ends_on
      group by l.collected_by
    ),
    people as (
      select u.id, u.full_name from public.users u
      where not public.exhibition_leads_viewer(u.id)
        and ((u.role <> 'admin' and public.exhibition_leads_user_eligible(u.id))
             or u.id in (select collected_by from credit))
    ),
    scored as (
      select p.id, p.full_name,
             coalesce(c.total, 0) as total,
             coalesce(c.today, 0) as today
      from people p left join credit c on c.collected_by = p.id
    ),
    ranked as (
      select s.*,
             case when s.total > 0 then rank() over (order by s.total desc) end as pos
      from scored s
    )
    select jsonb_build_object(
      'exhibition_id', v_exh.id,
      'today', v_today,
      'is_final', v_today > v_exh.ends_on,
      'participants', (select count(*) from ranked),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
            'name', r.full_name,
            'total', r.total,
            'today', r.today,
            'rank', r.pos,
            'is_me', r.id = v_uid)
          order by r.total desc, r.full_name, r.id)
        from ranked r), '[]'::jsonb)
    )
  );
end;
$$;

revoke all on function public.exhibition_lead_standings(uuid) from public, anon;
grant execute on function public.exhibition_lead_standings(uuid) to authenticated;

-- ═══ 5. The card photograph follows the list ════════════════════════════════

create or replace function public.exhibition_lead_card_readable(p_name text, p_owner_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid   uuid := auth.uid();
  v_owner uuid;
begin
  if v_uid is null or p_name is null or not public.exhibition_leads_user_eligible(v_uid) then
    return false;
  end if;
  select l.owner_id into v_owner from public.exhibition_leads l where l.card_photo_path = p_name;
  if found then
    return v_owner = v_uid
        or public.exhibition_leads_viewer(v_uid)
        or exists (select 1 from public.users u where u.id = v_uid and u.role = 'admin');
  end if;
  return p_owner_id is not null and p_owner_id = v_uid::text;
end;
$fn$;

revoke all on function public.exhibition_lead_card_readable(text, text) from public, anon;
grant execute on function public.exhibition_lead_card_readable(text, text) to authenticated;

-- ═══ Executed self-check ════════════════════════════════════════════════════
do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.exhibition_leads_page(jsonb,integer,integer)', 'public.get_exhibition_lead(uuid)',
    'public.exhibition_lead_people(uuid)', 'public.exhibition_lead_ranking(uuid)',
    'public.exhibition_lead_standings(uuid)', 'public.exhibition_lead_card_readable(text,text)',
    'public.exhibition_leads_my_access()'
  ] loop
    if not has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE')
       or has_function_privilege('anon', v_fn::regprocedure, 'EXECUTE') then
      raise exception 'EXHIBITION_VIEW_ALL_ACL: wrong execute grants on %', v_fn;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'public.exhibition_leads_viewer(uuid)'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public.exhibition_leads_viewer(uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'EXHIBITION_VIEW_ALL_ACL: exhibition_leads_viewer became callable by clients';
  end if;
  -- Nobody holds it by default: no department rule for view_all exists on this module.
  if exists (
    select 1 from public.department_permissions dp
    join public.permission_modules pm on pm.id = dp.module_id and pm.module_key = 'exhibition_leads'
    join public.permission_actions pa on pa.id = dp.action_id and pa.action_key = 'view_all'
  ) then
    raise exception 'EXHIBITION_VIEW_ALL_ACL: a department holds view_all by default';
  end if;
end $$;
