-- EXHIBITION LEAD STANDINGS (20270307000000) — behavioural assertions
-- ===========================================================================
-- The leaderboard a salesperson sees on the Add Lead screen, through the real
-- door, as real roles, on a disposable database:
--
--   1. access        outsider and anon refused; any module user may read
--   2. the board     today / total / position, ties share a position, zero = null
--   3. the caller    is_me marks exactly the caller; no ids leave the function
--   4. one truth     totals equal the Admin ranking's, person by person
--   5. credit rules  archived and out-of-dates leads do not count; archiving
--                    moves the board; reassignment moves no credit
--   6. closing       a revoked user is refused; a past fair is final
--
-- ONE transaction ending in ROLLBACK. SELF-CONTAINED: its own people (57a0d…)
-- and its own exhibition dated around today, so "today" is real and the suite
-- does not depend on the date it is run. Needs the migration chain through
-- 20270307000000. On success prints NOTICE 'ALL STANDINGS ASSERTIONS PASSED'.

\set ON_ERROR_STOP on

begin;

create function public._t_assert(p_ok boolean, p_msg text) returns void
language plpgsql as $$
begin
  if p_ok is not true then raise exception 'ASSERTION FAILED: %', p_msg; end if;
end $$;

create function public._t_raises(p_sql text, p_expect text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_expect in sqlerrm) = 0 then
      raise exception 'ASSERTION FAILED: expected [%] but got [%] for: %', p_expect, sqlerrm, p_sql;
    end if;
    return;
  end;
  raise exception 'ASSERTION FAILED: no error (expected [%]) for: %', p_expect, p_sql;
end $$;

create function public._t_as(p_uid uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid::text, 'role', 'authenticated')::text, true);
end $$;

create function public._t_id(p_key text) returns uuid
language sql as $$ select current_setting('t.' || p_key)::uuid $$;

do $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  perform set_config('t.admin', '57a0d000-0000-4000-8000-000000000001', true);
  perform set_config('t.s1',    '57a0d000-0000-4000-8000-000000000002', true);
  perform set_config('t.s2',    '57a0d000-0000-4000-8000-000000000003', true);
  perform set_config('t.s3',    '57a0d000-0000-4000-8000-000000000004', true);
  perform set_config('t.s4',    '57a0d000-0000-4000-8000-000000000005', true);  -- sales, never collects
  perform set_config('t.x',     '57a0d000-0000-4000-8000-000000000006', true);  -- design: no access
  insert into public.users (id, full_name, email, role, team, is_active, employee_code) values
    ('57a0d000-0000-4000-8000-000000000001', 'STD Admin',    'std-admin@suite.test', 'admin',  'management', true, 'STD-ADM'),
    ('57a0d000-0000-4000-8000-000000000002', 'STD Sales 1',  'std-s1@suite.test',    'member', 'sales',      true, 'STD-S1'),
    ('57a0d000-0000-4000-8000-000000000003', 'STD Sales 2',  'std-s2@suite.test',    'member', 'sales',      true, 'STD-S2'),
    ('57a0d000-0000-4000-8000-000000000004', 'STD Sales 3',  'std-s3@suite.test',    'member', 'sales',      true, 'STD-S3'),
    ('57a0d000-0000-4000-8000-000000000005', 'STD Sales 4',  'std-s4@suite.test',    'member', 'sales',      true, 'STD-S4'),
    ('57a0d000-0000-4000-8000-000000000006', 'STD Outsider', 'std-x@suite.test',     'member', 'design',     true, 'STD-X');

  -- A fair that started yesterday and ends tomorrow (India dates), and one that is over.
  insert into public.exhibitions (id, slug, name, starts_on, ends_on) values
    ('57a0d000-0000-4000-8000-0000000000a1', 'standings-fair-live', 'Standings Fair Live', v_today - 1, v_today + 1),
    ('57a0d000-0000-4000-8000-0000000000a2', 'standings-fair-past', 'Standings Fair Past', v_today - 9, v_today - 7);
  perform set_config('t.exh',  '57a0d000-0000-4000-8000-0000000000a1', true);
  perform set_config('t.past', '57a0d000-0000-4000-8000-0000000000a2', true);
end $$;

create function public._t_create(p_sub uuid, p_name text, p_phone text) returns jsonb
language sql as $$
  select public.create_exhibition_lead(p_sub, public._t_id('exh'), p_name, p_phone, 'consultant', array['hotel'],
                                       null, null, null, 'warm', null, null)
$$;

-- One row of the board, by name.
create function public._t_row(p_name text) returns jsonb
language sql as $$
  select r from jsonb_array_elements(public.exhibition_lead_standings(public._t_id('exh'))->'rows') r
   where r->>'name' = p_name
$$;

-- ═══ 1. ACCESS ══════════════════════════════════════════════════════════════

set local role authenticated;
select public._t_as(public._t_id('x'));
select public._t_raises($q$ select public.exhibition_lead_standings(public._t_id('exh')) $q$, 'EXHIBITION_LEADS_FORBIDDEN');
reset role;
set local role anon;
select public._t_raises($q$ select public.exhibition_lead_standings('57a0d000-0000-4000-8000-0000000000a1') $q$, 'permission denied');
reset role;

-- ═══ 2. DATA: who collected what ════════════════════════════════════════════

set local role authenticated;
select public._t_as(public._t_id('s1'));
select public._t_create('57a0d000-0000-4000-9000-000000000001', 'S1 lead A', '9811100001');
select public._t_create('57a0d000-0000-4000-9000-000000000002', 'S1 lead B', '9811100002');
select public._t_create('57a0d000-0000-4000-9000-000000000003', 'S1 lead C', '9811100003');
select public._t_as(public._t_id('s3'));
select public._t_create('57a0d000-0000-4000-9000-000000000011', 'S3 lead A', '9811100011');
select public._t_create('57a0d000-0000-4000-9000-000000000012', 'S3 lead B', '9811100012');
select public._t_create('57a0d000-0000-4000-9000-000000000013', 'S3 lead C', '9811100013');
select public._t_as(public._t_id('s2'));
select public._t_create('57a0d000-0000-4000-9000-000000000021', 'S2 today',     '9811100021');
select public._t_create('57a0d000-0000-4000-9000-000000000022', 'S2 yesterday', '9811100022');
select public._t_create('57a0d000-0000-4000-9000-000000000023', 'S2 archived',  '9811100023');
select public._t_create('57a0d000-0000-4000-9000-000000000024', 'S2 too early', '9811100024');
reset role;

-- Move two entries to other days: yesterday (inside the fair) and before it (outside).
alter table public.exhibition_leads disable trigger exhibition_leads_guard_immutable;
update public.exhibition_leads set created_at = now() - interval '1 day' where contact_name = 'S2 yesterday';
update public.exhibition_leads set created_at = now() - interval '4 days' where contact_name = 'S2 too early';
alter table public.exhibition_leads enable trigger exhibition_leads_guard_immutable;

set local role authenticated;
select public._t_as(public._t_id('admin'));
select public.archive_exhibition_lead((select id from public.exhibition_leads where contact_name = 'S2 archived'), 'Test');

-- ═══ 3. THE BOARD, AS S1 ════════════════════════════════════════════════════

select public._t_as(public._t_id('s1'));

-- (Other eligible salespeople may exist on the database: they appear with zero. Only this suite's people are counted.)
select public._t_assert((public.exhibition_lead_standings(public._t_id('exh'))->>'participants')::int
    = (select count(*) from jsonb_array_elements(public.exhibition_lead_standings(public._t_id('exh'))->'rows')),
  'participants is the number of rows');
select public._t_assert((select count(*) = 4 from jsonb_array_elements(public.exhibition_lead_standings(public._t_id('exh'))->'rows') r
    where r->>'name' like 'STD%'),
  'this suite''s four salespeople are on the board; the admin without leads and the outsider are not');
select public._t_assert((public._t_row('STD Sales 1')->>'total')::int = 3 and (public._t_row('STD Sales 1')->>'today')::int = 3,
  'S1: 3 in total, 3 today');
select public._t_assert((public._t_row('STD Sales 2')->>'total')::int = 2 and (public._t_row('STD Sales 2')->>'today')::int = 1,
  'S2: yesterday counts in the total only; the archived and the too-early lead count nowhere');
select public._t_assert((public._t_row('STD Sales 4')->>'total')::int = 0 and public._t_row('STD Sales 4')->'rank' = 'null'::jsonb,
  'S4: no leads, no position');
select public._t_assert((public._t_row('STD Sales 1')->>'rank')::int = 1 and (public._t_row('STD Sales 3')->>'rank')::int = 1,
  'a tie on the top total shares position 1');
select public._t_assert((public._t_row('STD Sales 2')->>'rank')::int = 3,
  'the next position skips the tie (1, 1, 3)');
select public._t_assert(
  (select array_agg(r->>'name' order by ord) = array['STD Sales 1', 'STD Sales 3', 'STD Sales 2', 'STD Sales 4']
     from jsonb_array_elements(public.exhibition_lead_standings(public._t_id('exh'))->'rows') with ordinality t(r, ord)
    where r->>'name' like 'STD%'),
  'highest total first, then name');

-- ═══ 4. THE CALLER, AND WHAT NEVER LEAVES ═══════════════════════════════════

select public._t_assert((select count(*) filter (where (r->>'is_me')::boolean) = 1
    from jsonb_array_elements(public.exhibition_lead_standings(public._t_id('exh'))->'rows') r)
  and (public._t_row('STD Sales 1')->>'is_me')::boolean, 'is_me marks exactly the caller');
select public._t_assert((select bool_and((select array_agg(k order by k) from jsonb_object_keys(r) k) = array['is_me', 'name', 'rank', 'today', 'total'])
    from jsonb_array_elements(public.exhibition_lead_standings(public._t_id('exh'))->'rows') r),
  'a row carries a name, counts, a position and is_me — no id, phone or client detail');
select public._t_assert(public.exhibition_lead_standings(public._t_id('exh'))::text !~* '9811100|57a0d000-0000-4000-8000-00000000000[1-6]',
  'no phone number and no user id appears anywhere in the answer');

select public._t_as(public._t_id('s2'));
select public._t_assert((public._t_row('STD Sales 2')->>'is_me')::boolean and not (public._t_row('STD Sales 1')->>'is_me')::boolean,
  'the same board seen by S2 marks S2');

select public._t_as(public._t_id('admin'));
select public._t_assert((select count(*) filter (where (r->>'is_me')::boolean) = 0
    from jsonb_array_elements(public.exhibition_lead_standings(public._t_id('exh'))->'rows') r),
  'an Admin with no leads can read the board and is not on it');

-- ═══ 5. ONE TRUTH WITH THE ADMIN RANKING ════════════════════════════════════

select public._t_assert(
  (select bool_and((s->>'total')::int = (r->>'total')::int)
     from jsonb_array_elements(public.exhibition_lead_standings(public._t_id('exh'))->'rows') s
     join jsonb_array_elements(public.exhibition_lead_ranking(public._t_id('exh'))->'rows') r on r->>'name' = s->>'name'),
  'every total equals the Admin ranking''s total for the same person');
select public._t_assert(
  (select count(*) from jsonb_array_elements(public.exhibition_lead_standings(public._t_id('exh'))->'rows'))
  = (select count(*) from jsonb_array_elements(public.exhibition_lead_ranking(public._t_id('exh'))->'rows')),
  'the same people are on both');

-- An Admin who collects a lead is listed, like in the ranking.
select public._t_create('57a0d000-0000-4000-9000-000000000031', 'Admin lead', '9811100031');
select public._t_assert((public._t_row('STD Admin')->>'total')::int = 1 and (public._t_row('STD Admin')->>'is_me')::boolean,
  'an Admin who collected a lead is on the board');

-- Archiving moves the board; restoring moves it back; reassigning moves no credit.
select public.archive_exhibition_lead((select id from public.exhibition_leads where contact_name = 'S3 lead C'), 'Test');
select public._t_assert((public._t_row('STD Sales 3')->>'total')::int = 2 and (public._t_row('STD Sales 3')->>'rank')::int = 2
  and (public._t_row('STD Sales 2')->>'rank')::int = 2 and (public._t_row('STD Sales 1')->>'rank')::int = 1,
  'after an archive: 1, 2, 2 — a new tie, and the credit is gone');
select public.restore_exhibition_lead((select id from public.exhibition_leads where contact_name = 'S3 lead C'));
select public._t_assert((public._t_row('STD Sales 3')->>'total')::int = 3, 'restoring returns the credit');
select public.reassign_exhibition_lead((select id from public.exhibition_leads where contact_name = 'S1 lead A'), public._t_id('s4'));
select public._t_assert((public._t_row('STD Sales 1')->>'total')::int = 3 and (public._t_row('STD Sales 4')->>'total')::int = 0,
  'reassigning a lead moves no credit: the collector keeps it');

-- ═══ 6. CLOSING THE DOOR, AND A FINISHED FAIR ═══════════════════════════════

select public._t_assert((public.exhibition_lead_standings(public._t_id('exh'))->>'is_final')::boolean = false, 'a running fair is not final');
select public._t_assert((public.exhibition_lead_standings(public._t_id('past'))->>'is_final')::boolean, 'a finished fair is final');
select public._t_assert((select bool_and((r->>'total')::int = 0) from jsonb_array_elements(public.exhibition_lead_standings(public._t_id('past'))->'rows') r),
  'a fair with no leads has an all-zero board with no leader');
select public._t_assert((select bool_and(r->'rank' = 'null'::jsonb) from jsonb_array_elements(public.exhibition_lead_standings(public._t_id('past'))->'rows') r),
  '…and no position for anybody');
select public._t_raises($q$ select public.exhibition_lead_standings('57a0d000-0000-4000-8000-0000000000ff') $q$, 'EXHIBITION_LEADS_NOT_FOUND');

reset role;
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select public._t_id('s4'), mpa.module_id, mpa.action_id, false, public._t_id('admin')
  from public.module_permission_actions mpa
  join public.permission_modules pm on pm.id = mpa.module_id and pm.module_key = 'exhibition_leads'
  join public.permission_actions pa on pa.id = mpa.action_id and pa.action_key = 'view';
set local role authenticated;
select public._t_as(public._t_id('s4'));
select public._t_raises($q$ select public.exhibition_lead_standings(public._t_id('exh')) $q$, 'EXHIBITION_LEADS_FORBIDDEN');

reset role;
do $$ begin raise notice 'ALL STANDINGS ASSERTIONS PASSED'; end $$;
rollback;
