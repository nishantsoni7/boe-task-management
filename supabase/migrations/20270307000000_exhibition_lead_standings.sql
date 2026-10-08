-- Exhibition Leads — "where do I stand": the leaderboard a salesperson sees on
-- the Add Lead screen.
--
-- WHY
-- ---
-- exhibition_lead_ranking() is Admin-only and returns a per-day matrix. A
-- salesperson standing at a stand needs three numbers (today, total, position)
-- and a short board, not the matrix. This adds ONE read-only door for that and
-- changes nothing that exists.
--
-- WHAT IT SHOWS, AND TO WHOM
-- --------------------------
--   * Any person who may use the module (the same exhibition_leads_actor()
--     check as every other door) sees each colleague's NAME and two counts:
--     leads collected today and in total. That is deliberate: a board you
--     cannot read does not motivate anyone. No lead, phone number, note or
--     client detail is ever returned.
--   * Counted exactly like the Admin ranking: credit goes to the immutable
--     collector, a day is an Asia/Kolkata day, only ACTIVE leads inside the
--     exhibition's own dates count. The two screens can therefore never
--     disagree.
--   * The caller's own row carries is_me = true; user ids are not returned.
--   * Equal totals share a position (1, 2, 2, 4). A person with no leads has
--     no position (null) — an all-zero board has no leader, not an arbitrary one.
--
-- ROLLBACK
-- --------
-- drop function public.exhibition_lead_standings(uuid);

do $$
begin
  if to_regprocedure('public.exhibition_leads_actor()') is null
     or to_regprocedure('public.exhibition_leads_user_eligible(uuid)') is null
     or to_regclass('public.exhibitions') is null then
    raise exception 'DEPENDENCY MISSING: 20270305000000_exhibition_leads.sql must be applied first';
  end if;
end $$;

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
      where (u.role <> 'admin' and public.exhibition_leads_user_eligible(u.id))
         or u.id in (select collected_by from credit)
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

-- ═══ Executed self-check ════════════════════════════════════════════════════
do $$
begin
  if not has_function_privilege('authenticated', 'public.exhibition_lead_standings(uuid)'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public.exhibition_lead_standings(uuid)'::regprocedure, 'EXECUTE')
     or has_function_privilege('public', 'public.exhibition_lead_standings(uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'EXHIBITION_STANDINGS_ACL: wrong execute grants on exhibition_lead_standings(uuid)';
  end if;
end $$;
