-- ═════════════════════════════════════════════════════════════════════════════
-- TEST-ONLY — behavioural assertions for 20261214000000 (Meetings RPCs require
-- module entry)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THIS FILE MUST NEVER ENTER supabase/migrations, AND MUST NEVER RUN ON PRODUCTION.
-- Run it only through supabase/tests/run_meetings_rpc_module_entry_local.sh, which
-- refuses any database not marked disposable and empty.
--
-- ONE TRANSACTION, ROLLED BACK. Every call acts as a real user: the JWT claim makes
-- auth.uid() that user and `set local role authenticated` puts it through the same
-- grants, RLS and SECURITY DEFINER guards the browser meets. Fixtures are written
-- as postgres.
--
-- EVERY CALL IS ISOLATED. pg_temp.try() runs one statement inside its own
-- subtransaction and then ALWAYS rolls it back (a success raises a sentinel), so
-- one call's success can never change what the next call sees. That is also what
-- lets the runner execute this file BEFORE the migration and get the complete
-- list of RPC × user pairs the defect lets through, rather than the first one.
--
-- Failures are collected, not raised one at a time; the last block raises once
-- with all of them, after printing
--   SUMMARY refusal_failures=<n> allow_failures=<n> other_failures=<n>
-- which the runner reads.
--
-- Refusals are asserted by exact message AND SQLSTATE, so a refusal for any other
-- reason (MEETING_MISSING, MEETING_COMPLETED, "permission to change this meeting",
-- a task that is not linkable, ...) counts as a failure.
--
--   1  fixtures: seven users, permission overrides proved through resolve_permission
--   2  REFUSED — lead with Meetings 'view' removed         (every RPC, own meeting)
--   3  REFUSED — creator with Meetings 'view' removed      (every RPC, own meeting)
--   4  REFUSED — Meetings 'edit' holder with 'view' removed (every RPC)
--   5  REFUSED — Meetings 'manage' holder with 'view' removed (every RPC)
--   6  refused users still read nothing
--   7  ALLOWED — lead with view (every RPC)
--   8  ALLOWED — Meetings 'edit' holder with view, not lead/creator (every RPC)
--   9  ALLOWED — admin (every RPC)
--  10  ALLOWED — the section 2 lead once 'view' is given back
--  11  a real, committed-in-transaction write by the lead: row + history readable
--  12  coverage: every authenticated-executable definer function that authorizes
--      through assert_meeting_editor, plus can_edit_meeting, was exercised
--  13  verdict

\set ON_ERROR_STOP on

begin;
set local lock_timeout = '3s';

-- ═══ 1. Fixtures (as postgres) ══════════════════════════════════════════════

create temp table failures (kind text not null, detail text not null);
create temp table covered (fn text not null);
grant all on failures, covered to authenticated;

-- A  admin
-- L  lead of MA, Meetings view                      (normal editor)
-- E  Meetings edit + view, lead/creator of nothing  (normal editor)
-- LN lead of MB / MC, Meetings view REMOVED
-- CN creator of MB / MC, Meetings view REMOVED
-- EN Meetings edit, view REMOVED
-- MN Meetings manage, view REMOVED
insert into public.users (id, full_name, role, team, is_active, created_at, updated_at) values
  ('00000000-0000-4000-8000-0000000001a1', 'Entry Admin',          'admin',  'management', true, now(), now()),
  ('00000000-0000-4000-8000-0000000001b1', 'Entry Lead',           'member', 'operations', true, now(), now()),
  ('00000000-0000-4000-8000-0000000001b2', 'Entry Editor',         'member', 'operations', true, now(), now()),
  ('00000000-0000-4000-8000-0000000001c1', 'Entry Lead No View',   'member', 'operations', true, now(), now()),
  ('00000000-0000-4000-8000-0000000001c2', 'Entry Creator No View','member', 'operations', true, now(), now()),
  ('00000000-0000-4000-8000-0000000001c3', 'Entry Edit No View',   'member', 'operations', true, now(), now()),
  ('00000000-0000-4000-8000-0000000001c4', 'Entry Manage No View', 'member', 'operations', true, now(), now());

insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select o.user_id, pm.id, pa.id, o.allowed, '00000000-0000-4000-8000-0000000001a1'
from (values
  ('00000000-0000-4000-8000-0000000001b1'::uuid, 'view',   true),
  ('00000000-0000-4000-8000-0000000001b2'::uuid, 'view',   true),
  ('00000000-0000-4000-8000-0000000001b2'::uuid, 'edit',   true),
  ('00000000-0000-4000-8000-0000000001c1'::uuid, 'view',   false),
  ('00000000-0000-4000-8000-0000000001c2'::uuid, 'view',   false),
  ('00000000-0000-4000-8000-0000000001c3'::uuid, 'view',   false),
  ('00000000-0000-4000-8000-0000000001c3'::uuid, 'edit',   true),
  ('00000000-0000-4000-8000-0000000001c4'::uuid, 'view',   false),
  ('00000000-0000-4000-8000-0000000001c4'::uuid, 'manage', true)
) as o(user_id, action_key, allowed)
join public.permission_modules pm on pm.module_key = 'meetings'
join public.permission_actions pa on pa.action_key = o.action_key;

do $$
begin
  if not public.resolve_permission('00000000-0000-4000-8000-0000000001b1', 'meetings', 'view')
     or not public.resolve_permission('00000000-0000-4000-8000-0000000001b2', 'meetings', 'view')
     or not public.resolve_permission('00000000-0000-4000-8000-0000000001b2', 'meetings', 'edit')
     or public.resolve_permission('00000000-0000-4000-8000-0000000001c1', 'meetings', 'view')
     or public.resolve_permission('00000000-0000-4000-8000-0000000001c2', 'meetings', 'view')
     or public.resolve_permission('00000000-0000-4000-8000-0000000001c3', 'meetings', 'view')
     or not public.resolve_permission('00000000-0000-4000-8000-0000000001c3', 'meetings', 'edit')
     or public.resolve_permission('00000000-0000-4000-8000-0000000001c4', 'meetings', 'view')
     or not public.resolve_permission('00000000-0000-4000-8000-0000000001c4', 'meetings', 'manage') then
    raise exception 'FIXTURE: the permission overrides did not take effect';
  end if;
  raise notice 'PASS 1  fixtures: view removed from LN/CN/EN/MN; EN keeps edit, MN keeps manage';
end $$;

-- MA: lead L, draft.  MB: lead LN, creator CN, draft.
-- MC: completed, lead LN, creator CN.  MCL: completed, lead L.
insert into public.meetings (id, meeting_type, meeting_date, title, lead_id, status, created_by, completed_at, completed_by) values
  ('00000000-0000-4000-8000-0000000002a1', 'new_order', current_date, 'Entry MA',  '00000000-0000-4000-8000-0000000001b1', 'draft',     '00000000-0000-4000-8000-0000000001a1', null,  null),
  ('00000000-0000-4000-8000-0000000002b1', 'new_order', current_date, 'Entry MB',  '00000000-0000-4000-8000-0000000001c1', 'draft',     '00000000-0000-4000-8000-0000000001c2', null,  null),
  ('00000000-0000-4000-8000-0000000002c1', 'new_order', current_date, 'Entry MC',  '00000000-0000-4000-8000-0000000001c1', 'completed', '00000000-0000-4000-8000-0000000001c2', now(), '00000000-0000-4000-8000-0000000001c2'),
  ('00000000-0000-4000-8000-0000000002c2', 'new_order', current_date, 'Entry MCL', '00000000-0000-4000-8000-0000000001b1', 'completed', '00000000-0000-4000-8000-0000000001a1', now(), '00000000-0000-4000-8000-0000000001a1');

-- OA/OB carry an item; OA2/OB2 are empty, so removing them is only a guard question.
insert into public.meeting_orders (id, meeting_id, order_number, order_type, created_by) values
  ('00000000-0000-4000-8000-0000000003a1', '00000000-0000-4000-8000-0000000002a1', '1001', 'new_order', '00000000-0000-4000-8000-0000000001a1'),
  ('00000000-0000-4000-8000-0000000003a2', '00000000-0000-4000-8000-0000000002a1', '1002', 'new_order', '00000000-0000-4000-8000-0000000001a1'),
  ('00000000-0000-4000-8000-0000000003b1', '00000000-0000-4000-8000-0000000002b1', '2001', 'new_order', '00000000-0000-4000-8000-0000000001c2'),
  ('00000000-0000-4000-8000-0000000003b2', '00000000-0000-4000-8000-0000000002b1', '2002', 'new_order', '00000000-0000-4000-8000-0000000001c2');

insert into public.meeting_order_items (id, meeting_order_id, sku, product_name, created_by) values
  ('00000000-0000-4000-8000-0000000004a1', '00000000-0000-4000-8000-0000000003a1', 'SKU-A', 'Product A', '00000000-0000-4000-8000-0000000001a1'),
  ('00000000-0000-4000-8000-0000000004b1', '00000000-0000-4000-8000-0000000003b1', 'SKU-B', 'Product B', '00000000-0000-4000-8000-0000000001c2');

-- One task per user, created by that user, so linking is refused only by the guard.
insert into public.tasks (id, title, team, created_by, assigned_to)
select ('00000000-0000-4000-8000-000000000' || s || '')::uuid, 'Entry task ' || s, 'operations', u::uuid, u::uuid
from (values
  ('5a1', '00000000-0000-4000-8000-0000000001a1'),
  ('5b1', '00000000-0000-4000-8000-0000000001b1'),
  ('5b2', '00000000-0000-4000-8000-0000000001b2'),
  ('5c1', '00000000-0000-4000-8000-0000000001c1'),
  ('5c2', '00000000-0000-4000-8000-0000000001c2'),
  ('5c3', '00000000-0000-4000-8000-0000000001c3'),
  ('5c4', '00000000-0000-4000-8000-0000000001c4')
) as t(s, u);

-- One stored evidence object per user, under the order that user acts on, owned
-- by that user, so add_meeting_order_evidence is refused only by the guard.
insert into storage.objects (bucket_id, name, owner_id, metadata)
select 'meeting-evidence', o || '/00000000-0000-4000-8000-000000000' || s || '.jpg', u,
       '{"mimetype":"image/jpeg","size":2048}'::jsonb
from (values
  ('00000000-0000-4000-8000-0000000003a1', '6b1', '00000000-0000-4000-8000-0000000001b1'),
  ('00000000-0000-4000-8000-0000000003a1', '6c3', '00000000-0000-4000-8000-0000000001c3'),
  ('00000000-0000-4000-8000-0000000003a1', '6c4', '00000000-0000-4000-8000-0000000001c4'),
  ('00000000-0000-4000-8000-0000000003b1', '6a1', '00000000-0000-4000-8000-0000000001a1'),
  ('00000000-0000-4000-8000-0000000003b1', '6b2', '00000000-0000-4000-8000-0000000001b2'),
  ('00000000-0000-4000-8000-0000000003b1', '6c1', '00000000-0000-4000-8000-0000000001c1'),
  ('00000000-0000-4000-8000-0000000003b1', '6c2', '00000000-0000-4000-8000-0000000001c2')
) as e(o, s, u);

-- ─── The harness ─────────────────────────────────────────────────────────────

-- Run one statement as the current user, always roll it back, and judge it.
--   p_expect = 'refuse'          → exactly the module-entry refusal, 42501
--   p_expect = 'allow'           → no error
--   p_expect = 'error:<PREFIX>'  → an error whose message starts with <PREFIX>
create function pg_temp.try(p_label text, p_fn text, p_expect text, p_sql text)
returns void language plpgsql as $f$
declare
  v_msg   text;
  v_state text;
begin
  insert into covered values (p_fn);
  begin
    execute p_sql;
    raise exception 'ROLLBACK_SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
  end;

  if p_expect = 'refuse' then
    if v_msg is distinct from 'MEETING_FORBIDDEN: You do not have access to Meetings' or v_state <> '42501' then
      insert into failures values ('refusal', format('%s — %s: %s', p_label, p_fn,
        case when v_msg = 'ROLLBACK_SENTINEL' then 'SUCCEEDED (not refused)' else 'refused for another reason: ' || v_msg end));
    end if;
  elsif p_expect = 'allow' then
    if v_msg <> 'ROLLBACK_SENTINEL' then
      insert into failures values ('allow', format('%s — %s: failed: %s', p_label, p_fn, v_msg));
    end if;
  elsif p_expect like 'error:%' then
    if v_msg not like substr(p_expect, 7) || '%' then
      insert into failures values ('allow', format('%s — %s: expected %s, got %s', p_label, p_fn, substr(p_expect, 7),
        case when v_msg = 'ROLLBACK_SENTINEL' then 'success' else v_msg end));
    end if;
  else
    raise exception 'harness: unknown expectation %', p_expect;
  end if;
end $f$;

create function pg_temp.try_bool(p_label text, p_fn text, p_sql text, p_expected boolean)
returns void language plpgsql as $f$
declare v boolean;
begin
  insert into covered values (p_fn);
  execute p_sql into v;
  if v is distinct from p_expected then
    insert into failures values (case when p_expected then 'allow' else 'refusal' end,
      format('%s — %s: returned %s, expected %s', p_label, p_fn, v, p_expected));
  end if;
end $f$;

-- Every client-callable Meetings write path, as the CURRENT user.
--   'refuse' → each one must be the module-entry refusal
--   'allow'  → each one must succeed (the guard sanity checks expect their
--              ordinary refusals: a completed meeting, a missing meeting)
create function pg_temp.matrix(
  p_label text, p_mode text,
  p_meeting uuid, p_order uuid, p_order_empty uuid, p_item uuid,
  p_task uuid, p_evidence_path text, p_completed uuid
) returns void language plpgsql as $f$
begin
  perform pg_temp.try(p_label, 'assert_meeting_editor(uuid,boolean)', p_mode,
    format('select public.assert_meeting_editor(%L::uuid)', p_meeting));
  perform pg_temp.try(p_label, 'assert_meeting_editor(uuid,boolean)',
    case when p_mode = 'refuse' then 'refuse' else 'error:MEETING_COMPLETED:' end,
    format('select public.assert_meeting_editor(%L::uuid)', p_completed));
  perform pg_temp.try(p_label, 'assert_meeting_editor(uuid,boolean)',
    case when p_mode = 'refuse' then 'refuse' else 'error:MEETING_MISSING:' end,
    'select public.assert_meeting_editor(gen_random_uuid())');

  perform pg_temp.try_bool(p_label, 'can_edit_meeting(uuid,uuid,boolean)',
    format('select public.can_edit_meeting(%L::uuid)', p_meeting), p_mode = 'allow');
  perform pg_temp.try_bool(p_label, 'can_edit_meeting(uuid,uuid,boolean)',
    format('select public.can_edit_meeting(%L::uuid, auth.uid(), true)', p_completed), p_mode = 'allow');

  perform pg_temp.try(p_label, 'add_meeting_order(uuid,text,text,text,date,text)', p_mode,
    format('select public.add_meeting_order(%L::uuid, %L)', p_meeting, 'ENTRY-NEW-1'));
  perform pg_temp.try(p_label, 'save_meeting_order_update(uuid,text,text,date,text,text,date,boolean)', p_mode,
    format('select public.save_meeting_order_update(%L::uuid, %L)', p_order, 'entry update'));
  perform pg_temp.try(p_label, 'remove_meeting_order(uuid)', p_mode,
    format('select public.remove_meeting_order(%L::uuid)', p_order_empty));
  perform pg_temp.try(p_label, 'add_meeting_order_item(uuid,text,text,numeric,text,text,text,text,text,date,text,text,text)', p_mode,
    format('select public.add_meeting_order_item(%L::uuid, %L, %L)', p_order, 'SKU-NEW', 'New product'));
  perform pg_temp.try(p_label, 'save_meeting_item_update(uuid,text,text,date,text,text,text,boolean,boolean)', p_mode,
    format('select public.save_meeting_item_update(%L::uuid, %L)', p_item, 'entry item update'));
  perform pg_temp.try(p_label, 'link_meeting_item_task(uuid,uuid)', p_mode,
    format('select public.link_meeting_item_task(%L::uuid, %L::uuid)', p_item, p_task));
  perform pg_temp.try(p_label, 'set_meeting_item_image_path(uuid,text)', p_mode,
    format('select public.set_meeting_item_image_path(%L::uuid, %L)', p_item, p_order::text || '/entry-image.jpg'));
  perform pg_temp.try(p_label, 'add_meeting_order_evidence(uuid,text,text)', p_mode,
    format('select public.add_meeting_order_evidence(%L::uuid, %L, %L)', p_order, p_evidence_path, 'entry.jpg'));
  perform pg_temp.try(p_label, 'import_meeting_rows(uuid,jsonb)', p_mode,
    format('select public.import_meeting_rows(%L::uuid, %L::jsonb)', p_meeting,
      '[{"order_number":"ENTRY-IMP-1","sku":"SKU-IMP","product_name":"Imported"}]'));
  perform pg_temp.try(p_label, 'set_meeting_status(uuid,text)', p_mode,
    format('select public.set_meeting_status(%L::uuid, %L)', p_meeting, 'in_progress'));
  -- Reopening: assert_meeting_editor(p_allow_completed => true).
  perform pg_temp.try(p_label, 'set_meeting_status(uuid,text)', p_mode,
    format('select public.set_meeting_status(%L::uuid, %L)', p_completed, 'in_progress'));
end $f$;

grant execute on function pg_temp.try(text, text, text, text),
                          pg_temp.try_bool(text, text, text, boolean),
                          pg_temp.matrix(text, text, uuid, uuid, uuid, uuid, uuid, text, uuid)
  to authenticated;

-- ═══ 2. REFUSED — lead, view removed ════════════════════════════════════════
-- EXPECT: every call → 'MEETING_FORBIDDEN: You do not have access to Meetings'.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000001c1","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.matrix('2 lead, view removed', 'refuse',
  '00000000-0000-4000-8000-0000000002b1', '00000000-0000-4000-8000-0000000003b1', '00000000-0000-4000-8000-0000000003b2',
  '00000000-0000-4000-8000-0000000004b1', '00000000-0000-4000-8000-0000000005c1',
  '00000000-0000-4000-8000-0000000003b1/00000000-0000-4000-8000-0000000006c1.jpg',
  '00000000-0000-4000-8000-0000000002c1');
reset role;

-- ═══ 3. REFUSED — creator, view removed ═════════════════════════════════════
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000001c2","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.matrix('3 creator, view removed', 'refuse',
  '00000000-0000-4000-8000-0000000002b1', '00000000-0000-4000-8000-0000000003b1', '00000000-0000-4000-8000-0000000003b2',
  '00000000-0000-4000-8000-0000000004b1', '00000000-0000-4000-8000-0000000005c2',
  '00000000-0000-4000-8000-0000000003b1/00000000-0000-4000-8000-0000000006c2.jpg',
  '00000000-0000-4000-8000-0000000002c1');
reset role;

-- ═══ 4. REFUSED — edit holder, view removed ═════════════════════════════════
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000001c3","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.matrix('4 edit holder, view removed', 'refuse',
  '00000000-0000-4000-8000-0000000002a1', '00000000-0000-4000-8000-0000000003a1', '00000000-0000-4000-8000-0000000003a2',
  '00000000-0000-4000-8000-0000000004a1', '00000000-0000-4000-8000-0000000005c3',
  '00000000-0000-4000-8000-0000000003a1/00000000-0000-4000-8000-0000000006c3.jpg',
  '00000000-0000-4000-8000-0000000002c1');
reset role;

-- ═══ 5. REFUSED — manage holder, view removed ═══════════════════════════════
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000001c4","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.matrix('5 manage holder, view removed', 'refuse',
  '00000000-0000-4000-8000-0000000002a1', '00000000-0000-4000-8000-0000000003a1', '00000000-0000-4000-8000-0000000003a2',
  '00000000-0000-4000-8000-0000000004a1', '00000000-0000-4000-8000-0000000005c4',
  '00000000-0000-4000-8000-0000000003a1/00000000-0000-4000-8000-0000000006c4.jpg',
  '00000000-0000-4000-8000-0000000002c1');

-- ═══ 6. Refused users read nothing (unchanged by this migration) ════════════
-- EXPECT: the manage holder sees no meeting, order, item or history row.
do $$
begin
  if (select count(*) from public.meetings) + (select count(*) from public.meeting_orders)
     + (select count(*) from public.meeting_order_items) + (select count(*) from public.meeting_update_history) <> 0 then
    insert into failures values ('refusal', '6 manage holder, view removed — can still read meeting rows');
  end if;
end $$;
reset role;

-- ═══ 7. ALLOWED — lead with view ════════════════════════════════════════════
-- EXPECT: every call succeeds; the guard's own ordering is unchanged for an
--         entitled user (completed → MEETING_COMPLETED, missing → MEETING_MISSING).
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000001b1","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.matrix('7 lead with view', 'allow',
  '00000000-0000-4000-8000-0000000002a1', '00000000-0000-4000-8000-0000000003a1', '00000000-0000-4000-8000-0000000003a2',
  '00000000-0000-4000-8000-0000000004a1', '00000000-0000-4000-8000-0000000005b1',
  '00000000-0000-4000-8000-0000000003a1/00000000-0000-4000-8000-0000000006b1.jpg',
  '00000000-0000-4000-8000-0000000002c2');
reset role;

-- ═══ 8. ALLOWED — edit holder with view (not lead, not creator) ═════════════
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000001b2","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.matrix('8 edit holder with view', 'allow',
  '00000000-0000-4000-8000-0000000002b1', '00000000-0000-4000-8000-0000000003b1', '00000000-0000-4000-8000-0000000003b2',
  '00000000-0000-4000-8000-0000000004b1', '00000000-0000-4000-8000-0000000005b2',
  '00000000-0000-4000-8000-0000000003b1/00000000-0000-4000-8000-0000000006b2.jpg',
  '00000000-0000-4000-8000-0000000002c1');
reset role;

-- ═══ 9. ALLOWED — admin ═════════════════════════════════════════════════════
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000001a1","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.matrix('9 admin', 'allow',
  '00000000-0000-4000-8000-0000000002b1', '00000000-0000-4000-8000-0000000003b1', '00000000-0000-4000-8000-0000000003b2',
  '00000000-0000-4000-8000-0000000004b1', '00000000-0000-4000-8000-0000000005a1',
  '00000000-0000-4000-8000-0000000003b1/00000000-0000-4000-8000-0000000006a1.jpg',
  '00000000-0000-4000-8000-0000000002c1');
reset role;

-- ═══ 10. ALLOWED — the section 2 lead once view is given back ═══════════════
-- EXPECT: the same calls that refused in section 2 now succeed — the refusal
--         was module entry and nothing else.
update public.employee_permission_overrides o
   set allowed = true
  from public.permission_modules pm, public.permission_actions pa
 where o.user_id = '00000000-0000-4000-8000-0000000001c1'
   and pm.id = o.module_id and pm.module_key = 'meetings'
   and pa.id = o.action_id and pa.action_key = 'view';
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000001c1","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.matrix('10 lead, view given back', 'allow',
  '00000000-0000-4000-8000-0000000002b1', '00000000-0000-4000-8000-0000000003b1', '00000000-0000-4000-8000-0000000003b2',
  '00000000-0000-4000-8000-0000000004b1', '00000000-0000-4000-8000-0000000005c1',
  '00000000-0000-4000-8000-0000000003b1/00000000-0000-4000-8000-0000000006c1.jpg',
  '00000000-0000-4000-8000-0000000002c1');
reset role;

-- ═══ 11. A real write by the lead, kept, and readable back ══════════════════
-- EXPECT: the order and its 'order_added' history row exist and the lead reads both.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000001b1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_order public.meeting_orders;
begin
  v_order := public.add_meeting_order('00000000-0000-4000-8000-0000000002a1', 'ENTRY-REAL-1');
  if (select count(*) from public.meeting_orders where id = v_order.id) <> 1
     or (select count(*) from public.meeting_update_history
         where meeting_order_id = v_order.id and entry_type = 'order_added') <> 1 then
    insert into failures values ('allow', '11 lead with view — a real add_meeting_order was not readable with its history');
  end if;
end $$;
reset role;

-- ═══ 12. Coverage ═══════════════════════════════════════════════════════════
-- EXPECT: nothing an authenticated user can execute that authorizes through
--         assert_meeting_editor (or is can_edit_meeting) went unexercised.
--
-- Read from the catalogue, so a new caller fails this until it is added to
-- pg_temp.matrix. The order-discussion RPCs (20261213000000, PR #164) also call
-- assert_meeting_editor; their module-entry refusals are asserted by their own
-- suite, meeting_discussion_workflow_assertions.sql, so they are left to it.
do $$
declare v_missing text;
begin
  select string_agg(f, ', ' order by f) into v_missing
  from (
    select replace(p.oid::regprocedure::text, 'public.', '') as f
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and p.prorettype <> 'trigger'::regtype
      and p.proname not like '%meeting_discussion%'
      and (pg_get_functiondef(p.oid) like '%assert_meeting_editor(%' or p.proname = 'can_edit_meeting')
  ) fns
  where f not in (select fn from covered);
  if v_missing is not null then
    insert into failures values ('coverage', '12 not exercised: ' || v_missing);
  else
    raise notice 'PASS 12 coverage: % authorizing functions exercised as every user',
      (select count(distinct fn) from covered);
  end if;
end $$;

-- ═══ 13. Verdict ════════════════════════════════════════════════════════════
do $$
declare
  v_refusal int := (select count(*) from failures where kind = 'refusal');
  v_allow   int := (select count(*) from failures where kind = 'allow');
  v_other   int := (select count(*) from failures where kind not in ('refusal', 'allow'));
  r record;
begin
  raise notice 'SUMMARY refusal_failures=% allow_failures=% other_failures=%', v_refusal, v_allow, v_other;
  for r in select kind, detail from failures order by kind, detail loop
    raise notice 'FAILURE [%] %', r.kind, r.detail;
  end loop;
  if v_refusal + v_allow + v_other > 0 then
    raise exception 'ASSERT: % refusal, % allow, % other failure(s)', v_refusal, v_allow, v_other;
  end if;
  raise notice 'PASS 2-5  lead / creator / edit / manage with view removed: every RPC refused for module entry';
  raise notice 'PASS 6    a refused user still reads nothing';
  raise notice 'PASS 7-10 lead, edit holder, admin, and the lead with view restored: every RPC works';
  raise notice 'PASS 11   a real write by the lead is kept with its history';
  raise notice 'ALL ASSERTIONS PASSED';
end $$;

rollback;
