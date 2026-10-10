-- EXHIBITION LEADS "VIEW ALL LEADS" (20270309000000) — behavioural assertions
-- ===========================================================================
-- Through the real door, as real roles, on a disposable database:
--
--   1. before the grant   a module user sees only their own leads; no people list
--   2. after the grant    the whole list, any lead, the people list, the card photograph — READ ONLY
--   3. every write        still refused (edit, note, contact, reassign, archive); export / ranking stay Admin
--   4. the ranking        a holder is out of the leaderboard and the ranking, even with leads collected
--   5. Admin              unchanged: sees everything, stays on the board when they collected
--   6. my_access          each caller's own answer; the helper is not callable by clients
--   7. revoking           takes it away again
--
-- ONE transaction ending in ROLLBACK. SELF-CONTAINED (its own people 57d0d…, own exhibition).
-- Needs the migration chain through 20270309000000.
-- On success prints NOTICE 'ALL VIEW-ALL ASSERTIONS PASSED'.

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
  perform set_config('t.admin', '57d0d000-0000-4000-8000-000000000001', true);
  perform set_config('t.s1',    '57d0d000-0000-4000-8000-000000000002', true);
  perform set_config('t.s2',    '57d0d000-0000-4000-8000-000000000003', true);
  perform set_config('t.v',     '57d0d000-0000-4000-8000-000000000004', true);  -- manager outside Sales, will hold view_all
  perform set_config('t.x',     '57d0d000-0000-4000-8000-000000000005', true);  -- no access
  perform set_config('t.exh',   '57d0d000-0000-4000-8000-0000000000a1', true);
  insert into public.users (id, full_name, email, role, team, is_active, employee_code) values
    ('57d0d000-0000-4000-8000-000000000001', 'CVA Admin',   'cva-admin@suite.test', 'admin',   'management', true, 'CVA-ADM'),
    ('57d0d000-0000-4000-8000-000000000002', 'CVA Sales 1', 'cva-s1@suite.test',    'member',  'sales',      true, 'CVA-S1'),
    ('57d0d000-0000-4000-8000-000000000003', 'CVA Sales 2', 'cva-s2@suite.test',    'member',  'sales',      true, 'CVA-S2'),
    ('57d0d000-0000-4000-8000-000000000004', 'CVA Viewer',  'cva-v@suite.test',     'manager', 'sales',      true, 'CVA-V'),
    ('57d0d000-0000-4000-8000-000000000005', 'CVA Outsider','cva-x@suite.test',     'member',  'design',     true, 'CVA-X');
  insert into public.exhibitions (id, slug, name, starts_on, ends_on)
  values ('57d0d000-0000-4000-8000-0000000000a1', 'view-all-fair', 'View All Fair', v_today - 1, v_today + 1);
  insert into storage.objects (bucket_id, name, owner_id) values
    ('exhibition-lead-cards', '57d0d000-0000-4000-8000-000000000002/57d0d000-0000-4000-9000-0000000000f1.jpg', '57d0d000-0000-4000-8000-000000000002');
end $$;

create function public._t_create(p_sub uuid, p_name text, p_phone text) returns jsonb
language sql as $$
  select public.create_exhibition_lead(p_sub, public._t_id('exh'), p_name, p_phone, 'consultant', array['hotel'],
                                       null, null, null, 'warm', null, null)
$$;
create function public._t_lead(p_name text) returns uuid
language sql security definer set search_path = public as $$ select id from public.exhibition_leads where contact_name = p_name $$;
create function public._t_page_names(p_scope text) returns text[]
language sql as $$
  select coalesce(array_agg(r->>'contact_name' order by r->>'contact_name'), '{}')
    from jsonb_array_elements(public.exhibition_leads_page(
      jsonb_build_object('exhibition_id', public._t_id('exh'), 'scope', p_scope), 100, 0)->'rows') r
$$;
create function public._t_board(p_name text) returns jsonb
language sql as $$
  select r from jsonb_array_elements(public.exhibition_lead_standings(public._t_id('exh'))->'rows') r where r->>'name' = p_name
$$;

-- Data: the viewer has collected one lead of their own; s1 and s2 have collected theirs; Admin one too.
set local role authenticated;
select public._t_as(public._t_id('s1'));
select public._t_create('57d0d000-0000-4000-9000-000000000001', 'VA lead of s1', '9833300001');
select public._t_as(public._t_id('s2'));
select public._t_create('57d0d000-0000-4000-9000-000000000002', 'VA lead of s2', '9833300002');
select public._t_as(public._t_id('v'));
select public._t_create('57d0d000-0000-4000-9000-000000000003', 'VA lead of viewer', '9833300003');
select public._t_as(public._t_id('admin'));
select public._t_create('57d0d000-0000-4000-9000-000000000004', 'VA lead of admin', '9833300004');
reset role;

-- The viewer's photograph target: attach one to s1's lead (as s1).
set local role authenticated;
select public._t_as(public._t_id('s1'));
select public.set_exhibition_lead_contact(public._t_lead('VA lead of s1'), jsonb_build_object(
  'card_photo_path', '57d0d000-0000-4000-8000-000000000002/57d0d000-0000-4000-9000-0000000000f1.jpg'));
reset role;

-- ═══ 1. BEFORE THE GRANT ══════════════════════════════════════════════════
set local role authenticated;
select public._t_as(public._t_id('v'));
select public._t_assert(public._t_page_names('all') = array['VA lead of viewer'], 'without view_all a module user sees only their own leads, even asking for all');
select public._t_raises($q$ select public.get_exhibition_lead(public._t_lead('VA lead of s1')) $q$, 'EXHIBITION_LEADS_NOT_FOUND');
select public._t_raises($q$ select public.exhibition_lead_people(public._t_id('exh')) $q$, 'Admin only');
select public._t_assert((public.exhibition_leads_my_access()->>'view_all')::boolean = false, 'my_access: not a holder yet');
select public._t_assert(public._t_board('CVA Viewer') is not null, 'before the grant the viewer is on the leaderboard like any salesperson');
reset role;

-- ═══ 2. GRANT (as Control Center would: an employee override) ═════════════
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select public._t_id('v'), pm.id, pa.id, true, public._t_id('admin')
from public.permission_modules pm, public.permission_actions pa
where pm.module_key = 'exhibition_leads' and pa.action_key = 'view_all';

set local role authenticated;
select public._t_as(public._t_id('v'));
select public._t_assert(public._t_page_names('all') = array['VA lead of admin', 'VA lead of s1', 'VA lead of s2', 'VA lead of viewer'],
  'a holder sees every lead of the exhibition');
select public._t_assert((public.get_exhibition_lead(public._t_lead('VA lead of s1'))->'lead'->>'contact_name') = 'VA lead of s1',
  'a holder opens any lead');
select public._t_assert((public.get_exhibition_lead(public._t_lead('VA lead of s1'))->'lead'->>'card_photo_path') like '%f1.jpg',
  'and sees its card photograph path');
select public._t_assert(jsonb_array_length(public.exhibition_lead_people(public._t_id('exh'))) >= 4, 'a holder gets the people list the filters need');
select public._t_assert(public.exhibition_lead_card_readable(
    '57d0d000-0000-4000-8000-000000000002/57d0d000-0000-4000-9000-0000000000f1.jpg', '57d0d000-0000-4000-8000-000000000002'),
  'a holder can read the card photograph');
select public._t_assert((public.exhibition_leads_my_access()->>'view_all')::boolean and not (public.exhibition_leads_my_access()->>'is_admin')::boolean,
  'my_access: holder, not Admin');

-- ═══ 3. READ ONLY ═════════════════════════════════════════════════════════
select public._t_raises($q$ select public.update_exhibition_lead(public._t_lead('VA lead of s1'), '{"company_name":"Hijacked"}', null) $q$, 'EXHIBITION_LEADS_NOT_FOUND');
select public._t_raises($q$ select public.update_exhibition_lead(public._t_lead('VA lead of s1'), '{}', 'a note') $q$, 'EXHIBITION_LEADS_NOT_FOUND');
select public._t_raises($q$ select public.set_exhibition_lead_contact(public._t_lead('VA lead of s1'), '{"email":"v@steal.in"}') $q$, 'EXHIBITION_LEADS_NOT_FOUND');
select public._t_raises($q$ select public.reassign_exhibition_lead(public._t_lead('VA lead of s1'), public._t_id('v'), null) $q$, 'EXHIBITION_LEADS_FORBIDDEN');
select public._t_raises($q$ select public.archive_exhibition_lead(public._t_lead('VA lead of s1'), 'no reason really') $q$, 'EXHIBITION_LEADS_FORBIDDEN');
select public._t_raises($q$ select public.export_exhibition_leads('{}', 10, 0) $q$, 'Admin only');
select public._t_raises($q$ select public.exhibition_lead_ranking(public._t_id('exh')) $q$, 'Admin only');
-- Their own lead is still theirs to edit.
select public._t_assert(public.update_exhibition_lead(public._t_lead('VA lead of viewer'), '{"company_name":"Mine"}', null)->>'outcome' = 'updated',
  'a holder still edits the leads they own');

-- ═══ 4. OUT OF THE RANKING ════════════════════════════════════════════════
select public._t_assert(public._t_board('CVA Viewer') is null, 'a holder is not on the leaderboard');
select public._t_assert(public._t_board('CVA Sales 1') is not null and public._t_board('CVA Sales 2') is not null, 'the salespeople are');
select public._t_assert(public._t_board('CVA Sales 1')->>'rank' is not null, 'and keep their positions');
select public._t_as(public._t_id('admin'));
select public._t_assert(not exists (select 1 from jsonb_array_elements(public.exhibition_lead_ranking(public._t_id('exh'))->'rows') r where r->>'name' = 'CVA Viewer'),
  'a holder is not in the Admin ranking, though they collected a lead');
select public._t_assert(exists (select 1 from jsonb_array_elements(public.exhibition_lead_ranking(public._t_id('exh'))->'rows') r where r->>'name' = 'CVA Sales 1'),
  'the salespeople are');

-- ═══ 5. ADMIN UNCHANGED ═══════════════════════════════════════════════════
select public._t_assert(public._t_page_names('all') = array['VA lead of admin', 'VA lead of s1', 'VA lead of s2', 'VA lead of viewer'], 'Admin sees all');
select public._t_assert((public.exhibition_leads_my_access()->>'is_admin')::boolean and (public.exhibition_leads_my_access()->>'view_all')::boolean, 'my_access: Admin');
select public._t_assert(public._t_board('CVA Admin') is not null, 'Admin who collected a lead is still on the board (Admin is never "a holder")');
select public.export_exhibition_leads('{}', 10, 0);

-- ═══ 6. THE OTHERS ═════════════════════════════════════════════════════════
select public._t_as(public._t_id('s2'));
select public._t_assert(public._t_page_names('all') = array['VA lead of s2'], 'an ordinary salesperson still sees only their own');
select public._t_assert((public.exhibition_leads_my_access()->>'view_all')::boolean = false, 'and is not a holder');
select public._t_as(public._t_id('x'));
select public._t_raises($q$ select public.exhibition_leads_my_access() $q$, 'EXHIBITION_LEADS_FORBIDDEN');
select public._t_raises($q$ select public.exhibition_leads_page('{}', 10, 0) $q$, 'EXHIBITION_LEADS_FORBIDDEN');
reset role;
set local role authenticated;
select public._t_raises($q$ select public.exhibition_leads_viewer('57d0d000-0000-4000-8000-000000000004') $q$, 'permission denied');
reset role;
set local role anon;
select public._t_raises($q$ select public.exhibition_leads_my_access() $q$, 'permission denied');
reset role;

-- ═══ 7. REVOKING ═════════════════════════════════════════════════════════
update public.employee_permission_overrides set revoked_by = public._t_id('admin'), revoked_at = now()
 where user_id = public._t_id('v');
set local role authenticated;
select public._t_as(public._t_id('v'));
select public._t_assert(public._t_page_names('all') = array['VA lead of viewer'], 'revoked: back to their own leads');
select public._t_assert(public._t_board('CVA Viewer') is not null, 'revoked: back on the leaderboard');
reset role;

do $$ begin raise notice 'ALL VIEW-ALL ASSERTIONS PASSED'; end $$;
rollback;
