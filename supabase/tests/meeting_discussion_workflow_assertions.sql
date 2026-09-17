-- ═════════════════════════════════════════════════════════════════════════════
-- TEST-ONLY — behavioural assertions for 20261213000000 (Meetings order discussion)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THIS FILE MUST NEVER ENTER supabase/migrations, AND MUST NEVER RUN ON PRODUCTION.
-- Run it only through supabase/tests/run_meeting_discussion_workflow_local.sh,
-- which refuses any database not marked disposable and empty.
--
-- ONE TRANSACTION, ROLLED BACK. Every scenario acts as a real user: the JWT claim
-- makes auth.uid() that user, and `set local role authenticated` puts every read
-- and write through the same RLS policies, grants and SECURITY DEFINER guards the
-- browser meets. Fixture rows (users, tasks, attendees, one storage object) are
-- written as postgres, because in production they arrive through paths this
-- migration does not own.
--
-- Every refusal is asserted by its MESSAGE PREFIX, not merely by "it raised", so a
-- refusal for the wrong reason fails the suite.
--
-- Numbered sections, each stating the expected result first:
--
--   1  capture from a task with no meeting → Meeting Inbox
--   2  duplicate capture from the same task → the same issue, never a second
--   3  both categories; the tag and category rules
--   4  source-task isolation (capture predicate AND the tasks SELECT policy)
--   5  Inbox matching: back-dated meeting takes nothing
--   6  Inbox matching: New Order takes Running Order only; Repair takes After Sales only
--   7  carry-forward re-run adds nothing
--   8  manual cross-type placement is refused on every path
--   9  a second independent issue on the same order
--  10  view-only user: reads, cannot write, cannot resolve, cannot reopen
--  11  editor update; general order history untouched
--  12  completing a meeting resolves nothing, and locks the meeting
--  13  next meeting inherits open issues once, from the right source, M1 unchanged
--  14  retrying creation / carry-forward / a direct duplicate insert
--  15  resolve: note required, actor + time + trail, stops carry-forward
--  16  reopen from a completed meeting: reason required, original resolution kept,
--      completed meeting rows unchanged
--  17  the reopened issue returns in the next meeting, once
--  18  two issues on one order keep separate threads
--  19  an Inbox item attached by hand is placed once
--  20  evidence: lazy order folder, verified object, tagged to the issue
--  21  visibility of issues: attendee, creator, editor, outsider
--  22  deleting an empty draft that only inherited issues
--  23  meeting notes follow the meeting: updates, resolution, reopening reason,
--      evidence, and the resolution_note column
--  24  a meetings 'edit' grant alone sees Inbox issues only
--  25  the authoritative Inbox read; a repeat capture never names a hidden meeting
--  26  a user without Meetings access: refused, and reads nothing
--  27  real follow-up task linking: once, refused for a task the caller cannot hold
--  28  clearing a decision needs the explicit flag
--  29  deleting a draft: every kind of substantive activity refuses; untouched
--      automatic appearances do not
--  30  no Meetings access: every callable function (enumerated from the
--      catalogue) refuses a lead and an edit holder alike, and nothing is readable

\set ON_ERROR_STOP on

begin;
set local lock_timeout = '3s';

-- ─── Fixtures (as postgres) ──────────────────────────────────────────────────

create temp table ctx (k text primary key, v uuid) on commit drop;
grant all on ctx to authenticated;

-- A admin · E manager (conducts) · V member attendee (view only)
-- S member (sales, raises tasks) · O member outsider
insert into public.users (id, full_name, role, team, is_active, created_at, updated_at) values
  ('00000000-0000-4000-8000-0000000000a1', 'Admin Fixture',   'admin',   'management', true, now(), now()),
  ('00000000-0000-4000-8000-0000000000e1', 'Editor Fixture',  'manager', 'management', true, now(), now()),
  ('00000000-0000-4000-8000-0000000000f1', 'Viewer Fixture',  'member',  'operations', true, now(), now()),
  ('00000000-0000-4000-8000-0000000000c1', 'Sales Fixture',   'member',  'sales',      true, now(), now()),
  ('00000000-0000-4000-8000-0000000000d1', 'Outsider Fixture','member',  'design',     true, now(), now()),
  ('00000000-0000-4000-8000-0000000000b1', 'Edit-only Fixture','member', 'operations', true, now(), now()),
  ('00000000-0000-4000-8000-0000000000b2', 'No-access Fixture','member', 'operations', true, now(), now());

-- X (b1) holds Meetings 'edit' but not 'manage', and attends nothing.
-- N (b2) has Meetings 'view' taken away: no module entry at all. The member role
-- default grants 'view' on this chain, so the override is what removes it.
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select u.id, pm.id, pa.id, u.allowed, '00000000-0000-4000-8000-0000000000a1'
from (values
  ('00000000-0000-4000-8000-0000000000b1'::uuid, 'edit', true),
  ('00000000-0000-4000-8000-0000000000b2'::uuid, 'view', false)
) as u(id, action_key, allowed)
join public.permission_modules pm on pm.module_key = 'meetings'
join public.permission_actions pa on pa.action_key = u.action_key;

do $$
begin
  if not public.resolve_permission('00000000-0000-4000-8000-0000000000b1', 'meetings', 'edit')
     or public.resolve_permission('00000000-0000-4000-8000-0000000000b1', 'meetings', 'manage')
     or public.resolve_permission('00000000-0000-4000-8000-0000000000b2', 'meetings', 'view') then
    raise exception 'FIXTURE: the edit-only / no-access permission overrides did not take effect';
  end if;
end $$;

-- T1, T2: raised by Sales, assigned to the Editor. T3: the Outsider's own task.
insert into public.tasks (id, title, note, team, created_by, assigned_to) values
  ('00000000-0000-4000-8000-00000000a001', 'Order 2041 fabric approval pending', 'Order: 2041\nCustomer: Blue Lagoon',
   'sales', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000e1'),
  ('00000000-0000-4000-8000-00000000a002', 'Order 3310 repair required at site', 'Order: 3310',
   'sales', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000e1'),
  ('00000000-0000-4000-8000-00000000a003', 'Outsider private task', null,
   'design', '00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000d1');

-- ═══ 1. Capture from a task, no meeting exists → Inbox ══════════════════════
-- EXPECT: status 'created', in_inbox true, no appearance, source task kept, one
--         'captured' event.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;

do $$
declare r jsonb; v_id uuid; v_task uuid; v_state text; v_key text;
begin
  r := public.capture_meeting_discussion_item('running_order', '2041', 'Fabric approval pending',
         null, 'Blue Lagoon', null, null, '00000000-0000-4000-8000-00000000a001');
  if r->>'status' <> 'created' then raise exception 'ASSERT 1: status %', r->>'status'; end if;
  if (r->>'in_inbox')::boolean is not true or (r->>'on_agenda')::boolean then raise exception 'ASSERT 1: not in inbox'; end if;
  if r->>'appearance_id' is not null then raise exception 'ASSERT 1: has an appearance'; end if;
  -- Named columns: resolution_note is not selectable by a client role, so `select *` is refused.
  select id, source_task_id, state, order_number_key into v_id, v_task, v_state, v_key
  from public.meeting_discussion_items where id = (r->>'item_id')::uuid;
  if v_id is null then raise exception 'ASSERT 1: the creator cannot read the issue'; end if;
  if v_task <> '00000000-0000-4000-8000-00000000a001' then raise exception 'ASSERT 1: source task lost'; end if;
  if v_state <> 'open' or v_key <> '2041' then raise exception 'ASSERT 1: state/key'; end if;
  if (select count(*) from public.meeting_discussion_events where discussion_item_id = v_id and event_type = 'captured') <> 1 then
    raise exception 'ASSERT 1: captured event count';
  end if;
  insert into ctx values ('run1', v_id);
  raise notice 'PASS 1  capture with no meeting lands in the Meeting Inbox, source task kept';
end $$;

-- ═══ 2. Same task again → the same issue ════════════════════════════════════
-- EXPECT: status 'existing', same item id, exactly one open issue for T1.
do $$
declare r jsonb;
begin
  r := public.capture_meeting_discussion_item('running_order', '2041', 'Fabric approval pending (again)',
         null, null, null, null, '00000000-0000-4000-8000-00000000a001');
  if r->>'status' <> 'existing' then raise exception 'ASSERT 2: status %', r->>'status'; end if;
  if (r->>'item_id')::uuid <> (select v from ctx where k = 'run1') then raise exception 'ASSERT 2: different item'; end if;
  if (select count(*) from public.meeting_discussion_items where source_task_id = '00000000-0000-4000-8000-00000000a001') <> 1 then
    raise exception 'ASSERT 2: a second issue was created';
  end if;
  raise notice 'PASS 2  repeating Add to Meeting returns the existing issue; no duplicate';
end $$;

-- ═══ 3. Categories and tags ═════════════════════════════════════════════════
-- EXPECT: After Sales + tag accepted; tag on Running Order refused; unknown
--         category refused.
do $$
declare r jsonb; v_msg text;
begin
  r := public.capture_meeting_discussion_item('after_sales', '3310', 'Repair required at site',
         null, null, 'repair', null, '00000000-0000-4000-8000-00000000a002');
  if r->>'category' <> 'after_sales' or (r->>'in_inbox')::boolean is not true then raise exception 'ASSERT 3: after sales capture'; end if;
  if (select after_sales_tag from public.meeting_discussion_items where id = (r->>'item_id')::uuid) <> 'repair' then
    raise exception 'ASSERT 3: tag not kept';
  end if;
  insert into ctx values ('as1', (r->>'item_id')::uuid);

  begin
    perform public.capture_meeting_discussion_item('running_order', '2041', 'x', null, null, 'repair', null, null);
    raise exception 'ASSERT 3: tag on running order accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'ASSERT%' then raise; end if;
    if v_msg not like 'MEETING_DISCUSSION_TAG_INVALID:%' then raise exception 'ASSERT 3: wrong refusal %', v_msg; end if;
  end;

  begin
    perform public.capture_meeting_discussion_item('repair', '2041', 'x', null, null, null, null, null);
    raise exception 'ASSERT 3: unknown category accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'ASSERT%' then raise; end if;
    if v_msg not like 'MEETING_DISCUSSION_CATEGORY_INVALID:%' then raise exception 'ASSERT 3: wrong refusal %', v_msg; end if;
  end;
  raise notice 'PASS 3  two categories only; an after-sales tag is refused on a running-order issue';
end $$;

-- ═══ 4. Source-task isolation ═══════════════════════════════════════════════
-- EXPECT: the Editor cannot capture from a task they neither created nor hold.
do $$
declare v_msg text;
begin
  begin
    perform public.capture_meeting_discussion_item('running_order', '9999', 'fishing', null, null, null, null,
      '00000000-0000-4000-8000-00000000a003');
    raise exception 'ASSERT 4: captured a task the caller cannot see';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'ASSERT%' then raise; end if;
    if v_msg not like 'MEETING_TASK_NOT_LINKABLE:%' then raise exception 'ASSERT 4: wrong refusal %', v_msg; end if;
  end;
end $$;

reset role;
-- SANITY CHECK OF THE TASKS STUB, not of this migration (which adds no tasks
-- policy): the Viewer, who will attend the meeting that shows T1's issue, cannot
-- read T1 under production's tasks SELECT policy as 007 reproduces it.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from public.tasks where id = '00000000-0000-4000-8000-00000000a001') <> 0 then
    raise exception 'ASSERT 4: a meeting viewer can read the source task';
  end if;
  raise notice 'PASS 4  a caller cannot attach a task they may not read; a meeting viewer cannot read the source task';
end $$;
reset role;

-- ═══ 5. Back-dated meeting takes nothing from the Inbox ════════════════════
-- EXPECT: a New Order review dated YESTERDAY (IST) receives 0 items; the
--         running-order issue stays in the Inbox.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_id uuid;
begin
  insert into public.meetings (meeting_type, meeting_date, title, lead_id, created_by)
  values ('new_order', (now() at time zone 'Asia/Kolkata')::date - 1, 'Back-dated review',
          '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000e1')
  returning id into v_id;
  if (select count(*) from public.meeting_discussion_appearances where meeting_id = v_id) <> 0 then
    raise exception 'ASSERT 5: a back-dated meeting received an issue raised after it';
  end if;
  if exists (select 1 from public.meeting_discussion_appearances where discussion_item_id = (select v from ctx where k = 'run1')) then
    raise exception 'ASSERT 5: the issue left the Inbox';
  end if;
  insert into ctx values ('mback', v_id);
  raise notice 'PASS 5  an issue is never written into a meeting dated before it was raised';
end $$;

-- ═══ 6. Inbox matching by review type ═══════════════════════════════════════
-- EXPECT: New Order M1 (today) gets the Running Order issue, NOT the After Sales
--         one. Repair Order R1 (today) gets the After Sales issue, NOT the
--         Running Order one. Each with one 'added_to_agenda' event.
do $$
declare v_m1 uuid; v_r1 uuid;
begin
  insert into public.meetings (meeting_type, meeting_date, title, lead_id, created_by)
  values ('new_order', (now() at time zone 'Asia/Kolkata')::date, 'M1 New Order',
          '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000e1')
  returning id into v_m1;
  insert into public.meetings (meeting_type, meeting_date, title, lead_id, created_by)
  values ('repair_order', (now() at time zone 'Asia/Kolkata')::date, 'R1 Repair',
          '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000e1')
  returning id into v_r1;

  if (select count(*) from public.meeting_discussion_appearances where meeting_id = v_m1) <> 1
     or not exists (select 1 from public.meeting_discussion_appearances
                    where meeting_id = v_m1 and discussion_item_id = (select v from ctx where k = 'run1')) then
    raise exception 'ASSERT 6: New Order review did not take exactly the running-order issue';
  end if;
  if exists (select 1 from public.meeting_discussion_appearances
             where meeting_id = v_m1 and discussion_item_id = (select v from ctx where k = 'as1')) then
    raise exception 'ASSERT 6: an After Sales issue entered a New Order review';
  end if;
  if (select count(*) from public.meeting_discussion_appearances where meeting_id = v_r1) <> 1
     or not exists (select 1 from public.meeting_discussion_appearances
                    where meeting_id = v_r1 and discussion_item_id = (select v from ctx where k = 'as1')) then
    raise exception 'ASSERT 6: Repair review did not take exactly the after-sales issue';
  end if;
  if exists (select 1 from public.meeting_discussion_appearances
             where meeting_id = v_r1 and discussion_item_id = (select v from ctx where k = 'run1')) then
    raise exception 'ASSERT 6: a Running Order issue entered a Repair review';
  end if;
  if (select count(*) from public.meeting_discussion_events
      where discussion_item_id = (select v from ctx where k = 'run1') and event_type = 'added_to_agenda') <> 1 then
    raise exception 'ASSERT 6: added_to_agenda count';
  end if;
  insert into ctx values ('m1', v_m1), ('r1', v_r1),
    ('a_m1_run1', (select id from public.meeting_discussion_appearances where meeting_id = v_m1));
  raise notice 'PASS 6  Inbox items enter only a review of their own type';
end $$;

-- ═══ 6b. A repeat capture reports where the existing issue really is ════════
-- EXPECT: the same task again, with no target, now that its issue is on M1:
--         status 'existing', in_inbox FALSE, meeting_id = M1, and no new row.
do $$
declare r jsonb;
begin
  r := public.capture_meeting_discussion_item('running_order', '2041', 'Fabric approval pending',
         null, null, null, null, '00000000-0000-4000-8000-00000000a001');
  if r->>'status' <> 'existing' then raise exception 'ASSERT 6b: status %', r->>'status'; end if;
  if (r->>'in_inbox')::boolean then raise exception 'ASSERT 6b: an issue on an agenda was reported as in the Inbox'; end if;
  if (r->>'meeting_id')::uuid is distinct from (select v from ctx where k = 'm1') then
    raise exception 'ASSERT 6b: reported meeting %', r->>'meeting_id';
  end if;
  if (select count(*) from public.meeting_discussion_appearances where discussion_item_id = (select v from ctx where k = 'run1')) <> 1 then
    raise exception 'ASSERT 6b: a repeat capture placed the issue again';
  end if;
  raise notice 'PASS 6b a repeat capture names the agenda the existing issue is on, and adds nothing';
end $$;

-- ═══ 7. Re-running carry-forward adds nothing ═══════════════════════════════
do $$
declare n int;
begin
  n := public.carry_forward_meeting_discussions((select v from ctx where k = 'm1'));
  if n <> 0 then raise exception 'ASSERT 7: re-run added %', n; end if;
  n := public.carry_forward_meeting_discussions((select v from ctx where k = 'r1'));
  if n <> 0 then raise exception 'ASSERT 7: re-run added % to R1', n; end if;
  raise notice 'PASS 7  carry-forward re-run on the same meeting adds 0';
end $$;

-- ═══ 8. Manual cross-type placement refused on every path ═══════════════════
do $$
declare v_msg text;
begin
  begin
    perform public.attach_meeting_discussion_item((select v from ctx where k = 'm1'), (select v from ctx where k = 'as1'));
    raise exception 'ASSERT 8: after sales attached to New Order';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'ASSERT%' then raise; end if;
    if v_msg not like 'MEETING_DISCUSSION_CATEGORY_MISMATCH:%' then raise exception 'ASSERT 8: wrong refusal %', v_msg; end if;
  end;
  begin
    perform public.attach_meeting_discussion_item((select v from ctx where k = 'r1'), (select v from ctx where k = 'run1'));
    raise exception 'ASSERT 8: running order attached to Repair';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'ASSERT%' then raise; end if;
    if v_msg not like 'MEETING_DISCUSSION_CATEGORY_MISMATCH:%' then raise exception 'ASSERT 8: wrong refusal %', v_msg; end if;
  end;
  begin
    perform public.capture_meeting_discussion_item('after_sales', '4400', 'mis-typed', (select v from ctx where k = 'm1'),
      null, null, null, null);
    raise exception 'ASSERT 8: capture placed after sales on New Order';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'ASSERT%' then raise; end if;
    if v_msg not like 'MEETING_DISCUSSION_CATEGORY_MISMATCH:%' then raise exception 'ASSERT 8: wrong refusal %', v_msg; end if;
  end;
  -- The refused capture rolled back as a whole: no orphan issue was left behind.
  if exists (select 1 from public.meeting_discussion_items where order_number = '4400') then
    raise exception 'ASSERT 8: a refused capture left an issue behind';
  end if;
  raise notice 'PASS 8  attach and capture-with-target both refuse the wrong review type; nothing is left behind';
end $$;

-- ═══ 9. A second independent issue on the same order ════════════════════════
do $$
declare r jsonb;
begin
  r := public.capture_meeting_discussion_item('running_order', ' 2041 ', 'Production delay on chairs',
         (select v from ctx where k = 'm1'), 'Blue Lagoon', null, null, null);
  if r->>'status' <> 'created' or r->>'appearance_id' is null then raise exception 'ASSERT 9: not placed'; end if;
  if (r->>'item_id')::uuid = (select v from ctx where k = 'run1') then raise exception 'ASSERT 9: merged with the other issue'; end if;
  if (select count(distinct id) from public.meeting_discussion_items where order_number_key = '2041') <> 2 then
    raise exception 'ASSERT 9: expected two issues on order 2041';
  end if;
  insert into ctx values ('run2', (r->>'item_id')::uuid), ('a_m1_run2', (r->>'appearance_id')::uuid);
  raise notice 'PASS 9  two independent issues on one order are two items';
end $$;
reset role;

-- The Viewer attends M1.
insert into public.meeting_attendees (meeting_id, user_id)
select v, '00000000-0000-4000-8000-0000000000f1' from ctx where k = 'm1';

-- ═══ 10. View-only user ═════════════════════════════════════════════════════
-- EXPECT: reads M1's two appearances; update, resolve, reopen and attach refused.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_msg text;
begin
  if (select count(*) from public.meeting_discussion_appearances where meeting_id = (select v from ctx where k = 'm1')) <> 2 then
    raise exception 'ASSERT 10: attendee cannot read the agenda';
  end if;
  begin
    perform public.save_meeting_discussion_update((select v from ctx where k = 'a_m1_run1'), 'viewer typing', null, null, false);
    raise exception 'ASSERT 10: viewer recorded an update';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'ASSERT%' then raise; end if;
    if v_msg not like 'MEETING_FORBIDDEN:%' then raise exception 'ASSERT 10: wrong refusal %', v_msg; end if;
  end;
  begin
    perform public.resolve_meeting_discussion_item((select v from ctx where k = 'a_m1_run1'), 'viewer resolving');
    raise exception 'ASSERT 10: viewer resolved';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'ASSERT%' then raise; end if;
    if v_msg not like 'MEETING_FORBIDDEN:%' then raise exception 'ASSERT 10: wrong refusal %', v_msg; end if;
  end;
  begin
    perform public.reopen_meeting_discussion_item((select v from ctx where k = 'run1'), 'viewer reopening');
    raise exception 'ASSERT 10: viewer reopened';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'ASSERT%' then raise; end if;
    if v_msg not like 'MEETING_FORBIDDEN:%' then raise exception 'ASSERT 10: wrong refusal %', v_msg; end if;
  end;
  begin
    insert into public.meeting_discussion_appearances (meeting_id, discussion_item_id, agenda_position, created_by)
    values ((select v from ctx where k = 'm1'), (select v from ctx where k = 'as1'), 9, auth.uid());
    raise exception 'ASSERT 10: viewer wrote a table directly';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'ASSERT%' then raise; end if;
    if v_msg not like 'permission denied%' then raise exception 'ASSERT 10: wrong refusal %', v_msg; end if;
  end;
  raise notice 'PASS 10 a view-only attendee reads the agenda and cannot update, resolve, reopen or write';
end $$;
reset role;

-- ═══ 11. Editor records an update; general order history is not touched ═════
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_before int; a public.meeting_discussion_appearances;
begin
  v_before := (select count(*) from public.meeting_update_history);
  a := public.save_meeting_discussion_update((select v from ctx where k = 'a_m1_run1'),
         'Issue recorded. Action pending.', 'Chase the fabric vendor', null, false);
  if a.discussed_at is null or a.discussed_by <> '00000000-0000-4000-8000-0000000000e1' then raise exception 'ASSERT 11: not marked discussed'; end if;
  if a.latest_update <> 'Issue recorded. Action pending.' then raise exception 'ASSERT 11: update not kept'; end if;
  if (select count(*) from public.meeting_discussion_events where appearance_id = a.id and event_type = 'update') <> 1 then
    raise exception 'ASSERT 11: update event';
  end if;
  if (select count(*) from public.meeting_update_history) <> v_before then
    raise exception 'ASSERT 11: an issue update wrote into the general order history';
  end if;
  -- A save that moves nothing writes nothing.
  perform public.save_meeting_discussion_update(a.id, null, null, null, false);
  if (select count(*) from public.meeting_discussion_events where appearance_id = a.id and event_type = 'update') <> 1 then
    raise exception 'ASSERT 11: an empty save wrote a trail row';
  end if;
  raise notice 'PASS 11 an editor update is recorded on the issue only; an empty save writes nothing';
end $$;

-- ═══ 12. Completing a meeting resolves nothing, and locks it ════════════════
do $$
declare v_msg text;
begin
  perform public.set_meeting_status((select v from ctx where k = 'm1'), 'completed');
  if exists (select 1 from public.meeting_discussion_items
             where id in ((select v from ctx where k = 'run1'), (select v from ctx where k = 'run2')) and state <> 'open') then
    raise exception 'ASSERT 12: completing the meeting resolved an issue';
  end if;
  begin
    perform public.save_meeting_discussion_update((select v from ctx where k = 'a_m1_run1'), 'late edit', null, null, false);
    raise exception 'ASSERT 12: updated a completed meeting';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'ASSERT%' then raise; end if;
    if v_msg not like 'MEETING_COMPLETED:%' then raise exception 'ASSERT 12: wrong refusal %', v_msg; end if;
  end;
  begin
    perform public.resolve_meeting_discussion_item((select v from ctx where k = 'a_m1_run1'), 'late resolve');
    raise exception 'ASSERT 12: resolved in a completed meeting';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'ASSERT%' then raise; end if;
    if v_msg not like 'MEETING_COMPLETED:%' then raise exception 'ASSERT 12: wrong refusal %', v_msg; end if;
  end;
  begin
    perform public.ensure_meeting_discussion_order((select v from ctx where k = 'a_m1_run1'));
    raise exception 'ASSERT 12: evidence folder created in a completed meeting';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'ASSERT%' then raise; end if;
    if v_msg not like 'MEETING_COMPLETED:%' then raise exception 'ASSERT 12: wrong refusal %', v_msg; end if;
  end;
  raise notice 'PASS 12 completing a meeting leaves its issues Open and makes it read-only';
end $$;
reset role;

-- Snapshot M1's appearances as they stand at completion.
create temp table m1_snapshot on commit drop as
  select id, md5(row(a.*)::text) as h from public.meeting_discussion_appearances a
  where meeting_id = (select v from ctx where k = 'm1');

-- ═══ 13. The next meeting inherits open issues once ═════════════════════════
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_m2 uuid; a public.meeting_discussion_appearances;
begin
  insert into public.meetings (meeting_type, meeting_date, title, lead_id, created_by)
  values ('new_order', (now() at time zone 'Asia/Kolkata')::date + 1, 'M2 New Order',
          '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000e1')
  returning id into v_m2;

  if (select count(*) from public.meeting_discussion_appearances where meeting_id = v_m2) <> 2 then
    raise exception 'ASSERT 13: expected both open issues in M2';
  end if;
  select * into a from public.meeting_discussion_appearances
  where meeting_id = v_m2 and discussion_item_id = (select v from ctx where k = 'run1');
  if a.carried_from_id is distinct from (select v from ctx where k = 'a_m1_run1') then
    raise exception 'ASSERT 13: carried from the wrong appearance';
  end if;
  if a.latest_update is not null or a.decision is not null or a.discussed_at is not null then
    raise exception 'ASSERT 13: an earlier update was copied forward';
  end if;
  if (select count(*) from public.meeting_discussion_events where appearance_id = a.id and event_type = 'carried_forward') <> 1 then
    raise exception 'ASSERT 13: carried_forward event';
  end if;
  if (select status from public.meetings where id = (select v from ctx where k = 'm1')) <> 'completed' then
    raise exception 'ASSERT 13: carry-forward touched the completed meeting';
  end if;
  insert into ctx values ('m2', v_m2), ('a_m2_run1', a.id),
    ('a_m2_run2', (select id from public.meeting_discussion_appearances
                   where meeting_id = v_m2 and discussion_item_id = (select v from ctx where k = 'run2')));
  raise notice 'PASS 13 an open issue moves to the next meeting once, empty, with the same identity';
end $$;
reset role;

do $$
begin
  -- Not vacuous: M1 held both issues when it completed.
  if (select count(*) from m1_snapshot) <> 2 then
    raise exception 'ASSERT 13: the M1 snapshot holds % rows, so the comparison below would prove nothing', (select count(*) from m1_snapshot);
  end if;
  if exists (
    select 1 from m1_snapshot s
    left join public.meeting_discussion_appearances a on a.id = s.id
    where a.id is null or md5(row(a.*)::text) <> s.h
  ) then
    raise exception 'ASSERT 13: a completed meeting''s agenda changed when the next meeting was created';
  end if;
end $$;

-- ═══ 14. Retries ════════════════════════════════════════════════════════════
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n int; v_twin uuid; v_msg text;
begin
  -- Carry-forward run again on M2: nothing.
  n := public.carry_forward_meeting_discussions((select v from ctx where k = 'm2'));
  if n <> 0 then raise exception 'ASSERT 14: re-run added %', n; end if;

  -- A retried meeting creation (the same review submitted twice) is a second
  -- MEETING. Each carries each issue at most once.
  insert into public.meetings (meeting_type, meeting_date, title, lead_id, created_by)
  values ('new_order', (now() at time zone 'Asia/Kolkata')::date + 1, 'M2 New Order',
          '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000e1')
  returning id into v_twin;
  -- The twin inherited the same open issues as M2 — no more, no fewer — each once.
  if (select count(*) from public.meeting_discussion_appearances where meeting_id = v_twin) = 0 then
    raise exception 'ASSERT 14: the retried meeting inherited nothing, so this proves nothing';
  end if;
  if exists (
    (select discussion_item_id from public.meeting_discussion_appearances where meeting_id = v_twin
     except all
     select discussion_item_id from public.meeting_discussion_appearances where meeting_id = (select v from ctx where k = 'm2'))
    union all
    (select discussion_item_id from public.meeting_discussion_appearances where meeting_id = (select v from ctx where k = 'm2')
     except all
     select discussion_item_id from public.meeting_discussion_appearances where meeting_id = v_twin)
  ) then
    raise exception 'ASSERT 14: the retried meeting did not inherit exactly M2''s issues, once each';
  end if;
  if exists (select 1 from public.meeting_discussion_appearances where meeting_id = v_twin and placement <> 'automatic') then
    raise exception 'ASSERT 14: an inherited appearance is not marked automatic';
  end if;
  insert into ctx values ('m2twin', v_twin);

  -- And a direct second placement is refused by the constraint, not by habit.
  reset role;
  begin
    insert into public.meeting_discussion_appearances (meeting_id, discussion_item_id, agenda_position, created_by)
    values ((select v from ctx where k = 'm2'), (select v from ctx where k = 'run1'), 99,
            '00000000-0000-4000-8000-0000000000e1');
    raise exception 'ASSERT 14: a duplicate appearance was stored';
  exception when unique_violation then null;
  end;
  raise notice 'PASS 14 re-running carry-forward, retrying creation and a direct duplicate all leave one appearance per meeting';
end $$;
reset role;

-- The twin was a mistake; it is an empty draft whose only content is inherited,
-- so it can be discarded — which is also section 22's promise.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
delete from public.meetings where id = (select v from ctx where k = 'm2twin');
reset role;

-- ═══ 15. Resolve ════════════════════════════════════════════════════════════
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_msg text; i public.meeting_discussion_items; e public.meeting_discussion_events;
begin
  begin
    perform public.resolve_meeting_discussion_item((select v from ctx where k = 'a_m2_run1'), '   ');
    raise exception 'ASSERT 15: resolved without a note';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'ASSERT%' then raise; end if;
    if v_msg not like 'MEETING_DISCUSSION_NOTE_REQUIRED:%' then raise exception 'ASSERT 15: wrong refusal %', v_msg; end if;
  end;

  i := public.resolve_meeting_discussion_item((select v from ctx where k = 'a_m2_run1'), 'Fabric approved by client');
  if i.state <> 'resolved' or i.resolved_by <> '00000000-0000-4000-8000-0000000000e1'
     or i.resolved_at is null or i.resolution_note <> 'Fabric approved by client' then
    raise exception 'ASSERT 15: resolution fields';
  end if;
  select * into e from public.meeting_discussion_events
  where discussion_item_id = i.id and event_type = 'resolved';
  if e.appearance_id <> (select v from ctx where k = 'a_m2_run1') or e.detail <> 'Fabric approved by client'
     or e.previous_state <> 'open' or e.new_state <> 'resolved' then
    raise exception 'ASSERT 15: resolved event';
  end if;
  -- Resolving twice does not write a second resolution.
  perform public.resolve_meeting_discussion_item((select v from ctx where k = 'a_m2_run1'), 'again');
  if (select count(*) from public.meeting_discussion_events where discussion_item_id = i.id and event_type = 'resolved') <> 1 then
    raise exception 'ASSERT 15: a second resolution was recorded';
  end if;
  -- A resolved issue can no longer be updated or attached.
  begin
    perform public.save_meeting_discussion_update((select v from ctx where k = 'a_m2_run1'), 'after resolve', null, null, false);
    raise exception 'ASSERT 15: updated a resolved issue';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'ASSERT%' then raise; end if;
    if v_msg not like 'MEETING_DISCUSSION_RESOLVED:%' then raise exception 'ASSERT 15: wrong refusal %', v_msg; end if;
  end;

  perform public.set_meeting_status((select v from ctx where k = 'm2'), 'completed');
  raise notice 'PASS 15 resolve needs a note, records actor/time/trail once, and freezes the issue';
end $$;
reset role;

create temp table m2_snapshot on commit drop as
  select id, md5(row(a.*)::text) as h from public.meeting_discussion_appearances a
  where meeting_id = (select v from ctx where k = 'm2');
create temp table resolved_event_snapshot on commit drop as
  select id, md5(row(e.*)::text) as h from public.meeting_discussion_events e
  where discussion_item_id = (select v from ctx where k = 'run1') and event_type = 'resolved';

-- A resolved issue does not move on.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_m3 uuid;
begin
  insert into public.meetings (meeting_type, meeting_date, title, lead_id, created_by)
  values ('new_order', (now() at time zone 'Asia/Kolkata')::date + 2, 'M3 New Order',
          '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000e1')
  returning id into v_m3;
  if exists (select 1 from public.meeting_discussion_appearances
             where meeting_id = v_m3 and discussion_item_id = (select v from ctx where k = 'run1')) then
    raise exception 'ASSERT 15: a resolved issue was carried forward';
  end if;
  if not exists (select 1 from public.meeting_discussion_appearances
                 where meeting_id = v_m3 and discussion_item_id = (select v from ctx where k = 'run2')) then
    raise exception 'ASSERT 15: the still-open issue was not carried';
  end if;
  insert into ctx values ('m3', v_m3);
  raise notice 'PASS 15b a resolved issue stays out of M3; the open one on the same order moves on';
end $$;

-- ═══ 16. Reopen from a completed meeting ════════════════════════════════════
do $$
declare v_msg text; i public.meeting_discussion_items; e public.meeting_discussion_events;
begin
  begin
    perform public.reopen_meeting_discussion_item((select v from ctx where k = 'run1'), '');
    raise exception 'ASSERT 16: reopened without a reason';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'ASSERT%' then raise; end if;
    if v_msg not like 'MEETING_DISCUSSION_REASON_REQUIRED:%' then raise exception 'ASSERT 16: wrong refusal %', v_msg; end if;
  end;

  i := public.reopen_meeting_discussion_item((select v from ctx where k = 'run1'), 'Client rejected the swatch');
  if i.state <> 'open' or i.resolved_at is not null or i.resolved_by is not null or i.resolution_note is not null then
    raise exception 'ASSERT 16: reopened item fields';
  end if;
  select * into e from public.meeting_discussion_events where discussion_item_id = i.id and event_type = 'reopened';
  if e.detail <> 'Client rejected the swatch' or e.previous_update <> 'Fabric approved by client'
     or e.actor_id <> '00000000-0000-4000-8000-0000000000e1' or e.appearance_id is not null or e.meeting_id is not null then
    raise exception 'ASSERT 16: reopened event';
  end if;
  raise notice 'PASS 16 reopen needs a reason, returns the SAME issue to Open, and carries the original note forward';
end $$;
reset role;

do $$
begin
  if (select count(*) from m2_snapshot) <> 2 then
    raise exception 'ASSERT 16: the M2 snapshot holds % rows, so the comparison below would prove nothing', (select count(*) from m2_snapshot);
  end if;
  if exists (select 1 from m2_snapshot s left join public.meeting_discussion_appearances a on a.id = s.id
             where a.id is null or md5(row(a.*)::text) <> s.h) then
    raise exception 'ASSERT 16: the completed meeting that resolved it changed on reopen';
  end if;
  if exists (select 1 from resolved_event_snapshot s join public.meeting_discussion_events e on e.id = s.id
             where md5(row(e.*)::text) <> s.h)
     or (select count(*) from resolved_event_snapshot) <> 1 then
    raise exception 'ASSERT 16: the original resolution record changed or disappeared';
  end if;
  if (select status from public.meetings where id = (select v from ctx where k = 'm2')) <> 'completed' then
    raise exception 'ASSERT 16: reopening the issue reopened the meeting';
  end if;
  raise notice 'PASS 16b the completed meeting and the original resolution are byte-identical after the reopen';
end $$;

-- ═══ 17. The reopened issue returns in the next meeting, once ═══════════════
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_m4 uuid; a public.meeting_discussion_appearances;
begin
  insert into public.meetings (meeting_type, meeting_date, title, lead_id, created_by)
  values ('new_order', (now() at time zone 'Asia/Kolkata')::date + 3, 'M4 New Order',
          '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000e1')
  returning id into v_m4;
  select * into a from public.meeting_discussion_appearances
  where meeting_id = v_m4 and discussion_item_id = (select v from ctx where k = 'run1');
  if a.id is null then raise exception 'ASSERT 17: reopened issue not carried'; end if;
  -- Its most recent earlier appearance is M2, where it was resolved and later reopened.
  if a.carried_from_id is distinct from (select v from ctx where k = 'a_m2_run1') then
    raise exception 'ASSERT 17: carried from the wrong appearance';
  end if;
  if (select count(*) from public.meeting_discussion_appearances where meeting_id = v_m4 and discussion_item_id = a.discussion_item_id) <> 1 then
    raise exception 'ASSERT 17: duplicated';
  end if;
  insert into ctx values ('m4', v_m4), ('a_m4_run1', a.id);
  raise notice 'PASS 17 a reopened issue is carried into the next meeting once, from its latest meeting';
end $$;
reset role;

-- ═══ 18. Two issues on one order keep separate threads ══════════════════════
do $$
begin
  -- Both threads exist, so the checks below are not comparing empty sets.
  if (select count(*) from public.meeting_discussion_events where discussion_item_id = (select v from ctx where k = 'run1')) = 0
     or (select count(*) from public.meeting_discussion_events where discussion_item_id = (select v from ctx where k = 'run2')) = 0 then
    raise exception 'ASSERT 18: one of the two issues has no trail, so this proves nothing';
  end if;
  -- Every trail row that names an appearance names one of ITS OWN issue.
  if exists (
    select 1 from public.meeting_discussion_events e
    join public.meeting_discussion_appearances a on a.id = e.appearance_id
    where a.discussion_item_id <> e.discussion_item_id
  ) then
    raise exception 'ASSERT 18: a trail row points at another issue''s appearance';
  end if;
  if exists (
    select 1 from public.meeting_discussion_events
    where discussion_item_id = (select v from ctx where k = 'run2') and event_type in ('update', 'resolved', 'reopened')
  ) then
    raise exception 'ASSERT 18: the other issue on the order picked up this issue''s updates';
  end if;
  raise notice 'PASS 18 the two issues on order 2041 share no trail rows';
end $$;

-- ═══ 19. An Inbox item attached by hand is placed once ══════════════════════
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare r jsonb; a1 public.meeting_discussion_appearances; a2 public.meeting_discussion_appearances; v_m5 uuid;
begin
  r := public.capture_meeting_discussion_item('running_order', '5120', 'QC issue on table tops', null, null, null, null, null);
  a1 := public.attach_meeting_discussion_item((select v from ctx where k = 'm4'), (r->>'item_id')::uuid);
  a2 := public.attach_meeting_discussion_item((select v from ctx where k = 'm4'), (r->>'item_id')::uuid);
  if a1.id <> a2.id then raise exception 'ASSERT 19: the second attach created a second appearance'; end if;

  insert into public.meetings (meeting_type, meeting_date, title, lead_id, created_by)
  values ('new_order', (now() at time zone 'Asia/Kolkata')::date + 4, 'M5 New Order',
          '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000e1')
  returning id into v_m5;
  -- Still open, so it is CARRIED into M5 — but it entered from the Inbox exactly once.
  if (select count(*) from public.meeting_discussion_events
      where discussion_item_id = (r->>'item_id')::uuid and event_type = 'added_to_agenda') <> 1 then
    raise exception 'ASSERT 19: entered from the Inbox more than once';
  end if;
  if (select count(*) from public.meeting_discussion_events
      where discussion_item_id = (r->>'item_id')::uuid and event_type = 'carried_forward') <> 1 then
    raise exception 'ASSERT 19: not carried into M5 once';
  end if;
  insert into ctx values ('m5', v_m5);
  raise notice 'PASS 19 an Inbox item is placed once by hand and then moves on by carry-forward';
end $$;
reset role;

-- ═══ 20. Evidence ═══════════════════════════════════════════════════════════
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_order uuid; v_again uuid;
begin
  if (select meeting_order_id from public.meeting_discussion_appearances where id = (select v from ctx where k = 'a_m4_run1')) is not null then
    raise exception 'ASSERT 20: the order folder existed before it was needed';
  end if;
  v_order := public.ensure_meeting_discussion_order((select v from ctx where k = 'a_m4_run1'));
  v_again := public.ensure_meeting_discussion_order((select v from ctx where k = 'a_m4_run1'));
  if v_order <> v_again then raise exception 'ASSERT 20: ensure is not idempotent'; end if;
  if (select count(*) from public.meeting_orders where meeting_id = (select v from ctx where k = 'm4') and order_number_key = '2041') <> 1 then
    raise exception 'ASSERT 20: order row count';
  end if;
  if (select count(*) from public.meeting_update_history where meeting_order_id = v_order and entry_type = 'order_added') <> 1 then
    raise exception 'ASSERT 20: the Order rail did not record the order being added';
  end if;
  insert into ctx values ('o_m4', v_order);
end $$;
reset role;

-- The uploaded object, as Storage would record it: under the Order folder, owned
-- by the Editor, type and size in Storage's own metadata.
insert into storage.objects (bucket_id, name, owner_id, metadata)
select 'meeting-evidence', v || '/11111111-1111-4111-8111-111111111111.jpg',
       '00000000-0000-4000-8000-0000000000e1', '{"mimetype":"image/jpeg","size":2048}'::jsonb
from ctx where k = 'o_m4';
insert into storage.objects (bucket_id, name, owner_id, metadata)
select 'meeting-evidence', v || '/22222222-2222-4222-8222-222222222222.jpg',
       '00000000-0000-4000-8000-0000000000d1', '{"mimetype":"image/jpeg","size":2048}'::jsonb
from ctx where k = 'o_m4';

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare ev public.meeting_order_evidence; v_msg text;
begin
  ev := public.add_meeting_discussion_evidence((select v from ctx where k = 'a_m4_run1'),
          (select v from ctx where k = 'o_m4') || '/11111111-1111-4111-8111-111111111111.jpg', 'swatch.jpg');
  if ev.discussion_appearance_id <> (select v from ctx where k = 'a_m4_run1')
     or ev.meeting_order_id <> (select v from ctx where k = 'o_m4')
     or ev.mime_type <> 'image/jpeg' or ev.size_bytes <> 2048 or ev.uploaded_by <> '00000000-0000-4000-8000-0000000000e1' then
    raise exception 'ASSERT 20: evidence row';
  end if;
  begin
    perform public.add_meeting_discussion_evidence((select v from ctx where k = 'a_m4_run1'),
      (select v from ctx where k = 'o_m4') || '/22222222-2222-4222-8222-222222222222.jpg', 'not mine.jpg');
    raise exception 'ASSERT 20: recorded somebody else''s upload';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'ASSERT%' then raise; end if;
    if v_msg not like 'MEETING_EVIDENCE_NOT_STORED:%' then raise exception 'ASSERT 20: wrong refusal %', v_msg; end if;
  end;
  begin
    perform public.add_meeting_discussion_evidence((select v from ctx where k = 'a_m4_run1'),
      '00000000-0000-4000-8000-000000000000/33333333-3333-4333-8333-333333333333.jpg', 'elsewhere.jpg');
    raise exception 'ASSERT 20: recorded an object outside the order folder';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'ASSERT%' then raise; end if;
    if v_msg not like 'MEETING_EVIDENCE_PATH_INVALID:%' then raise exception 'ASSERT 20: wrong refusal %', v_msg; end if;
  end;
  raise notice 'PASS 20 evidence gets its folder lazily, records only the caller''s stored object, and is tagged to the issue';
end $$;
reset role;

-- ═══ 21. Who can see an issue ═══════════════════════════════════════════════
-- The Viewer attended M1 only. The Outsider attended nothing. The Sales user
-- created none of these issues (the Editor captured them).
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if not exists (select 1 from public.meeting_discussion_items where id = (select v from ctx where k = 'run1')) then
    raise exception 'ASSERT 21: an attendee cannot see an issue on their meeting';
  end if;
  if exists (select 1 from public.meeting_discussion_items where id = (select v from ctx where k = 'as1')) then
    raise exception 'ASSERT 21: an attendee can see an issue from a meeting they did not attend';
  end if;
  if (select count(*) from public.meeting_discussion_events where discussion_item_id = (select v from ctx where k = 'run1')) = 0 then
    raise exception 'ASSERT 21: an attendee cannot read the issue''s trail';
  end if;
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000d1","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from public.meeting_discussion_items) <> 0
     or (select count(*) from public.meeting_discussion_appearances) <> 0
     or (select count(*) from public.meeting_discussion_events) <> 0 then
    raise exception 'ASSERT 21: an outsider can see discussion data';
  end if;
  raise notice 'PASS 21 attendees see their meetings'' issues; outsiders see nothing';
end $$;
reset role;

-- ═══ 22. An empty draft that only inherited issues can still be deleted ═════
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_m6 uuid; n_items_before int;
begin
  n_items_before := (select count(*) from public.meeting_discussion_items);
  insert into public.meetings (meeting_type, meeting_date, title, lead_id, created_by)
  values ('new_order', (now() at time zone 'Asia/Kolkata')::date + 5, 'M6 raised by mistake',
          '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000e1')
  returning id into v_m6;
  if (select count(*) from public.meeting_discussion_appearances where meeting_id = v_m6) = 0 then
    raise exception 'ASSERT 22: the draft inherited nothing, so this proves nothing';
  end if;
  delete from public.meetings where id = v_m6;
  if exists (select 1 from public.meetings where id = v_m6) then
    raise exception 'ASSERT 22: the draft could not be deleted';
  end if;
  if (select count(*) from public.meeting_discussion_items) <> n_items_before then
    raise exception 'ASSERT 22: deleting the draft removed an issue';
  end if;
  raise notice 'PASS 22 a mistaken draft that only inherited issues is still deletable; no issue is lost';
end $$;
reset role;

do $$
begin
  -- The trail of the deleted draft survives, detached, with its title snapshot.
  if not exists (
    select 1 from public.meeting_discussion_events
    where meeting_title = 'M6 raised by mistake' and meeting_id is null and appearance_id is null
  ) then
    raise exception 'ASSERT 22: the deleted draft''s trail rows were erased';
  end if;
end $$;

-- …and nobody reads those detached rows: they name a meeting that never happened.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if exists (select 1 from public.meeting_discussion_events where meeting_title = 'M6 raised by mistake') then
    raise exception 'ASSERT 22: a detached trail row of a deleted draft is readable';
  end if;
end $$;
reset role;

-- ═══ 23. Meeting notes follow the meeting ═══════════════════════════════════
-- The Viewer attends M1 only. run1's thread holds: an update + decision in M1,
-- a resolution in M2, a reopening reason (quoting M2's note), and an image in M4.
-- EXPECT: the Viewer reads M1's rows and the capture; nothing from M2 or M4; not
--         the reopening reason; never resolution_note from the issue row. Once
--         made an attendee of M2, the resolution and the reason become readable.
do $$
begin
  -- Not vacuous: every row the Viewer must NOT see really exists.
  if (select count(*) from public.meeting_discussion_events
      where discussion_item_id = (select v from ctx where k = 'run1') and event_type = 'update'
        and meeting_id = (select v from ctx where k = 'm1')) <> 1
     or (select count(*) from public.meeting_discussion_events
         where discussion_item_id = (select v from ctx where k = 'run1') and event_type = 'resolved'
           and meeting_id = (select v from ctx where k = 'm2')) <> 1
     or (select count(*) from public.meeting_discussion_events
         where discussion_item_id = (select v from ctx where k = 'run1') and event_type = 'reopened') <> 1
     or (select count(*) from public.meeting_order_evidence
         where discussion_appearance_id = (select v from ctx where k = 'a_m4_run1')) <> 1 then
    raise exception 'ASSERT 23: the fixture thread is not what this section needs';
  end if;
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_msg text; v_note text;
begin
  if (select count(*) from public.meeting_discussion_events
      where discussion_item_id = (select v from ctx where k = 'run1') and event_type = 'update'
        and meeting_id = (select v from ctx where k = 'm1')) <> 1 then
    raise exception 'ASSERT 23: an attendee cannot read their own meeting''s update';
  end if;
  if (select count(*) from public.meeting_discussion_events
      where discussion_item_id = (select v from ctx where k = 'run1') and event_type = 'captured') <> 1 then
    raise exception 'ASSERT 23: an attendee cannot read how the issue was raised';
  end if;
  if exists (select 1 from public.meeting_discussion_events
             where discussion_item_id = (select v from ctx where k = 'run1')
               and (meeting_id is distinct from (select v from ctx where k = 'm1'))
               and event_type <> 'captured') then
    raise exception 'ASSERT 23: an attendee of M1 reads trail rows from another meeting';
  end if;
  if exists (select 1 from public.meeting_discussion_appearances
             where discussion_item_id = (select v from ctx where k = 'run1')
               and meeting_id <> (select v from ctx where k = 'm1')) then
    raise exception 'ASSERT 23: an attendee of M1 reads another meeting''s update, decision or review date';
  end if;
  if exists (select 1 from public.meeting_order_evidence
             where discussion_appearance_id = (select v from ctx where k = 'a_m4_run1')) then
    raise exception 'ASSERT 23: an attendee of M1 reads evidence recorded in M4';
  end if;
  begin
    select resolution_note into v_note from public.meeting_discussion_items
    where id = (select v from ctx where k = 'run1');
    raise exception 'ASSERT 23: resolution_note was selectable by a client role';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'ASSERT%' then raise; end if;
    if v_msg not like 'permission denied%' then raise exception 'ASSERT 23: wrong refusal %', v_msg; end if;
  end;
end $$;
reset role;

insert into public.meeting_attendees (meeting_id, user_id)
select v, '00000000-0000-4000-8000-0000000000f1' from ctx where k = 'm2';

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from public.meeting_discussion_events
      where discussion_item_id = (select v from ctx where k = 'run1') and event_type = 'resolved') <> 1 then
    raise exception 'ASSERT 23: an attendee of the resolving meeting cannot read the resolution';
  end if;
  if (select count(*) from public.meeting_discussion_events
      where discussion_item_id = (select v from ctx where k = 'run1') and event_type = 'reopened') <> 1 then
    raise exception 'ASSERT 23: an attendee of the resolving meeting cannot read the reopening reason';
  end if;
  raise notice 'PASS 23 meeting notes, resolutions, reopening reasons and evidence follow the meeting they were recorded in';
end $$;
reset role;

delete from public.meeting_attendees
where user_id = '00000000-0000-4000-8000-0000000000f1' and meeting_id = (select v from ctx where k = 'm2');

-- ═══ 24. A meetings 'edit' grant alone sees Inbox issues only ════════════════
-- X holds 'edit' (not 'manage') and attends nothing.
-- EXPECT: X reads exactly the Inbox issues and their capture rows; nothing on any
--         agenda; once X attaches an Inbox issue to a meeting X cannot open, X no
--         longer reads it — while the Editor still does.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare r jsonb;
begin
  r := public.capture_meeting_discussion_item('after_sales', '7700', 'Cushion cover replacement', null, null, 'replacement', null, null);
  insert into ctx values ('inbox_as', (r->>'item_id')::uuid);
  r := public.capture_meeting_discussion_item('running_order', '7701', 'Dispatch date not confirmed', null, null, null, null, null);
  insert into ctx values ('inbox_run', (r->>'item_id')::uuid);
end $$;
reset role;

do $$
begin
  if (select count(*) from public.meeting_discussion_items i
      where not exists (select 1 from public.meeting_discussion_appearances a where a.discussion_item_id = i.id)) <> 2
     or (select count(*) from public.meeting_discussion_items) <= 2 then
    raise exception 'ASSERT 24: expected exactly two Inbox issues and others on agendas';
  end if;
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_msg text;
begin
  if (select count(*) from public.meeting_discussion_items) <> 2
     or exists (select 1 from public.meeting_discussion_items
                where id not in ((select v from ctx where k = 'inbox_as'), (select v from ctx where k = 'inbox_run'))) then
    raise exception 'ASSERT 24: an edit grant reads issues outside the Inbox';
  end if;
  if (select count(*) from public.list_meeting_discussion_inbox()) <> 2 then
    raise exception 'ASSERT 24: the Inbox read does not give an edit grant the two Inbox issues';
  end if;
  if exists (select 1 from public.meeting_discussion_events where event_type <> 'captured')
     or (select count(*) from public.meeting_discussion_events) <> 2 then
    raise exception 'ASSERT 24: an edit grant reads trail rows beyond the Inbox captures';
  end if;
  if exists (select 1 from public.meeting_discussion_appearances) then
    raise exception 'ASSERT 24: an edit grant reads an agenda it cannot open';
  end if;

  -- 'edit' may still triage: put the After Sales issue on R1.
  perform public.attach_meeting_discussion_item((select v from ctx where k = 'r1'), (select v from ctx where k = 'inbox_as'));
  if exists (select 1 from public.meeting_discussion_items where id = (select v from ctx where k = 'inbox_as')) then
    raise exception 'ASSERT 24: after attaching, an edit grant still reads an issue on a meeting it cannot open';
  end if;
  raise notice 'PASS 24 a meetings edit grant alone reads Inbox issues only, and loses them to a meeting it cannot open';
end $$;
reset role;

-- ═══ 25. The authoritative Inbox read ═══════════════════════════════════════
-- EXPECT: Sales raises 8800 (Inbox, visible to Sales as creator). The Editor puts it
--         on M5 and records a note. Sales still reads the issue row, but not the
--         note, not the agenda — and the Inbox read no longer lists it, although
--         "open issues minus the agendas I can see" would. A repeat capture from a
--         task says "on an agenda" without naming a meeting Sales cannot open.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000c1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare r jsonb;
begin
  r := public.capture_meeting_discussion_item('running_order', '8800', 'Carving detail differs from drawing', null, null, null, null, null);
  insert into ctx values ('sales_item', (r->>'item_id')::uuid);
  if not exists (select 1 from public.list_meeting_discussion_inbox() where id = (r->>'item_id')::uuid) then
    raise exception 'ASSERT 25: the creator does not see their own Inbox issue';
  end if;
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare a public.meeting_discussion_appearances;
begin
  a := public.attach_meeting_discussion_item((select v from ctx where k = 'm5'), (select v from ctx where k = 'sales_item'));
  perform public.save_meeting_discussion_update(a.id, 'Confidential: supplier price revised', null, null, false, false);
  if exists (select 1 from public.list_meeting_discussion_inbox() where id = (select v from ctx where k = 'sales_item')) then
    raise exception 'ASSERT 25: an issue on an agenda is listed in the Editor''s Inbox';
  end if;
  if not exists (select 1 from public.list_meeting_discussion_inbox() where id = (select v from ctx where k = 'inbox_run'))
     or exists (select 1 from public.list_meeting_discussion_inbox() where id = (select v from ctx where k = 'inbox_as')) then
    raise exception 'ASSERT 25: the Editor''s Inbox is not exactly the unplaced issues';
  end if;
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000c1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare r jsonb;
begin
  if not exists (select 1 from public.meeting_discussion_items where id = (select v from ctx where k = 'sales_item')) then
    raise exception 'ASSERT 25: the creator lost sight of their issue row';
  end if;
  if exists (select 1 from public.meeting_discussion_appearances where discussion_item_id = (select v from ctx where k = 'sales_item'))
     or exists (select 1 from public.meeting_discussion_events
                where discussion_item_id = (select v from ctx where k = 'sales_item') and event_type <> 'captured') then
    raise exception 'ASSERT 25: the creator reads a meeting''s notes on their issue';
  end if;
  -- The naive browser inference would still call it waiting…
  if not exists (
    select 1 from public.meeting_discussion_items i
    where i.id = (select v from ctx where k = 'sales_item') and i.state = 'open'
      and not exists (select 1 from public.meeting_discussion_appearances a where a.discussion_item_id = i.id)
  ) then
    raise exception 'ASSERT 25: expected the visible-appearance inference to be wrong here, or this proves nothing';
  end if;
  -- …the database does not.
  if exists (select 1 from public.list_meeting_discussion_inbox() where id = (select v from ctx where k = 'sales_item')) then
    raise exception 'ASSERT 25: the Inbox read lists an issue that is on an agenda';
  end if;

  -- Sales created T1, whose open issue (run1) is on M4 and M5 — neither of which Sales can open.
  r := public.capture_meeting_discussion_item('running_order', '2041', 'Fabric again', null, null, null, null,
         '00000000-0000-4000-8000-00000000a001');
  if r->>'status' <> 'existing' or (r->>'on_agenda')::boolean is not true or (r->>'in_inbox')::boolean
     or r->>'meeting_id' is not null then
    raise exception 'ASSERT 25: a repeat capture reported %', r;
  end if;
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  -- The Viewer is neither a creator nor a triager: an Inbox that exists is not theirs.
  if exists (select 1 from public.list_meeting_discussion_inbox()) then
    raise exception 'ASSERT 25: a view-only member reads the Meeting Inbox';
  end if;
  raise notice 'PASS 25 the Inbox is decided by the database, not by the agendas a reader can see; a repeat capture names no hidden meeting';
end $$;
reset role;

-- ═══ 26. No Meetings access ═════════════════════════════════════════════════
-- N has 'view' removed, and is made an attendee of M4 so that visibility — not the
-- absence of any relationship — is what the module gate has to refuse.
insert into public.meeting_attendees (meeting_id, user_id)
select v, '00000000-0000-4000-8000-0000000000b2' from ctx where k = 'm4';

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_msg text;
begin
  begin
    perform public.capture_meeting_discussion_item('running_order', '9000', 'no access', null, null, null, null, null);
    raise exception 'ASSERT 26: captured without Meetings access';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'ASSERT%' then raise; end if;
    if v_msg not like 'MEETING_FORBIDDEN:%' then raise exception 'ASSERT 26: wrong refusal %', v_msg; end if;
  end;
  begin
    perform public.list_meeting_discussion_inbox();
    raise exception 'ASSERT 26: read the Inbox without Meetings access';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'ASSERT%' then raise; end if;
    if v_msg not like 'MEETING_FORBIDDEN:%' then raise exception 'ASSERT 26: wrong refusal %', v_msg; end if;
  end;
  if exists (select 1 from public.meeting_discussion_items)
     or exists (select 1 from public.meeting_discussion_appearances)
     or exists (select 1 from public.meeting_discussion_events) then
    raise exception 'ASSERT 26: a user without Meetings access reads discussion data';
  end if;
end $$;
reset role;

do $$
begin
  if not exists (select 1 from public.meeting_discussion_appearances where meeting_id = (select v from ctx where k = 'm4'))
     or not public.can_view_meeting((select v from ctx where k = 'm4'), '00000000-0000-4000-8000-0000000000b2') then
    raise exception 'ASSERT 26: M4 is empty or N is not its attendee, so the refusal above proves nothing';
  end if;
  raise notice 'PASS 26 without Meetings access a user is refused capture and the Inbox, and reads nothing even as an attendee';
end $$;

-- ═══ 27. Real follow-up task linking ════════════════════════════════════════
-- EXPECT: the Editor (assignee of T1) links T1 to run1 in M4: one 'task_linked' row
--         with the task title; linking again adds nothing; T3 (the Outsider's) is
--         refused and leaves no row; the Viewer can neither see nor make a link.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_msg text;
begin
  perform public.link_meeting_discussion_task((select v from ctx where k = 'a_m4_run1'), '00000000-0000-4000-8000-00000000a001');
  perform public.link_meeting_discussion_task((select v from ctx where k = 'a_m4_run1'), '00000000-0000-4000-8000-00000000a001');
  if (select count(*) from public.meeting_discussion_events
      where appearance_id = (select v from ctx where k = 'a_m4_run1') and event_type = 'task_linked'
        and task_id = '00000000-0000-4000-8000-00000000a001'
        and detail = 'Follow-up task: Order 2041 fabric approval pending') <> 1 then
    raise exception 'ASSERT 27: expected exactly one task_linked row with the task title';
  end if;
  begin
    perform public.link_meeting_discussion_task((select v from ctx where k = 'a_m4_run1'), '00000000-0000-4000-8000-00000000a003');
    raise exception 'ASSERT 27: linked a task the caller neither created nor holds';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'ASSERT%' then raise; end if;
    if v_msg not like 'MEETING_TASK_NOT_LINKABLE:%' then raise exception 'ASSERT 27: wrong refusal %', v_msg; end if;
  end;
end $$;
reset role;

do $$
begin
  if exists (select 1 from public.meeting_discussion_events where task_id = '00000000-0000-4000-8000-00000000a003') then
    raise exception 'ASSERT 27: a refused link left a trail row';
  end if;
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_msg text;
begin
  if exists (select 1 from public.meeting_discussion_events where event_type = 'task_linked') then
    raise exception 'ASSERT 27: a follow-up task title is readable outside its meeting';
  end if;
  begin
    perform public.link_meeting_discussion_task((select v from ctx where k = 'a_m4_run1'), '00000000-0000-4000-8000-00000000a001');
    raise exception 'ASSERT 27: a non-editor linked a task';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'ASSERT%' then raise; end if;
    if v_msg not like 'MEETING_FORBIDDEN:%' then raise exception 'ASSERT 27: wrong refusal %', v_msg; end if;
  end;
  raise notice 'PASS 27 a follow-up task links once, only for a task the caller holds, and its title stays inside the meeting';
end $$;
reset role;

-- ═══ 28. Clearing a decision ════════════════════════════════════════════════
-- EXPECT: NULL and '' leave a decision alone; p_clear_decision removes it and the
--         trail says so; exactly two 'update' rows (set, clear) are written.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare a public.meeting_discussion_appearances; n_before int;
begin
  n_before := (select count(*) from public.meeting_discussion_events
               where appearance_id = (select v from ctx where k = 'a_m4_run1') and event_type = 'update');
  a := public.save_meeting_discussion_update((select v from ctx where k = 'a_m4_run1'), null, 'Hold dispatch', null, false, false);
  if a.decision is distinct from 'Hold dispatch' then raise exception 'ASSERT 28: decision not recorded'; end if;
  a := public.save_meeting_discussion_update(a.id, null, null, null, false, false);
  if a.decision is distinct from 'Hold dispatch' then raise exception 'ASSERT 28: a NULL decision removed it'; end if;
  a := public.save_meeting_discussion_update(a.id, null, '', null, false, false);
  if a.decision is distinct from 'Hold dispatch' then raise exception 'ASSERT 28: an empty decision removed it'; end if;
  a := public.save_meeting_discussion_update(a.id, null, null, null, false, true);
  if a.decision is not null then raise exception 'ASSERT 28: the clear flag did not remove the decision'; end if;
  if (select count(*) from public.meeting_discussion_events
      where appearance_id = a.id and event_type = 'update') <> n_before + 2 then
    raise exception 'ASSERT 28: expected two update rows (set, clear)';
  end if;
  if not exists (select 1 from public.meeting_discussion_events
                 where appearance_id = a.id and event_type = 'update' and detail = 'Decision cleared') then
    raise exception 'ASSERT 28: the trail does not record the decision being cleared';
  end if;
  raise notice 'PASS 28 a decision is removed only by the explicit clear flag, and the trail records it';
end $$;
reset role;

-- ═══ 29. Deleting a draft ═══════════════════════════════════════════════════
-- EXPECT: M7 is a fresh draft that inherited open issues automatically. Each
--         probe does ONE substantive thing and then tries to delete M7, inside a
--         sub-block that is rolled back afterwards: every probe is refused. With
--         nothing done, M7 deletes, no issue is lost, and its detached rows are
--         unreadable.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_m7 uuid;
begin
  insert into public.meetings (meeting_type, meeting_date, title, lead_id, created_by)
  values ('new_order', (now() at time zone 'Asia/Kolkata')::date + 6, 'M7 draft under test',
          '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000e1')
  returning id into v_m7;
  insert into ctx values ('m7', v_m7),
    ('a_m7_run1', (select id from public.meeting_discussion_appearances where meeting_id = v_m7 and discussion_item_id = (select v from ctx where k = 'run1'))),
    ('a_m7_run2', (select id from public.meeting_discussion_appearances where meeting_id = v_m7 and discussion_item_id = (select v from ctx where k = 'run2')));
end $$;
reset role;

do $$
begin
  if (select v from ctx where k = 'a_m7_run1') is null or (select v from ctx where k = 'a_m7_run2') is null
     or exists (select 1 from public.meeting_discussion_appearances
                where meeting_id = (select v from ctx where k = 'm7') and placement <> 'automatic') then
    raise exception 'ASSERT 29: M7 did not inherit run1 and run2 automatically, so the probes prove nothing';
  end if;
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_m7 uuid := (select v from ctx where k = 'm7');
  v_a1 uuid := (select v from ctx where k = 'a_m7_run1');
  v_a2 uuid := (select v from ctx where k = 'a_m7_run2');
  v_probe text;
  v_msg text;
  n int;
begin
  foreach v_probe in array array[
    'update', 'decision', 'next_review', 'decision_then_cleared', 'resolved',
    'task_link', 'evidence_folder', 'manual_attach'
  ] loop
    begin
      case v_probe
        when 'update'      then perform public.save_meeting_discussion_update(v_a1, 'Discussed today', null, null, false, false);
        when 'decision'    then perform public.save_meeting_discussion_update(v_a1, null, 'Proceed', null, false, false);
        when 'next_review' then perform public.save_meeting_discussion_update(v_a1, null, null, current_date + 14, false, false);
        when 'decision_then_cleared' then
          perform public.save_meeting_discussion_update(v_a1, null, 'Proceed', null, false, false);
          perform public.save_meeting_discussion_update(v_a1, null, null, null, false, true);
        when 'resolved'    then perform public.resolve_meeting_discussion_item(v_a2, 'Closed in the draft');
        when 'task_link'   then perform public.link_meeting_discussion_task(v_a1, '00000000-0000-4000-8000-00000000a001');
        when 'evidence_folder' then perform public.ensure_meeting_discussion_order(v_a1);
        when 'manual_attach' then
          perform public.capture_meeting_discussion_item('running_order', '9100', 'Raised straight onto the draft', v_m7, null, null, null, null);
      end case;

      begin
        delete from public.meetings where id = v_m7;
        get diagnostics n = row_count;
        if n = 0 then raise exception 'ASSERT 29: [%] the delete was filtered, not refused — this proves nothing', v_probe; end if;
        raise exception 'ASSERT 29: [%] a draft holding a discussion was deleted', v_probe;
      exception when others then
        get stacked diagnostics v_msg = message_text;
        if v_msg like 'ASSERT%' then raise; end if;
        if v_msg not like 'MEETING_HAS_DISCUSSION:%'
           and not (v_probe = 'evidence_folder' and v_msg like 'MEETING_HAS_CONTENT:%') then
          raise exception 'ASSERT 29: [%] wrong refusal %', v_probe, v_msg;
        end if;
      end;

      raise exception 'PROBE_ROLLBACK';
    exception when others then
      get stacked diagnostics v_msg = message_text;
      if v_msg <> 'PROBE_ROLLBACK' then raise; end if;
    end;
  end loop;

  -- Every probe was rolled back: M7 is untouched again.
  if exists (select 1 from public.meeting_discussion_appearances
             where meeting_id = v_m7
               and (placement <> 'automatic' or latest_update is not null or decision is not null
                    or next_review_date is not null or discussed_at is not null or meeting_order_id is not null)) then
    raise exception 'ASSERT 29: a probe was not rolled back';
  end if;
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n_items int := (select count(*) from public.meeting_discussion_items); n int;
begin
  delete from public.meetings where id = (select v from ctx where k = 'm7');
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'ASSERT 29: the untouched draft could not be deleted'; end if;
  if (select count(*) from public.meeting_discussion_items) <> n_items then
    raise exception 'ASSERT 29: deleting the untouched draft removed an issue';
  end if;
  if exists (select 1 from public.meeting_discussion_events where meeting_title = 'M7 draft under test') then
    raise exception 'ASSERT 29: the deleted draft''s detached rows are readable';
  end if;
end $$;
reset role;

do $$
begin
  if not exists (select 1 from public.meeting_discussion_events where meeting_title = 'M7 draft under test' and meeting_id is null) then
    raise exception 'ASSERT 29: expected detached carry-forward rows for M7, or the unreadability check proves nothing';
  end if;
  raise notice 'PASS 29 a draft with any recorded activity cannot be deleted; an untouched inherited draft can';
end $$;

-- ═══ 30. No Meetings access: every callable function refuses ════════════════
-- The functions are ENUMERATED FROM THE CATALOGUE: every function of this
-- workflow that `authenticated` can execute. The expected list below must match
-- it exactly, so a function added later without a probe here fails this section.
--
-- Two users whose Meetings 'view' is taken away, each with the strongest remaining
-- claim on meeting M30: L (b3) is a manager who LEADS and CREATED it; X2 (b4) is a
-- member holding Meetings 'edit'.
-- EXPECT, without access: every RPC raises MEETING_FORBIDDEN — so none returns a
--         row — including for an id that does not exist (no existence probe); both
--         visibility predicates answer false; direct reads of the three tables and
--         of evidence return nothing.
-- EXPECT, with 'view' restored and nothing else changed: no RPC is refused for
--         lack of access, and both predicates answer true — so the refusals above
--         came from the module-entry check and nothing else.
create temp table rpc_expected (fn text primary key) on commit drop;
insert into rpc_expected values
  ('add_meeting_discussion_evidence'), ('attach_meeting_discussion_item'),
  ('can_view_discussion_event'), ('can_view_discussion_item'),
  ('capture_meeting_discussion_item'), ('carry_forward_meeting_discussions'),
  ('ensure_meeting_discussion_order'), ('link_meeting_discussion_task'),
  ('list_meeting_discussion_inbox'), ('reopen_meeting_discussion_item'),
  ('resolve_meeting_discussion_item'), ('save_meeting_discussion_update');

do $$
declare v_missing text; v_extra text; v_overloaded text;
begin
  select string_agg(p.proname, ', ') into v_extra
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like '%discussion%'
    and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and p.proname not in (select fn from rpc_expected);
  select string_agg(e.fn, ', ') into v_missing
  from rpc_expected e
  where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = e.fn
      and has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  select string_agg(p.proname, ', ') into v_overloaded
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in (select fn from rpc_expected)
  group by p.proname having count(*) > 1;
  if v_extra is not null then raise exception 'ASSERT 30: callable but not probed here: %', v_extra; end if;
  if v_missing is not null then raise exception 'ASSERT 30: expected callable but not granted: %', v_missing; end if;
  if v_overloaded is not null then raise exception 'ASSERT 30: overloaded, so a probe could hit the wrong one: %', v_overloaded; end if;
  if has_function_privilege('authenticated', 'public.meeting_discussion_category_for_type(text)', 'EXECUTE') then
    raise exception 'ASSERT 30: the category mapping is callable by a client';
  end if;
end $$;

insert into public.users (id, full_name, role, team, is_active, created_at, updated_at) values
  ('00000000-0000-4000-8000-0000000000b3', 'Lead without access',  'manager', 'management', true, now(), now()),
  ('00000000-0000-4000-8000-0000000000b4', 'Edit without access',  'member',  'operations', true, now(), now());

insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select u.id, pm.id, pa.id, u.allowed, '00000000-0000-4000-8000-0000000000a1'
from (values
  ('00000000-0000-4000-8000-0000000000b3'::uuid, 'view', false),
  ('00000000-0000-4000-8000-0000000000b4'::uuid, 'view', false),
  ('00000000-0000-4000-8000-0000000000b4'::uuid, 'edit', true)
) as u(id, action_key, allowed)
join public.permission_modules pm on pm.module_key = 'meetings'
join public.permission_actions pa on pa.action_key = u.action_key;

insert into public.tasks (id, title, team, created_by, assigned_to) values
  ('00000000-0000-4000-8000-00000000a0b3', 'Task held by the lead', 'management',
   '00000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-0000000000b3'),
  ('00000000-0000-4000-8000-00000000a0b4', 'Task held by the edit holder', 'operations',
   '00000000-0000-4000-8000-0000000000b4', '00000000-0000-4000-8000-0000000000b4');

-- M30 is led and created by L — created while L still had access, in production.
insert into public.meetings (id, meeting_type, meeting_date, title, lead_id, created_by)
values ('00000000-0000-4000-8000-00000000c030', 'new_order', (now() at time zone 'Asia/Kolkata')::date + 7,
        'M30 access probe', '00000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-0000000000b3');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare r jsonb;
begin
  r := public.capture_meeting_discussion_item('running_order', '9301', 'Probe issue on M30', '00000000-0000-4000-8000-00000000c030', null, null, null, null);
  insert into ctx values ('p30_item_a', (r->>'item_id')::uuid), ('p30_app_a', (r->>'appearance_id')::uuid);
  r := public.capture_meeting_discussion_item('running_order', '9302', 'Probe issue resolved on M30', '00000000-0000-4000-8000-00000000c030', null, null, null, null);
  insert into ctx values ('p30_item_b', (r->>'item_id')::uuid);
  perform public.resolve_meeting_discussion_item((r->>'appearance_id')::uuid, 'Resolved so reopen can be probed');
  r := public.capture_meeting_discussion_item('running_order', '9303', 'Probe issue in the Inbox', null, null, null, null, null);
  insert into ctx values ('p30_inbox', (r->>'item_id')::uuid);
end $$;
reset role;

-- Each probe runs in its own sub-transaction and is rolled back, so a probe that
-- succeeds cannot change what the next one sees. 'ALLOWED' or the refusal's prefix.
create or replace function pg_temp.p30_try(p_sql text) returns text language plpgsql as $f$
declare v_msg text;
begin
  begin
    execute p_sql;
    raise exception 'P30_ALLOWED';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg = 'P30_ALLOWED' then return 'ALLOWED'; end if;
    return split_part(v_msg, ':', 1);
  end;
end $f$;
grant execute on function pg_temp.p30_try(text) to authenticated;

create temp table p30_result (phase text, who text, fn text, outcome text) on commit drop;
grant all on p30_result to authenticated;

create or replace function pg_temp.p30_probe(p_phase text) returns void language plpgsql as $f$
declare
  who uuid;
  v_task uuid;
  a uuid := (select v from ctx where k = 'p30_app_a');
  b uuid := (select v from ctx where k = 'p30_item_b');
  inbox uuid := (select v from ctx where k = 'p30_inbox');
  m uuid := '00000000-0000-4000-8000-00000000c030';
begin
  foreach who in array array['00000000-0000-4000-8000-0000000000b3'::uuid, '00000000-0000-4000-8000-0000000000b4'::uuid] loop
    v_task := case who when '00000000-0000-4000-8000-0000000000b3' then '00000000-0000-4000-8000-00000000a0b3'::uuid
                       else '00000000-0000-4000-8000-00000000a0b4'::uuid end;
    perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    insert into p30_result values
      (p_phase, who, 'capture_meeting_discussion_item',
       pg_temp.p30_try($q$select public.capture_meeting_discussion_item('running_order', '9399', 'probe', null, null, null, null, null)$q$)),
      (p_phase, who, 'attach_meeting_discussion_item',
       pg_temp.p30_try(format('select public.attach_meeting_discussion_item(%L, %L)', m, inbox))),
      (p_phase, who, 'save_meeting_discussion_update',
       pg_temp.p30_try(format('select public.save_meeting_discussion_update(%L, %L, null, null, false, false)', a, 'probe update'))),
      (p_phase, who, 'resolve_meeting_discussion_item',
       pg_temp.p30_try(format('select public.resolve_meeting_discussion_item(%L, %L)', a, 'probe resolve'))),
      (p_phase, who, 'resolve_meeting_discussion_item (unknown id)',
       pg_temp.p30_try(format('select public.resolve_meeting_discussion_item(%L, %L)', gen_random_uuid(), 'probe resolve'))),
      (p_phase, who, 'reopen_meeting_discussion_item',
       pg_temp.p30_try(format('select public.reopen_meeting_discussion_item(%L, %L)', b, 'probe reopen'))),
      (p_phase, who, 'link_meeting_discussion_task',
       pg_temp.p30_try(format('select public.link_meeting_discussion_task(%L, %L)', a, v_task))),
      (p_phase, who, 'ensure_meeting_discussion_order',
       pg_temp.p30_try(format('select public.ensure_meeting_discussion_order(%L)', a))),
      (p_phase, who, 'add_meeting_discussion_evidence',
       pg_temp.p30_try(format('select public.add_meeting_discussion_evidence(%L, %L, %L)', a,
         '00000000-0000-4000-8000-000000000000/33333333-3333-4333-8333-333333333333.jpg', 'probe.jpg'))),
      (p_phase, who, 'carry_forward_meeting_discussions',
       pg_temp.p30_try(format('select public.carry_forward_meeting_discussions(%L)', m))),
      (p_phase, who, 'list_meeting_discussion_inbox',
       pg_temp.p30_try('select * from public.list_meeting_discussion_inbox()')),
      (p_phase, who, 'can_view_discussion_item',
       public.can_view_discussion_item(inbox, who)::text),
      (p_phase, who, 'can_view_discussion_event',
       public.can_view_discussion_event(inbox, null, 'captured', now(), who)::text),
      (p_phase, who, 'read meeting_discussion_items',
       (select count(*) from public.meeting_discussion_items)::text),
      (p_phase, who, 'read meeting_discussion_appearances',
       (select count(*) from public.meeting_discussion_appearances)::text),
      (p_phase, who, 'read meeting_discussion_events',
       (select count(*) from public.meeting_discussion_events)::text),
      (p_phase, who, 'read meeting_order_evidence',
       (select count(*) from public.meeting_order_evidence)::text);
    execute 'reset role';
  end loop;
end $f$;

select pg_temp.p30_probe('no_access');

delete from public.employee_permission_overrides
where user_id in ('00000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-0000000000b4')
  and allowed = false;

select pg_temp.p30_probe('with_access');

do $$
declare v_bad text;
begin
  -- Not vacuous: there is data to hide, and every enumerated function was probed.
  if (select count(*) from public.meeting_discussion_items) = 0
     or (select count(*) from public.meeting_discussion_events) = 0
     or (select count(*) from public.meeting_order_evidence) = 0 then
    raise exception 'ASSERT 30: nothing to hide, so the empty reads prove nothing';
  end if;
  select string_agg(e.fn, ', ') into v_bad from rpc_expected e
  where not exists (select 1 from p30_result r where r.fn = e.fn);
  if v_bad is not null then raise exception 'ASSERT 30: not probed: %', v_bad; end if;

  -- Without access: refused, false, nothing.
  select string_agg(who || ' ' || fn || '=' || outcome, '; ') into v_bad from p30_result
  where phase = 'no_access' and case
    when fn like 'read %' then outcome <> '0'
    when fn like 'can_view_%' then outcome <> 'false'
    else outcome <> 'MEETING_FORBIDDEN'
  end;
  if v_bad is not null then raise exception 'ASSERT 30: without Meetings access: %', v_bad; end if;

  -- With access restored: not refused for access, and the predicates see the Inbox issue.
  select string_agg(who || ' ' || fn || '=' || outcome, '; ') into v_bad from p30_result
  where phase = 'with_access' and case
    when fn like 'read %' then false
    when fn like 'can_view_%' then outcome <> 'true'
    when fn like '%(unknown id)' then outcome <> 'MEETING_DISCUSSION_MISSING'
    when fn = 'add_meeting_discussion_evidence' then outcome = 'MEETING_FORBIDDEN'
    else outcome <> 'ALLOWED'
  end;
  if v_bad is not null then raise exception 'ASSERT 30: with Meetings access restored: %', v_bad; end if;

  raise notice 'PASS 30 without Meetings access every callable function refuses (lead and edit holder alike) and nothing is readable; with access restored they work';
  raise notice 'ALL ASSERTIONS PASSED';
end $$;

rollback;
