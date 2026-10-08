-- EXHIBITION LEADS (20270305000000) — behavioural assertions
-- ===========================================================================
-- Through the real doors, as real roles, on a disposable database:
--
--   1. access          module gate; direct DML refused; owner-only reads
--   2. create          collector/owner from auth.uid(); idempotent replay
--   3. duplicates      number-format variants; private for another owner's lead
--   4. follow-up       date rules, terminal clears the schedule, notes append
--   5. reassign        owner moves, collector credit does not; guards
--   6. archive/restore reason required, replacement lead, restore conflict
--   7. list            AND/OR filters, search, IST day edges, paging totals
--   8. ranking         full data, IST days, zero rows, archives, out-of-event
--   9. export          admin only, same set as the list
--  10. audit           append-only; visible only with the lead
--
-- Runs inside ONE transaction that ends in ROLLBACK. now() is shared inside a
-- transaction, so rows that need other times get them from a trigger-bypassed
-- UPDATE of created_at (the immutability trigger is disabled for that, here
-- only). SELF-CONTAINED: creates its own people (e1ead…), depends on no seed
-- beyond the migration chain through 20270305000000.
-- On success prints NOTICE 'ALL EXHIBITION LEADS ASSERTIONS PASSED'.

\set ON_ERROR_STOP on

begin;

-- ═══ 0. HELPERS AND PEOPLE ══════════════════════════════════════════════════

create function public._t_assert(p_ok boolean, p_msg text) returns void
language plpgsql as $$
begin
  if p_ok is not true then raise exception 'ASSERTION FAILED: %', p_msg; end if;
end $$;

-- Runs p_sql and demands it raise a message containing p_expect.
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
begin
  perform set_config('t.admin', 'e1ead000-0000-4000-8000-000000000001', true);
  perform set_config('t.s1',    'e1ead000-0000-4000-8000-000000000002', true);
  perform set_config('t.s2',    'e1ead000-0000-4000-8000-000000000003', true);
  perform set_config('t.s3',    'e1ead000-0000-4000-8000-000000000004', true);  -- sales, never collects
  perform set_config('t.x',     'e1ead000-0000-4000-8000-000000000005', true);  -- design: no access
  insert into public.users (id, full_name, email, role, team, is_active, employee_code) values
    ('e1ead000-0000-4000-8000-000000000001', 'EXL Admin',   'exl-admin@suite.test', 'admin',  'management', true, 'EXL-ADM'),
    ('e1ead000-0000-4000-8000-000000000002', 'EXL Sales 1', 'exl-s1@suite.test',    'member', 'sales',      true, 'EXL-S1'),
    ('e1ead000-0000-4000-8000-000000000003', 'EXL Sales 2', 'exl-s2@suite.test',    'member', 'sales',      true, 'EXL-S2'),
    ('e1ead000-0000-4000-8000-000000000004', 'EXL Sales 3', 'exl-s3@suite.test',    'member', 'sales',      true, 'EXL-S3'),
    ('e1ead000-0000-4000-8000-000000000005', 'EXL Outsider','exl-x@suite.test',     'member', 'design',     true, 'EXL-X');
  perform set_config('t.exh', (select id::text from public.exhibitions where slug = 'acetech-bangalore-2026'), true);
end $$;

select public._t_assert(
  (select starts_on = date '2026-10-09' and ends_on = date '2026-10-11' and name = 'Acetech Bangalore 2026'
     from public.exhibitions where slug = 'acetech-bangalore-2026'),
  'the Acetech Bangalore 2026 exhibition is seeded with its dates');

select public._t_assert(
  exists (select 1 from public.department_permissions dp
            join public.departments d on d.id = dp.department_id and d.department_key = 'sales'
            join public.permission_modules pm on pm.id = dp.module_id and pm.module_key = 'exhibition_leads'
           where dp.allowed),
  'the Sales department holds exhibition_leads:view');

create function public._t_total(p_filter text) returns int language sql as $$
  select (public.exhibition_leads_page(p_filter::jsonb)->>'total')::int $$;

create function public._t_rank(p_name text, p_day text default null) returns int language sql as $$
  select coalesce((select case when p_day is null then (r->>'total')::int else coalesce((r->'per_day'->>p_day)::int, 0) end
    from jsonb_array_elements(public.exhibition_lead_ranking(public._t_id('exh'))->'rows') r where r->>'name' = p_name), -1) $$;

-- Handy create call, run as the current JWT user.
create function public._t_create(p_sub uuid, p_name text, p_phone text,
  p_type text default 'consultant', p_reqs text[] default array['hotel'],
  p_company text default null, p_city text default null, p_timeline text default null,
  p_lead_type text default 'warm', p_note text default null, p_other text default null) returns jsonb
language sql as $$
  select public.create_exhibition_lead(p_sub, public._t_id('exh'), p_name, p_phone, p_type, p_reqs,
                                       p_company, p_city, p_timeline, p_lead_type, p_note, p_other)
$$;

-- ═══ 1. ACCESS ══════════════════════════════════════════════════════════════

set local role authenticated;

select public._t_as(public._t_id('x'));
select public._t_raises($q$ select public.exhibition_leads_page('{}'::jsonb) $q$, 'EXHIBITION_LEADS_FORBIDDEN');
select public._t_raises(
  $q$ select public._t_create('e1ead000-0000-4000-9000-000000000001', 'No Access', '9876500001') $q$,
  'EXHIBITION_LEADS_FORBIDDEN');
select public._t_assert((select count(*) = 0 from public.exhibitions), 'an outsider sees no exhibition row');

-- Anonymous callers cannot execute anything.
reset role;
set local role anon;
select public._t_raises($q$ select public.exhibition_leads_page('{}'::jsonb) $q$, 'permission denied');
select public._t_raises($q$ select * from public.exhibition_leads $q$, 'permission denied');
reset role;

-- ═══ 2. CREATE — identity, defaults, idempotency ════════════════════════════

set local role authenticated;
select public._t_as(public._t_id('s1'));

do $$
declare r jsonb; l public.exhibition_leads;
begin
  r := public._t_create('f0000000-0000-4000-8000-000000000001', '  Asha Rao ', '98765 43210',
        'architect_designer', array['restaurant_cafe','hotel'], 'Rao Studio', 'Bengaluru', 'within_1_month', 'warm',
        'Needs 40 cafe chairs; send catalogue.');
  perform public._t_assert(r->>'outcome' = 'created', 'first save is created');
  perform set_config('t.l1', r->>'lead_id', true);
end $$;

reset role;
do $$
declare l public.exhibition_leads;
begin
  select * into l from public.exhibition_leads where id = public._t_id('l1');
  perform public._t_assert(l.collected_by = public._t_id('s1') and l.owner_id = public._t_id('s1'),
    'collector and owner come from the signed-in user');
  perform public._t_assert(l.status = 'new' and l.lead_type = 'warm', 'initial status New, with the lead type that was chosen');
  perform public._t_assert(l.contact_name = 'Asha Rao', 'name is trimmed');
  perform public._t_assert(l.phone_e164 = '+919876543210', 'phone is stored canonical');
  perform public._t_assert(l.exhibition_id = public._t_id('exh'), 'the exhibition is stored on the lead');
  perform public._t_assert(l.created_at = now(), 'created_at is server time');
  perform public._t_assert((select count(*) from public.exhibition_lead_events where lead_id = l.id and event_type = 'created' and actor_id = l.collected_by) = 1,
    'a created event is written for the collector');
end $$;

set local role authenticated;
select public._t_as(public._t_id('s1'));

-- Retry of the SAME submission: same row, nothing new.
do $$
declare r jsonb;
begin
  -- Same submission, same details (requirements in another order, number in
  -- another format): the original result comes back.
  r := public._t_create('f0000000-0000-4000-8000-000000000001', '  Asha Rao ', '+91 98765-43210',
        'architect_designer', array['hotel','restaurant_cafe'], 'Rao Studio', 'Bengaluru', 'within_1_month', 'warm',
        'Needs 40 cafe chairs; send catalogue.');
  perform public._t_assert(r->>'outcome' = 'replayed' and (r->>'lead_id')::uuid = public._t_id('l1'),
    'a retry of the same submission returns the original result');
end $$;
select public._t_assert((select count(*) = 1 from public.exhibition_leads), 'still one lead after the retry');

-- Same submission id, DIFFERENT details: refused, and nothing is overwritten.
select public._t_raises($q$ select public._t_create('f0000000-0000-4000-8000-000000000001', 'Someone Else', '98765 43210', 'architect_designer', array['restaurant_cafe','hotel'], 'Rao Studio', 'Bengaluru', 'within_1_month', 'warm', 'Needs 40 cafe chairs; send catalogue.') $q$, 'SUBMISSION_CONFLICT');
select public._t_raises($q$ select public._t_create('f0000000-0000-4000-8000-000000000001', 'Asha Rao', '98765 43210', 'architect_designer', array['restaurant_cafe','hotel'], 'Rao Studio', 'Bengaluru', 'within_1_month', 'warm', 'A different note') $q$, 'SUBMISSION_CONFLICT');
select public._t_raises($q$ select public._t_create('f0000000-0000-4000-8000-000000000001', 'Asha Rao', '98765 99999', 'architect_designer', array['restaurant_cafe','hotel'], 'Rao Studio', 'Bengaluru', 'within_1_month', 'warm', 'Needs 40 cafe chairs; send catalogue.') $q$, 'SUBMISSION_CONFLICT');
select public._t_assert((select contact_name = 'Asha Rao' and initial_note = 'Needs 40 cafe chairs; send catalogue.' and phone_e164 = '+919876543210' from public.exhibition_leads where id = public._t_id('l1')),
  'a conflicting retry overwrote nothing');
-- Another person cannot ride on this submission id either.

-- Validation, one rule at a time.
select public._t_raises($q$ select public._t_create('f0000000-0000-4000-8000-000000000002', '   ', '9876500002') $q$, 'contact name');
select public._t_raises($q$ select public._t_create('f0000000-0000-4000-8000-000000000002', 'A', '12345') $q$, 'valid mobile');
select public._t_raises($q$ select public._t_create('f0000000-0000-4000-8000-000000000002', 'A', '5876500002') $q$, 'valid mobile');
select public._t_raises($q$ select public._t_create('f0000000-0000-4000-8000-000000000002', 'A', '9876500002', 'wizard') $q$, 'client type');
select public._t_raises($q$ select public._t_create('f0000000-0000-4000-8000-000000000002', 'A', '9876500002', 'consultant', '{}') $q$, 'requirement');
select public._t_raises($q$ select public._t_create('f0000000-0000-4000-8000-000000000002', 'A', '9876500002', 'consultant', array['sofa']) $q$, 'requirement');
select public._t_raises($q$ select public._t_create('f0000000-0000-4000-8000-000000000002', 'A', '9876500002', 'consultant', array['hotel'], null, null, 'soon') $q$, 'timeline');
select public._t_raises($q$ select public._t_create('f0000000-0000-4000-8000-000000000002', 'A', '9876500002', 'consultant', array['hotel'], null, null, null, 'urgent') $q$, 'lead type');
select public._t_assert((select count(*) = 1 from public.exhibition_leads), 'invalid entries stored nothing');

-- A client cannot write the tables directly, nor impersonate another collector.
select public._t_raises($q$ insert into public.exhibition_leads (exhibition_id, submission_id, contact_name, phone_e164, client_type, requirements, collected_by, owner_id)
  values (public._t_id('exh'), gen_random_uuid(), 'Direct', '+919876500009', 'consultant', array['hotel'], public._t_id('s1'), public._t_id('s1')) $q$, 'permission denied');
select public._t_raises($q$ update public.exhibition_leads set owner_id = public._t_id('s2') $q$, 'permission denied');
select public._t_raises($q$ delete from public.exhibition_leads $q$, 'permission denied');
select public._t_raises($q$ insert into public.exhibition_lead_events (lead_id, event_type, actor_id) values (public._t_id('l1'), 'note', public._t_id('s1')) $q$, 'permission denied');
select public._t_raises($q$ insert into public.exhibitions (slug, name, starts_on, ends_on) values ('rogue-fair', 'Rogue', date '2026-01-01', date '2026-01-02') $q$, 'permission denied');
select public._t_raises($q$ update public.exhibitions set name = 'Renamed' $q$, 'permission denied');
select public._t_raises($q$ update public.exhibition_leads set collected_by = public._t_id('s2') $q$, 'permission denied');
select public._t_raises($q$ update public.exhibition_leads set created_at = now() $q$, 'permission denied');
select public._t_raises($q$ update public.exhibition_leads set exhibition_id = gen_random_uuid() $q$, 'permission denied');

-- ═══ 3. DUPLICATES ══════════════════════════════════════════════════════════

do $$
declare v text; r jsonb; n int := 10;
begin
  foreach v in array array['09876543210', '+91 98765-43210', '919876543210', '0091 98765 43210', '(+91) 98765 43210', '+91 0 98765 43210'] loop
    n := n + 1;
    r := public._t_create(('f0000000-0000-4000-8000-0000000000' || n)::uuid, 'Dup', v);
    perform public._t_assert(r->>'outcome' = 'duplicate' and (r->>'mine')::boolean and (r->>'lead_id')::uuid = public._t_id('l1'),
      'variant [' || v || '] is the same number — got ' || r::text);
  end loop;
end $$;
select public._t_assert((select count(*) = 1 from public.exhibition_leads), 'format variants never made a second lead');

-- S2: a different salesperson hits S1's number — told only that it exists.
select public._t_as(public._t_id('s2'));
do $$
declare r jsonb;
begin
  r := public._t_create('f0000000-0000-4000-8000-000000000030', 'Someone Else', '+91 98765 43210');
  perform public._t_assert(r->>'outcome' = 'duplicate' and (r->>'mine')::boolean = false and not (r ? 'lead_id'),
    'another owner learns the fact only — no id: ' || r::text);
end $$;
select public._t_assert((select count(*) = 0 from public.exhibition_leads), 'S2 still sees nothing of S1''s lead');

-- International numbers: any valid length, +44 and +1 included.
do $$
declare r jsonb;
begin
  r := public._t_create('f0000000-0000-4000-8000-000000000031', 'London Co', '+44 20 7946 0958', 'property_owner', array['hotel']);
  perform public._t_assert(r->>'outcome' = 'created', 'a +44 number is accepted');
  perform set_config('t.l2', r->>'lead_id', true);
  r := public._t_create('f0000000-0000-4000-8000-000000000032', 'US Dealer', '+1 202 555 0143', 'consultant', array['restaurant_cafe']);
  perform public._t_assert(r->>'outcome' = 'created', 'a +1 number is accepted');
  perform set_config('t.l3', r->>'lead_id', true);
end $$;

-- Admin sees the matching record behind a duplicate.
select public._t_as(public._t_id('admin'));
do $$
declare r jsonb;
begin
  r := public._t_create('f0000000-0000-4000-8000-000000000033', 'Admin Try', '9876543210');
  perform public._t_assert(r->>'outcome' = 'duplicate' and (r->>'lead_id')::uuid = public._t_id('l1'),
    'admin gets the matching lead id on a duplicate');
end $$;

-- ═══ 4. OWNER-ONLY ACCESS AND FOLLOW-UP RULES ═══════════════════════════════

select public._t_as(public._t_id('s1'));
select public._t_assert((select count(*) = 1 from public.exhibition_leads), 'S1 reads only the lead S1 owns');
select public._t_assert((select count(*) = 1 from public.exhibition_lead_events), 'S1 reads only events of own leads');
select public._t_raises($q$ select public.get_exhibition_lead(public._t_id('l2')) $q$, 'EXHIBITION_LEADS_NOT_FOUND');
select public._t_raises($q$ select public.update_exhibition_lead(public._t_id('l2'), '{"lead_type":"hot"}') $q$, 'EXHIBITION_LEADS_NOT_FOUND');
select public._t_assert((public.exhibition_leads_page('{"scope":"all"}'::jsonb)->>'total')::int = 1,
  'scope=all cannot widen a salesperson');
select public._t_assert((public.exhibition_leads_page('{"collector_ids":["e1ead000-0000-4000-8000-000000000003"]}'::jsonb)->>'total')::int = 1,
  'admin-only filters are ignored for a salesperson');
select public._t_assert((public.exhibition_leads_page('{"archived":"all"}'::jsonb)->>'total')::int = 1, 'archive filter ignored for a salesperson');

-- Follow-up rules.
select public._t_raises($q$ select public.update_exhibition_lead(public._t_id('l1'), '{"status":"follow_up"}') $q$, 'FOLLOW_UP_DATE_REQUIRED');
select public._t_raises($q$ select public.update_exhibition_lead(public._t_id('l1'), json_build_object('status','follow_up','next_follow_up_on', current_date - 3)::jsonb) $q$, 'cannot be in the past');
select public._t_raises($q$ select public.update_exhibition_lead(public._t_id('l1'), '{"next_follow_up_on":"not-a-date"}') $q$, 'valid follow-up date');
select public._t_raises($q$ select public.update_exhibition_lead(public._t_id('l1'), '{"status":"bogus"}') $q$, 'Unknown status');
select public._t_raises($q$ select public.update_exhibition_lead(public._t_id('l1'), '{"collected_by":"e1ead000-0000-4000-8000-000000000003"}') $q$, 'Unknown field');
select public._t_raises($q$ select public.update_exhibition_lead(public._t_id('l1'), '{"owner_id":"e1ead000-0000-4000-8000-000000000003"}') $q$, 'Unknown field');

do $$
declare r jsonb; fu date := (now() at time zone 'Asia/Kolkata')::date + 2;
begin
  r := public.update_exhibition_lead(public._t_id('l1'),
        json_build_object('status', 'follow_up', 'next_follow_up_on', fu)::jsonb, 'Called, wants samples');
  perform public._t_assert(r->>'outcome' = 'updated', 'status + date + note saved together');
  r := public.update_exhibition_lead(public._t_id('l1'), '{}', 'Sent catalogue on WhatsApp');
  perform public._t_assert(r->>'outcome' = 'updated', 'a bare note is saved');
  r := public.update_exhibition_lead(public._t_id('l1'), json_build_object('status','follow_up')::jsonb);
  perform public._t_assert(r->>'outcome' = 'unchanged', 'a no-op reports unchanged');
  r := public.update_exhibition_lead(public._t_id('l1'), '{"contact_name":"Asha R","lead_type":"hot","company_name":"","buying_timeline":"1_3_months"}');
  perform public._t_assert(r->>'outcome' = 'updated', 'details edited');
end $$;

select public._t_assert((select count(*) = 2 from public.exhibition_lead_events where lead_id = public._t_id('l1') and event_type = 'note'),
  'both notes are kept — the second did not overwrite the first');
select public._t_assert(exists (select 1 from public.exhibition_lead_events where lead_id = public._t_id('l1') and event_type = 'status_changed' and detail->>'from' = 'new' and detail->>'to' = 'follow_up'),
  'status change recorded with from/to');
select public._t_assert(exists (select 1 from public.exhibition_lead_events where lead_id = public._t_id('l1') and event_type = 'follow_up_changed' and detail->>'from' is null),
  'follow-up date change recorded');
select public._t_assert(exists (select 1 from public.exhibition_lead_events where lead_id = public._t_id('l1') and event_type = 'details_edited' and detail->'fields' @> '["contact_name","lead_type","company_name","buying_timeline"]'::jsonb),
  'edited field names recorded, no values');
select public._t_assert(not exists (select 1 from public.exhibition_lead_events where detail::text like '%9876543210%'),
  'no phone number ever lands in an event');
select public._t_assert((select company_name is null and contact_name = 'Asha R' and lead_type = 'hot' from public.exhibition_leads where id = public._t_id('l1')), 'edits applied; blank company cleared');

-- Terminal status clears the schedule and keeps the history.
do $$
declare r jsonb;
begin
  r := public.update_exhibition_lead(public._t_id('l1'), '{"status":"converted"}');
  perform public._t_assert(r->>'outcome' = 'updated', 'converted');
end $$;
select public._t_assert((select next_follow_up_on is null and status = 'converted' from public.exhibition_leads where id = public._t_id('l1')), 'converted clears the follow-up date');
select public._t_assert(exists (select 1 from public.exhibition_lead_events where lead_id = public._t_id('l1') and event_type = 'follow_up_changed' and detail->>'to' is null and detail->>'from' is not null),
  'clearing the schedule is in the history');
select public._t_raises($q$ select public.update_exhibition_lead(public._t_id('l1'), json_build_object('next_follow_up_on', current_date + 5)::jsonb) $q$, 'closed lead');
-- Re-opening with a date is fine.
select public.update_exhibition_lead(public._t_id('l1'), json_build_object('status','contacted','next_follow_up_on', ((now() at time zone 'Asia/Kolkata')::date + 1))::jsonb);
select public._t_assert((select status = 'contacted' and next_follow_up_on is not null from public.exhibition_leads where id = public._t_id('l1')), 'a closed lead can be re-opened');

-- A number change onto an active lead's number is refused.
select public._t_as(public._t_id('s2'));
select public._t_raises($q$ select public.update_exhibition_lead(public._t_id('l2'), '{"phone":"+1 202 555 0143"}') $q$, 'DUPLICATE_PHONE');
select public._t_as(public._t_id('s1'));

-- ═══ 5. REASSIGNMENT ════════════════════════════════════════════════════════

select public._t_raises($q$ select public.reassign_exhibition_lead(public._t_id('l1'), public._t_id('s2')) $q$, 'Admin only');
select public._t_as(public._t_id('admin'));
select public._t_raises($q$ select public.reassign_exhibition_lead(public._t_id('l1'), public._t_id('x')) $q$, 'Choose an active user');
select public._t_raises($q$ select public.reassign_exhibition_lead(public._t_id('l1'), null) $q$, 'Choose an active user');
select public._t_assert((public.reassign_exhibition_lead(public._t_id('l1'), public._t_id('s2'), 'Covering Bengaluru')->>'outcome') = 'reassigned', 'admin reassigns');
select public._t_assert((public.reassign_exhibition_lead(public._t_id('l1'), public._t_id('s2'))->>'outcome') = 'unchanged', 'same owner is a no-op');

reset role;
select public._t_assert((select owner_id = public._t_id('s2') and collected_by = public._t_id('s1') from public.exhibition_leads where id = public._t_id('l1')),
  'owner moved, original collector did not');
select public._t_assert(exists (select 1 from public.exhibition_lead_events where lead_id = public._t_id('l1') and event_type = 'reassigned' and actor_id = public._t_id('admin') and detail->>'to_owner' = public._t_id('s2')::text),
  'reassignment recorded with actor');
-- Even a superuser cannot move the collector, creation time or owner by plain UPDATE.
select public._t_raises($q$ update public.exhibition_leads set collected_by = public._t_id('s2') where id = public._t_id('l1') $q$, 'EXHIBITION_LEADS_IMMUTABLE');
select public._t_raises($q$ update public.exhibition_leads set created_at = now() - interval '1 day' where id = public._t_id('l1') $q$, 'EXHIBITION_LEADS_IMMUTABLE');
select public._t_raises($q$ update public.exhibition_leads set owner_id = public._t_id('s1') where id = public._t_id('l1') $q$, 'EXHIBITION_LEADS_IMMUTABLE');
select public._t_raises($q$ update public.exhibition_leads set exhibition_id = gen_random_uuid() where id = public._t_id('l1') $q$, 'EXHIBITION_LEADS_IMMUTABLE');

set local role authenticated;
select public._t_as(public._t_id('s1'));
select public._t_assert((select count(*) = 0 from public.exhibition_leads where id = public._t_id('l1')), 'the previous owner no longer sees the lead');
select public._t_assert((public.exhibition_leads_page('{}'::jsonb)->'mine'->>'collected_total')::int = 1, 'but still has it counted as collected');
select public._t_assert((public.exhibition_leads_page('{}'::jsonb)->'mine'->>'owned_total')::int = 0, 'and no longer owns it');
select public._t_as(public._t_id('s2'));
select public._t_assert((select count(*) = 3 from public.exhibition_leads), 'S2 now works l1 (reassigned) plus l2 and l3');

-- ═══ 6. ARCHIVE / RESTORE ═══════════════════════════════════════════════════

select public._t_as(public._t_id('s2'));
select public._t_raises($q$ select public.archive_exhibition_lead(public._t_id('l2'), 'Test entry') $q$, 'Admin only');
select public._t_raises($q$ select public.restore_exhibition_lead(public._t_id('l2')) $q$, 'Admin only');

select public._t_as(public._t_id('admin'));
select public._t_raises($q$ select public.archive_exhibition_lead(public._t_id('l2'), '') $q$, 'Give a reason');
select public._t_raises($q$ select public.archive_exhibition_lead(public._t_id('l2'), 'x') $q$, 'Give a reason');
select public._t_assert((public.archive_exhibition_lead(public._t_id('l2'), 'Test entry from setup')->>'outcome') = 'archived', 'admin archives with a reason');
select public._t_assert((public.archive_exhibition_lead(public._t_id('l2'), 'Test entry from setup')->>'outcome') = 'unchanged', 'archiving twice is a no-op');

select public._t_as(public._t_id('s2'));
select public._t_raises($q$ select public.update_exhibition_lead(public._t_id('l2'), '{"lead_type":"hot"}') $q$, 'EXHIBITION_LEADS_ARCHIVED');
select public._t_assert((public.exhibition_leads_page('{}'::jsonb)->>'total')::int = 2, 'an archived lead leaves the owner''s list');

-- Archived leads do not hold the number: a replacement can be captured.
do $$
declare r jsonb;
begin
  r := public._t_create('f0000000-0000-4000-8000-000000000040', 'London Co Again', '+442079460958', 'property_owner', array['restaurant_cafe']);
  perform public._t_assert(r->>'outcome' = 'created', 'a replacement for an archived number is created: ' || r::text);
  perform set_config('t.l4', r->>'lead_id', true);
end $$;

-- Restore must not create a second active lead for the number.
select public._t_as(public._t_id('admin'));
select public._t_raises($q$ select public.restore_exhibition_lead(public._t_id('l2')) $q$, 'RESTORE_CONFLICT');
select public._t_assert((select archived_at is not null from public.exhibition_leads where id = public._t_id('l2')), 'a refused restore leaves the lead archived');
select public.archive_exhibition_lead(public._t_id('l4'), 'Duplicate of the original');
select public._t_assert((public.restore_exhibition_lead(public._t_id('l2'))->>'outcome') = 'restored', 'restore succeeds once the number is free');
select public._t_assert((public.restore_exhibition_lead(public._t_id('l2'))->>'outcome') = 'unchanged', 'restoring an active lead is a no-op');
select public._t_assert((select archived_by is null and archive_reason is null from public.exhibition_leads where id = public._t_id('l2')), 'restore clears the archive fields');
select public._t_assert((select count(*) = 2 from public.exhibition_lead_events where lead_id = public._t_id('l2') and event_type in ('archived','restored') and actor_id = public._t_id('admin')), 'archive and restore are in the history');
select public._t_assert(exists (select 1 from public.exhibition_lead_events where lead_id = public._t_id('l2') and event_type = 'archived' and note = 'Test entry from setup'), 'the archive reason is recorded');

-- ═══ 7. LIST: FILTERS, SEARCH, IST DAY EDGES, PAGING ════════════════════════

select public._t_as(public._t_id('s1'));
do $$
declare r jsonb;
begin
  r := public._t_create('f0000000-0000-4000-8000-000000000051', 'Zed Cafe Owner', '9000000001', 'property_owner', array['restaurant_cafe'], 'Zed Cafe Pvt', 'Mysuru', 'later', 'warm');
  perform set_config('t.m1', r->>'lead_id', true);
  r := public._t_create('f0000000-0000-4000-8000-000000000052', 'Bala', '9000000002', 'other', array['hotel'], null, 'Bengaluru', null, 'long_term', null, 'Furniture retailer');
  perform set_config('t.m2', r->>'lead_id', true);
  r := public._t_create('f0000000-0000-4000-8000-000000000053', 'Chitra', '9000000003', 'consultant', array['restaurant_cafe','hotel'], null, 'Chennai', null, 'hot');
  perform set_config('t.m3', r->>'lead_id', true);
  -- m2 due today
  perform public.update_exhibition_lead(public._t_id('m2'),
    json_build_object('status','follow_up','next_follow_up_on',(now() at time zone 'Asia/Kolkata')::date)::jsonb);
end $$;

reset role;
-- m3: follow-up that has gone overdue (a past date cannot be entered, only age into).
update public.exhibition_leads set status = 'follow_up', next_follow_up_on = (now() at time zone 'Asia/Kolkata')::date - 1
 where id = public._t_id('m3');

-- Place every lead on a known IST moment (immutability trigger off, this test only).
alter table public.exhibition_leads disable trigger exhibition_leads_guard_immutable;
update public.exhibition_leads set created_at = case id
    when public._t_id('l1') then timestamptz '2026-10-09 12:00:00+05:30'
    when public._t_id('m1') then timestamptz '2026-10-09 23:59:59+05:30'
    when public._t_id('m2') then timestamptz '2026-10-10 00:00:00+05:30'
    when public._t_id('m3') then timestamptz '2026-10-10 23:59:59+05:30'
    when public._t_id('l2') then timestamptz '2026-10-10 10:00:00+05:30'
    when public._t_id('l3') then timestamptz '2026-10-11 10:00:00+05:30'
    when public._t_id('l4') then timestamptz '2026-10-11 11:00:00+05:30'
  end
 where id in (public._t_id('l1'), public._t_id('m1'), public._t_id('m2'), public._t_id('m3'),
              public._t_id('l2'), public._t_id('l3'), public._t_id('l4'));
alter table public.exhibition_leads enable trigger exhibition_leads_guard_immutable;

set local role authenticated;
select public._t_as(public._t_id('s1'));


select public._t_assert(public._t_total('{}') = 3, 'S1 owns m1, m2, m3');
-- IST day edges: 23:59:59 on the 9th vs 00:00:00 on the 10th.
select public._t_assert(public._t_total('{"date_from":"2026-10-09","date_to":"2026-10-09"}') = 1, '9 Oct holds the 23:59:59 IST entry only');
select public._t_assert(public._t_total('{"date_from":"2026-10-10","date_to":"2026-10-10"}') = 2, '10 Oct holds 00:00:00 and 23:59:59 IST');
select public._t_assert(public._t_total('{"date_from":"2026-10-09","date_to":"2026-10-10"}') = 3, 'a range spans both days');
select public._t_assert(public._t_total('{"date_from":"2026-10-11","date_to":"2026-10-11"}') = 0, 'an empty day is zero');
select public._t_assert(
  (select jsonb_agg(x->>'date' order by x->>'date' desc) = '["2026-10-10","2026-10-09"]'::jsonb and sum((x->>'count')::int) = 3
     from jsonb_array_elements(public.exhibition_leads_page('{}'::jsonb)->'date_counts') x),
  'per-day counts: newest day first, summing to the full total');
select public._t_assert(
  (select string_agg(x->>'contact_name', ',') = 'Chitra,Bala,Zed Cafe Owner' from jsonb_array_elements(public.exhibition_leads_page('{}'::jsonb)->'rows') x),
  'newest entries first');
-- OR inside a category, AND across categories.
select public._t_assert(public._t_total('{"client_types":["consultant","other"]}') = 2, 'client types OR');
select public._t_assert(public._t_total('{"client_types":["consultant","other"],"lead_types":["hot"]}') = 1, 'categories AND');
select public._t_assert(public._t_total('{"requirements":["restaurant_cafe"]}') = 2, 'requirements overlap (OR)');
select public._t_assert(public._t_total('{"lead_types":["long_term","warm"]}') = 2, 'lead types OR');
select public._t_assert(public._t_total('{"lead_types":["mismatched_retail"]}') = 0, 'a lead type nobody has matches nothing');
select public._t_assert(public._t_total('{"cities":["BENGALURU","mysuru"]}') = 2, 'city is case-insensitive and OR');
select public._t_assert(public._t_total('{"timelines":["later"]}') = 1, 'timeline filter');
select public._t_assert(public._t_total('{"statuses":["follow_up"]}') = 2, 'status filter');
select public._t_assert(public._t_total('{"follow_ups":["due_today"]}') = 1, 'due today');
select public._t_assert(public._t_total('{"follow_ups":["overdue"]}') = 1, 'overdue');
select public._t_assert(public._t_total('{"follow_ups":["not_scheduled"]}') = 1, 'not scheduled');
select public._t_assert(public._t_total('{"follow_ups":["overdue","due_today"]}') = 2, 'follow-up options OR');
-- Search.
select public._t_assert(public._t_total('{"search":"zed"}') = 1, 'search by name');
select public._t_assert(public._t_total('{"search":"CAFE PVT"}') = 1, 'search by company, case-insensitive');
select public._t_assert(public._t_total('{"search":"900000"}') = 3, 'search by number digits');
select public._t_assert(public._t_total('{"search":"+91 90000 00002"}') = 1, 'search by a formatted number');
select public._t_assert(public._t_total('{"search":"%"}') = 0, 'a percent sign is not a wildcard');
select public._t_assert(public._t_total('{"search":"_"}') = 0, 'an underscore is not a wildcard');
select public._t_assert(public._t_total('{"search":"zed","lead_types":["hot"]}') = 0, 'search ANDs with filters');
-- Paging never changes the matching total.
select public._t_assert(
  (select (r->>'total')::int = 3 and jsonb_array_length(r->'rows') = 2 from (select public.exhibition_leads_page('{}'::jsonb, 2, 0) r) q), 'page 1 of 2');
select public._t_assert(
  (select (r->>'total')::int = 3 and jsonb_array_length(r->'rows') = 1 from (select public.exhibition_leads_page('{}'::jsonb, 2, 2) r) q), 'page 2 holds the remainder');
select public._t_assert(
  (select (r->>'total')::int = 3 and jsonb_array_length(r->'rows') = 0 from (select public.exhibition_leads_page('{}'::jsonb, 0, 0) r) q), 'limit 0 returns counts only');
-- Cities facet.
select public._t_assert((public.exhibition_leads_page('{}'::jsonb)->'cities') @> '["Bengaluru","Chennai","Mysuru"]'::jsonb, 'city options come from the visible leads');

-- Admin.
select public._t_as(public._t_id('admin'));
select public._t_assert(public._t_total('{"scope":"mine"}') = 0, 'admin "mine" is what admin owns');
select public._t_assert(public._t_total('{"scope":"all"}') = 6, 'admin "all" sees every active lead');
select public._t_assert(public._t_total('{"scope":"all","archived":"archived"}') = 1, 'archived view');
select public._t_assert(public._t_total('{"scope":"all","archived":"all"}') = 7, 'active and archived');
select public._t_assert(public._t_total('{"scope":"all","collector_ids":["e1ead000-0000-4000-8000-000000000002"]}') = 4, 'by original collector (incl. the reassigned one)');
select public._t_assert(public._t_total('{"scope":"all","owner_ids":["e1ead000-0000-4000-8000-000000000003"]}') = 3, 'by current owner');
select public._t_assert(public._t_total('{"scope":"all","collector_ids":["e1ead000-0000-4000-8000-000000000002"],"owner_ids":["e1ead000-0000-4000-8000-000000000003"]}') = 1, 'collector AND owner');
select public._t_assert(
  (select (r->'summary'->>'active_valid')::int = 6 and (r->'summary'->>'hot')::int = 2 and (r->'summary'->>'overdue')::int = 1
     from (select public.exhibition_leads_page('{"scope":"all"}'::jsonb, 2, 0) r) q),
  'summary figures cover the whole matching set, not the 2-row page');
select public._t_assert(
  (select (r->'summary'->>'active_valid')::int = 2 and (r->'summary'->>'overdue')::int = 1
     from (select public.exhibition_leads_page('{"scope":"all","statuses":["follow_up"]}'::jsonb, 1, 0) r) q),
  'summary figures follow the filters');
-- Overdue excludes archived leads.
select public.archive_exhibition_lead(public._t_id('m3'), 'Test');
select public._t_assert(public._t_total('{"scope":"all","follow_ups":["overdue"]}') = 0, 'an archived lead is not overdue');
select public.restore_exhibition_lead(public._t_id('m3'));

-- ═══ 8. RANKING ═════════════════════════════════════════════════════════════

reset role;
-- Two out-of-event entries and a lead by a collector who is then reassigned out.
set local role authenticated;
select public._t_as(public._t_id('s2'));
select public._t_create('f0000000-0000-4000-8000-000000000061', 'Before Fair', '9111111111');
select public._t_create('f0000000-0000-4000-8000-000000000062', 'After Fair',  '9111111112');
reset role;
alter table public.exhibition_leads disable trigger exhibition_leads_guard_immutable;
update public.exhibition_leads set created_at = timestamptz '2026-10-08 12:00:00+05:30' where contact_name = 'Before Fair';
update public.exhibition_leads set created_at = timestamptz '2026-10-12 00:00:01+05:30' where contact_name = 'After Fair';
alter table public.exhibition_leads enable trigger exhibition_leads_guard_immutable;

set local role authenticated;
select public._t_as(public._t_id('s1'));
select public._t_raises($q$ select public.exhibition_lead_ranking(public._t_id('exh')) $q$, 'Admin only');
select public._t_as(public._t_id('admin'));



select public._t_assert(public._t_rank('EXL Sales 1') = 4, 'S1 total: l1(reassigned away) + m1 + m2 + m3');
select public._t_assert(public._t_rank('EXL Sales 1', '2026-10-09') = 2, 'S1 on 9 Oct (12:00 and 23:59:59 IST)');
select public._t_assert(public._t_rank('EXL Sales 1', '2026-10-10') = 2, 'S1 on 10 Oct (00:00:00 and 23:59:59 IST)');
select public._t_assert(public._t_rank('EXL Sales 1', '2026-10-11') = 0, 'S1 on 11 Oct');
select public._t_assert(public._t_rank('EXL Sales 2') = 2, 'S2 total: l2 + l3; the archived l4 and the two out-of-event entries do not count');
select public._t_assert(public._t_rank('EXL Sales 2', '2026-10-10') = 1 and public._t_rank('EXL Sales 2', '2026-10-11') = 1, 'S2 per day');
select public._t_assert(public._t_rank('EXL Sales 3') = 0, 'an eligible salesperson with zero leads is listed');
select public._t_assert(public._t_rank('EXL Admin') = -1, 'an admin with no leads is not a ranked salesperson');
select public._t_assert(public._t_rank('EXL Outsider') = -1, 'a user without access is not ranked');
select public._t_assert(
  (select r->>'is_final' = ((now() at time zone 'Asia/Kolkata')::date > date '2026-10-11')::text
     from (select public.exhibition_lead_ranking(public._t_id('exh')) r) q), 'is_final follows the IST date');
select public._t_assert(
  (select jsonb_array_length(r->'days') = 3 from (select public.exhibition_lead_ranking(public._t_id('exh')) r) q), 'three exhibition days');
-- Archive removes credit; restore returns it to the same collector and day.
select public.archive_exhibition_lead(public._t_id('m3'), 'Test');
select public._t_assert(public._t_rank('EXL Sales 1') = 3 and public._t_rank('EXL Sales 1', '2026-10-10') = 1, 'archived lead loses credit');
select public.restore_exhibition_lead(public._t_id('m3'));
select public._t_assert(public._t_rank('EXL Sales 1') = 4 and public._t_rank('EXL Sales 1', '2026-10-10') = 2, 'restored lead returns its credit to the original day');
-- Reassigning does not move credit.
select public.reassign_exhibition_lead(public._t_id('m1'), public._t_id('s3'));
select public._t_assert(public._t_rank('EXL Sales 1') = 4 and public._t_rank('EXL Sales 3') = 0, 'reassignment moves no credit');
-- The ranking ignores every list filter by construction (it takes none).

-- Collectors with valid leads stay ranked after they are deactivated or move
-- department; their credit is theirs forever.
reset role;
update public.users set is_active = false where id = public._t_id('s1');
update public.users set team = 'design' where id = public._t_id('s2');
set local role authenticated;
select public._t_as(public._t_id('admin'));
select public._t_assert(public._t_rank('EXL Sales 1') = 4 and public._t_rank('EXL Sales 1', '2026-10-09') = 2, 'a deactivated collector keeps their credit and row');
select public._t_assert(public._t_rank('EXL Sales 2') = 2, 'a collector who changed department keeps their credit and row');
select public._t_assert(public._t_rank('EXL Sales 3') = 0, 'an eligible salesperson with nothing is still listed');
reset role;
update public.users set is_active = true where id = public._t_id('s1');
update public.users set team = 'sales' where id = public._t_id('s2');
set local role authenticated;
select public._t_as(public._t_id('admin'));

-- ═══ 9. EXPORT ══════════════════════════════════════════════════════════════

select public._t_as(public._t_id('s1'));
select public._t_raises($q$ select public.export_exhibition_leads('{}'::jsonb) $q$, 'Admin only');
select public._t_as(public._t_id('admin'));
select public._t_assert(
  jsonb_array_length(public.export_exhibition_leads('{"scope":"all","archived":"all"}'::jsonb)) = public._t_total('{"scope":"all","archived":"all"}'),
  'an export holds the whole matching set');
select public._t_assert(
  jsonb_array_length(public.export_exhibition_leads('{"scope":"all","archived":"all"}'::jsonb, 3, 0))
  + jsonb_array_length(public.export_exhibition_leads('{"scope":"all","archived":"all"}'::jsonb, 3, 3))
  + jsonb_array_length(public.export_exhibition_leads('{"scope":"all","archived":"all"}'::jsonb, 3, 6))
  + jsonb_array_length(public.export_exhibition_leads('{"scope":"all","archived":"all"}'::jsonb, 3, 9)) = public._t_total('{"scope":"all","archived":"all"}'),
  'pages of an export add up to the same set, none repeated or lost');
select public._t_assert(
  jsonb_array_length(public.export_exhibition_leads('{"scope":"all","client_types":["consultant"]}'::jsonb)) = public._t_total('{"scope":"all","client_types":["consultant"]}'),
  'an export follows the filters');
select public._t_assert((public.export_exhibition_leads('{"scope":"all"}'::jsonb, 1, 0)->0->>'exhibition_name') = 'Acetech Bangalore 2026', 'the export carries the exhibition name');

-- ═══ 9b. EXHIBITION MANAGEMENT (20270306000000) ════════════════════════════

select public._t_as(public._t_id('s1'));
select public._t_raises($q$ select public.create_exhibition('Nope Fair', 'Pune', date '2027-01-10', date '2027-01-12') $q$, 'Admin only');
select public._t_raises($q$ select public.update_exhibition(public._t_id('exh'), 'X', 'Y', date '2026-10-09', date '2026-10-11', true) $q$, 'Admin only');
select public._t_raises($q$ select public.list_exhibitions_admin() $q$, 'Admin only');
select public._t_raises($q$ insert into public.exhibitions (slug, name, starts_on, ends_on) values ('x1', 'X', date '2027-01-01', date '2027-01-02') $q$, 'permission denied');
select public._t_raises($q$ update public.exhibitions set is_active = false $q$, 'permission denied');

select public._t_as(public._t_id('admin'));
do $$
declare r jsonb;
begin
  r := public.create_exhibition('  Test Fair 2027 ', ' Pune ', date '2027-01-10', date '2027-01-12');
  perform set_config('t.fair2', r->>'id', true);
  perform public._t_assert(r->>'slug' = 'test-fair-2027', 'slug derived from the name: ' || (r->>'slug'));
  perform public._t_assert((select name = 'Test Fair 2027' and city = 'Pune' and is_active and created_by = public._t_id('admin')
                              from public.exhibitions where id = public._t_id('fair2')), 'trimmed, active, created by the admin');
  r := public.create_exhibition('Test Fair 2027!', null, date '2027-02-01', date '2027-02-02');
  perform public._t_assert(r->>'slug' = 'test-fair-2027-2', 'a clashing slug gets a suffix: ' || (r->>'slug'));
  perform set_config('t.fair3', r->>'id', true);
end $$;
select public._t_raises($q$ select public.create_exhibition('TEST FAIR 2027', null, date '2027-03-01', date '2027-03-02') $q$, 'already exists');
select public._t_raises($q$ select public.create_exhibition('  test fair 2027  ', null, date '2027-03-01', date '2027-03-02') $q$, 'already exists');
select public._t_raises($q$ select public.create_exhibition('   ', null, date '2027-03-01', date '2027-03-02') $q$, 'exhibition name');
select public._t_raises($q$ select public.create_exhibition('Backwards', null, date '2027-03-05', date '2027-03-02') $q$, 'cannot be before');
select public._t_raises($q$ select public.create_exhibition('Too Long', null, date '2027-03-01', date '2027-04-01') $q$, 'at most 31 days');
select public._t_raises($q$ select public.create_exhibition('No Dates', null, null, date '2027-03-02') $q$, 'first and last day');
select public._t_assert((public.create_exhibition('One Day', null, date '2027-04-01', date '2027-04-01')->>'slug') = 'one-day', 'a one-day exhibition is fine');
select public._t_assert((public.create_exhibition('31 Days', null, date '2027-05-01', date '2027-05-31')->>'slug') = '31-days', 'exactly 31 days is fine');

-- Closing: no NEW leads, but everything stays readable.
select public._t_assert((public.update_exhibition(public._t_id('fair2'), 'Test Fair 2027', 'Pune', date '2027-01-10', date '2027-01-12', false)->>'id')::uuid = public._t_id('fair2'), 'closed');
select public._t_as(public._t_id('s1'));
select public._t_raises($q$ select public.create_exhibition_lead('f0000000-0000-4000-8000-000000000a01'::uuid, public._t_id('fair2'), 'Late Visitor', '9000000501', 'consultant', array['hotel'], null, null, null, 'warm', null, null) $q$, 'Unknown exhibition');
select public._t_assert((select count(*) = 1 from public.exhibitions where id = public._t_id('fair2')), 'a salesperson can still read a closed exhibition');

-- Re-open: leads can be added, and are scoped to that exhibition.
select public._t_as(public._t_id('admin'));
select public.update_exhibition(public._t_id('fair2'), 'Test Fair 2027', 'Pune', date '2027-01-10', date '2027-01-12', true);
select public._t_as(public._t_id('s1'));
select public._t_assert((public.create_exhibition_lead('f0000000-0000-4000-8000-000000000a02'::uuid, public._t_id('fair2'), 'Pune Visitor', '9000000502', 'consultant', array['hotel'], null, null, null, 'warm', null, null)->>'outcome') = 'created', 'a lead can be added to the re-opened exhibition');
-- the same number is a different person at a different fair: one active lead per number PER exhibition
select public._t_assert((public.create_exhibition_lead('f0000000-0000-4000-8000-000000000a03'::uuid, public._t_id('exh'), 'Pune Visitor Again', '9000000502', 'consultant', array['hotel'], null, null, null, 'warm', null, null)->>'outcome') = 'created', 'the same number can be captured at another exhibition');
select public._t_assert((public.exhibition_leads_page(json_build_object('exhibition_id', public._t_id('fair2'))::jsonb)->>'total')::int = 1, 'the list is scoped to the exhibition');
select public._t_as(public._t_id('admin'));
select public._t_assert((select count(*) = 3 from jsonb_array_elements(public.exhibition_lead_ranking(public._t_id('fair2'))->'days')), 'ranking draws one column per day (3)');
-- a closed exhibition keeps its leads, its list and its ranking
select public.update_exhibition(public._t_id('fair2'), 'Test Fair 2027', 'Pune', date '2027-01-10', date '2027-01-14', false);
select public._t_assert((public.exhibition_leads_page(json_build_object('exhibition_id', public._t_id('fair2'), 'scope', 'all')::jsonb)->>'total')::int = 1, 'closing hides no leads');
select public._t_assert((select count(*) = 5 from jsonb_array_elements(public.exhibition_lead_ranking(public._t_id('fair2'))->'days')), 'changing the dates changes the ranking columns (5)');
select public._t_raises($q$ select public.update_exhibition(public._t_id('fair2'), 'Acetech Bangalore 2026', 'Pune', date '2027-01-10', date '2027-01-12', true) $q$, 'already exists');
select public._t_raises($q$ select public.update_exhibition(public._t_id('fair2'), 'Test Fair 2027', 'Pune', date '2027-01-10', date '2027-01-12', null) $q$, 'open for new leads');
select public._t_raises($q$ select public.update_exhibition(gen_random_uuid(), 'X', null, date '2027-01-10', date '2027-01-12', true) $q$, 'Exhibition not found');
select public._t_assert(
  (select (e->>'leads')::int = 1 and e->>'is_active' = 'false' and e->>'city' = 'Pune'
     from jsonb_array_elements(public.list_exhibitions_admin()) e where e->>'name' = 'Test Fair 2027'),
  'the admin list shows its lead count and state');
select public._t_assert((select count(*) >= 5 from jsonb_array_elements(public.list_exhibitions_admin())), 'the admin list holds every exhibition, closed or not');
-- the table stays unwritable for clients (the migration self-checks it too)
select public._t_assert(not has_table_privilege('authenticated', 'public.exhibitions', 'INSERT'), 'clients cannot insert exhibitions directly');

select public._t_as(public._t_id('s1'));

-- The agreed vocabularies, and "Other" needs its message.
select public._t_raises($q$ select public._t_create('f0000000-0000-4000-8000-000000000003', 'A', '9876500003', 'dealer') $q$, 'client type');
select public._t_raises($q$ select public._t_create('f0000000-0000-4000-8000-000000000003', 'A', '9876500003', 'hotel_resort') $q$, 'client type');
select public._t_raises($q$ select public._t_create('f0000000-0000-4000-8000-000000000003', 'A', '9876500003', 'consultant', array['chairs']) $q$, 'requirement');
select public._t_raises($q$ select public._t_create('f0000000-0000-4000-8000-000000000003', 'A', '9876500003', 'consultant', array['hotel'], null, null, null, 'general_interest') $q$, 'lead type');
select public._t_raises($q$ select public._t_create('f0000000-0000-4000-8000-000000000003', 'A', '9876500003', 'other') $q$, 'what kind of client');
select public._t_raises($q$ select public._t_create('f0000000-0000-4000-8000-000000000003', 'A', '9876500003', 'other', array['hotel'], null, null, null, null, null, '   ') $q$, 'what kind of client');
select public._t_raises($q$ select public._t_create('f0000000-0000-4000-8000-000000000003', 'A', '9876500003', 'other', array['hotel'], null, null, null, null, null, repeat('x', 201)) $q$, 'too long');
select public._t_assert((select count(*) = 0 from public.exhibition_leads where phone_e164 in ('+919876500003')), 'rejected vocabulary stored nothing');
do $$
declare r jsonb; l public.exhibition_leads;
begin
  r := public._t_create('f0000000-0000-4000-8000-000000000004', 'Other Client', '9876500004', 'other', array['restaurant_cafe'], null, null, null, 'long_term', null, '  Furniture retailer ');
  perform public._t_assert(r->>'outcome' = 'created', 'Other with a message is created');
  select * into l from public.exhibition_leads where id = (r->>'lead_id')::uuid;
  perform public._t_assert(l.client_type_other = 'Furniture retailer' and l.lead_type = 'long_term', 'message trimmed and stored; lead type stored');
  perform set_config('t.lo', r->>'lead_id', true);
  -- a message supplied for a type that is not Other is dropped, not stored
  r := public._t_create('f0000000-0000-4000-8000-000000000005', 'Consultant Client', '9876500005', 'consultant', array['hotel'], null, null, null, 'mismatched_retail', null, 'ignored');
  perform public._t_assert((select client_type_other is null and lead_type = 'mismatched_retail' from public.exhibition_leads where id = (r->>'lead_id')::uuid), 'no message kept for a non-Other type');
  -- the Other message is part of the entry: same id with a different message is a conflict
end $$;
select public._t_raises($q$ select public._t_create('f0000000-0000-4000-8000-000000000004', 'Other Client', '9876500004', 'other', array['restaurant_cafe'], null, null, null, 'long_term', null, 'Something else') $q$, 'SUBMISSION_CONFLICT');
-- Lead type is mandatory: on create, on update, and in the table itself.
select public._t_raises($q$ select public._t_create('f0000000-0000-4000-8000-000000000006', 'No Lead Type', '9876500006', 'consultant', array['hotel'], null, null, null, null) $q$, 'Choose a lead type');
select public._t_raises($q$ select public._t_create('f0000000-0000-4000-8000-000000000006', 'No Lead Type', '9876500006', 'consultant', array['hotel'], null, null, null, '   ') $q$, 'Choose a lead type');
select public._t_assert((select count(*) = 0 from public.exhibition_leads where phone_e164 = '+919876500006'), 'a lead without a lead type stored nothing');
-- updating: Other keeps its message rule; switching away clears it; lead type can change but never be emptied
select public._t_raises($q$ select public.update_exhibition_lead(public._t_id('lo'), '{"client_type_other":""}') $q$, 'what kind of client');
select public._t_raises($q$ select public.update_exhibition_lead(public._t_id('lo'), '{"lead_type":"urgent"}') $q$, 'Unknown lead type');
select public._t_raises($q$ select public.update_exhibition_lead(public._t_id('lo'), '{"client_type":"dealer"}') $q$, 'client type');
select public._t_raises($q$ select public.update_exhibition_lead(public._t_id('lo'), '{"requirements":["chairs"]}') $q$, 'Unknown requirement');
select public._t_assert((public.update_exhibition_lead(public._t_id('lo'), '{"client_type_other":"Furniture wholesaler"}')->>'outcome') = 'updated', 'the Other message can be edited');
select public._t_assert((public.update_exhibition_lead(public._t_id('lo'), '{"client_type":"consultant"}')->>'outcome') = 'updated', 'switch to Consultant');
select public._t_assert((select client_type_other is null from public.exhibition_leads where id = public._t_id('lo')), 'switching away from Other clears the message');
select public._t_raises($q$ select public.update_exhibition_lead(public._t_id('lo'), '{"client_type":"other"}') $q$, 'what kind of client');
select public._t_assert((public.update_exhibition_lead(public._t_id('lo'), '{"client_type":"other","client_type_other":"Gallery"}')->>'outcome') = 'updated', 'back to Other with a message');
select public._t_raises($q$ select public.update_exhibition_lead(public._t_id('lo'), '{"lead_type":""}') $q$, 'Choose a lead type');
select public._t_raises($q$ select public.update_exhibition_lead(public._t_id('lo'), '{"lead_type":null}') $q$, 'Choose a lead type');
select public._t_assert((public.update_exhibition_lead(public._t_id('lo'), '{"lead_type":"hot"}')->>'outcome') = 'updated', 'lead type can be changed');
select public._t_assert((select lead_type = 'hot' from public.exhibition_leads where id = public._t_id('lo')), 'lead type is now hot');
select public._t_assert(exists (select 1 from public.exhibition_lead_events where lead_id = public._t_id('lo') and event_type = 'details_edited' and detail->'fields' @> '["client_type_other"]'::jsonb), 'the message edit is in the history');
-- the table itself refuses an Other without a message (even for a superuser)
reset role;
select public._t_raises($q$ update public.exhibition_leads set client_type = 'other', client_type_other = null where id = public._t_id('lo') $q$, 'exhibition_leads_other_has_message');
select public._t_raises($q$ update public.exhibition_leads set client_type = 'consultant', client_type_other = 'x' where id = public._t_id('lo') $q$, 'exhibition_leads_other_has_message');
select public._t_raises($q$ update public.exhibition_leads set lead_type = null where id = public._t_id('lo') $q$, 'not-null constraint');
set local role authenticated;
select public._t_as(public._t_id('s1'));

-- ═══ 10. AUDIT TRAIL, MODULE GATE, FUNCTION HYGIENE ════════════════════════

reset role;
-- Every SECURITY DEFINER function of the module pins search_path (pg_temp last)
-- and nobody but an intended caller can execute it.
select public._t_assert(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and (p.proname like 'exhibition_lead%' or p.proname in ('create_exhibition_lead','update_exhibition_lead','reassign_exhibition_lead','archive_exhibition_lead','restore_exhibition_lead','get_exhibition_lead','export_exhibition_leads'))
      and not (exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%pg_temp')) ) = 0,
  'every definer function pins search_path with pg_temp last');
select public._t_assert(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname like 'exhibition_lead%' or p.proname like '%_exhibition_lead%' or p.proname = 'normalize_lead_phone')
      and has_function_privilege('anon', p.oid, 'EXECUTE')) = 0,
  'anon can execute none of the module functions');
select public._t_raises($q$ update public.exhibition_lead_events set note = 'tamper' $q$, 'EXHIBITION_LEADS_APPEND_ONLY');
select public._t_raises($q$ delete from public.exhibition_lead_events $q$, 'EXHIBITION_LEADS_APPEND_ONLY');

-- Revoking the module for a salesperson closes every door at once.
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select public._t_id('s3'), mpa.module_id, mpa.action_id, false, public._t_id('admin')
  from public.module_permission_actions mpa
  join public.permission_modules pm on pm.id = mpa.module_id and pm.module_key = 'exhibition_leads'
  join public.permission_actions pa on pa.id = mpa.action_id and pa.action_key = 'view';
set local role authenticated;
select public._t_as(public._t_id('s3'));
select public._t_raises($q$ select public.exhibition_leads_page('{}'::jsonb) $q$, 'EXHIBITION_LEADS_FORBIDDEN');
select public._t_assert((select count(*) = 0 from public.exhibition_leads), 'RLS gate: a revoked user reads no rows even of leads they own (m1)');
select public._t_assert((select count(*) = 0 from public.exhibition_lead_events), 'RLS gate: nor events');
select public._t_as(public._t_id('admin'));
select public._t_raises($q$ select public.reassign_exhibition_lead(public._t_id('m2'), public._t_id('s3')) $q$, 'Choose an active user');

reset role;
do $$ begin raise notice 'ALL EXHIBITION LEADS ASSERTIONS PASSED'; end $$;
rollback;
