-- change_task_status() assertions
-- ===========================================================================
-- Covers 20270226000000_task_change_status_rpc.sql on top of the Task Management
-- review path (20260832 status value, 20260833 review RPC, 20260834 enforcement).
--
-- WHAT IT PROVES
--   §1  the assignee's ordinary changes work and leave EXACTLY ONE history row each,
--       written by the same transaction (actor, from, to, note, attachment)
--   §2  the stale-field rules: a blocker and a waiting-on subject do not outlive their state
--   §3  every refusal — a non-assignee, a delegated completion, `cancelled`,
--       `pending_approval`, an unacknowledged task, a repeat, a finished task, a bad
--       status, missing waiting detail, an over-long reason — raises its own code and
--       message and changes NOTHING: no row on the task, no activity row
--   §4  the review path is untouched: a delegated task still cannot be completed
--       directly, and the trigger does not interfere with the allowed moves
--   §5  no notification is written, and the grants are `authenticated` only
--
-- Runs in ONE transaction that ends in ROLLBACK; every fixture is discarded.
--
-- ⚠ NOT RUN AGAINST PRODUCTION. This script writes rows. Run it only against a database
--   that is positively identified as non-production and that has the four migrations above.
--
-- PREREQUISITES: psql as a role that may set session GUCs. Replace the three user ids in
-- the Config block; all must exist in public.users and be distinct.
--
-- On success it prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

-- ── 0. The migrations must be applied ───────────────────────────────────────
do $$
begin
  assert exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'change_task_status'
       and pg_get_function_identity_arguments(p.oid)
           = 'p_task_id uuid, p_status text, p_reason text, p_attachment_url text, p_waiting_on_type text, p_waiting_on_user_id uuid, p_waiting_on_text text'),
    '20270226000000_task_change_status_rpc.sql is NOT applied: public.change_task_status does not exist with the expected signature';
  assert exists (select 1 from pg_trigger where tgrelid = 'public.tasks'::regclass
                  and tgname = 'tasks_enforce_review_path' and not tgisinternal),
    '20260834000000 is NOT applied: the review-path trigger is missing, so §4 would prove nothing';
end $$;

-- ── Config: the ONLY lines a tester edits ───────────────────────────────────
do $$
begin
  perform set_config('test.creator_id',  '11111111-1111-1111-1111-111111111111', true); -- REPLACE
  perform set_config('test.assignee_id', '22222222-2222-2222-2222-222222222222', true); -- REPLACE
  perform set_config('test.outsider_id', '33333333-3333-3333-3333-333333333333', true); -- REPLACE
  perform set_config('t.deleg',   gen_random_uuid()::text, true); -- delegated, acknowledged
  perform set_config('t.unack',   gen_random_uuid()::text, true); -- delegated, NOT acknowledged
  perform set_config('t.self',    gen_random_uuid()::text, true); -- self task
  perform set_config('t.quote',   gen_random_uuid()::text, true); -- quotation request
  perform set_config('t.done',    gen_random_uuid()::text, true); -- already completed (self)
end $$;

do $$
begin
  assert (select count(*) from public.users
           where id in (current_setting('test.creator_id')::uuid,
                        current_setting('test.assignee_id')::uuid,
                        current_setting('test.outsider_id')::uuid)) = 3,
    'the three configured user ids must all exist and be distinct — replace the placeholders';
end $$;

create or replace function pg_temp.act_as(p_uid text) returns void
language plpgsql as $$
begin
  if p_uid is null then
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
  else
    perform set_config('request.jwt.claim.sub', p_uid, true);
    perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  end if;
end $$;

-- Runs p_sql, which MUST be refused with p_state and a message beginning p_prefix.
create or replace function pg_temp.refused(p_sql text, p_state text, p_prefix text) returns void
language plpgsql as $$
declare v_state text; v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    assert v_state = p_state, format('expected SQLSTATE %s, got %s (%s) for: %s', p_state, v_state, v_msg, p_sql);
    assert v_msg like p_prefix || '%', format('expected message starting %L, got %L', p_prefix, v_msg);
    return;
  end;
  raise exception 'expected a refusal but the call succeeded: %', p_sql;
end $$;

create or replace function pg_temp.rows_for(p_task text) returns bigint
language sql as $$
  select count(*) from public.task_activity_log where task_id = p_task::uuid and action = 'status_changed'
$$;

create or replace function pg_temp.status_of(p_task text) returns text
language sql as $$ select status::text from public.tasks where id = p_task::uuid $$;

-- ── Fixtures (written with no identity, so the trigger does not police them) ─
do $$ begin perform pg_temp.act_as(null); end $$;

insert into public.tasks (id, title, status, priority, created_by, assigned_to, task_type, acknowledged_at, team)
select v.id::uuid, v.title, v.status::public.task_status, 'medium',
       v.created_by::uuid, current_setting('test.assignee_id')::uuid, v.task_type, v.ack,
       (select u.team from public.users u where u.id = current_setting('test.assignee_id')::uuid)
  from (values
    (current_setting('t.deleg'), 'ASSERT delegated',  'working',   current_setting('test.creator_id'),  'general',           now()),
    (current_setting('t.unack'), 'ASSERT unacked',    'pending',   current_setting('test.creator_id'),  'general',           null::timestamptz),
    (current_setting('t.self'),  'ASSERT self',       'working',   current_setting('test.assignee_id'), 'general',           null),
    (current_setting('t.quote'), 'ASSERT quotation',  'working',   current_setting('test.creator_id'),  'quotation_request', null),
    (current_setting('t.done'),  'ASSERT finished',   'completed', current_setting('test.assignee_id'), 'general',           null)
  ) as v(id, title, status, created_by, task_type, ack);

-- ── 1. The assignee's changes: one transaction, one history row ──────────────
do $$
declare r jsonb; v_log public.task_activity_log%rowtype; n_before bigint;
begin
  perform pg_temp.act_as(current_setting('test.assignee_id'));

  -- Mark Complete on a SELF task: status, completed_at, one row, in one call.
  n_before := pg_temp.rows_for(current_setting('t.self'));
  r := public.change_task_status(current_setting('t.self')::uuid, 'completed', null, 'ref://proof.pdf');
  assert r->>'status' = 'completed' and r->>'from_status' = 'working', 'self completion: returned status/from';
  assert (r->>'completed_at') is not null, 'completion stamps completed_at';
  assert pg_temp.status_of(current_setting('t.self')) = 'completed', 'the task row changed';
  assert pg_temp.rows_for(current_setting('t.self')) = n_before + 1, 'EXACTLY one history row for one change';
  select * into v_log from public.task_activity_log where id = (r->>'activity_log_id')::uuid;
  assert v_log.task_id = current_setting('t.self')::uuid
     and v_log.actor_id = current_setting('test.assignee_id')::uuid
     and v_log.action = 'status_changed'
     and v_log.from_status::text = 'working' and v_log.to_status::text = 'completed'
     and v_log.attachment_url = 'ref://proof.pdf',
    'the returned activity_log_id names the one row this call wrote, authored by the caller';

  -- A quotation request keeps its direct completion.
  r := public.change_task_status(current_setting('t.quote')::uuid, 'completed');
  assert r->>'status' = 'completed', 'a quotation request can still be completed by its assignee';

  -- An acknowledged delegated task: ordinary moves are allowed.
  r := public.change_task_status(current_setting('t.deleg')::uuid, 'started');
  assert r->>'status' = 'started', 'delegated: working -> started';
  r := public.change_task_status(current_setting('t.deleg')::uuid, 'working');
  assert r->>'status' = 'working', 'delegated: started -> working';
end $$;

-- ── 2. Stale-field rules ─────────────────────────────────────────────────────
do $$
declare r jsonb; t text := current_setting('t.deleg');
begin
  perform pg_temp.act_as(current_setting('test.assignee_id'));

  r := public.change_task_status(t::uuid, 'waiting', null, null, 'team_member', current_setting('test.creator_id')::uuid, 'ignored text');
  assert r->>'waiting_on_type' = 'team_member' and r->>'waiting_on_user_id' = current_setting('test.creator_id')
     and (r->>'waiting_on_text') is null, 'waiting on a team member stores the user and no text';

  r := public.change_task_status(t::uuid, 'blocked', 'ASSERT blocker');
  assert r->>'blocker_reason' = 'ASSERT blocker', 'blocked stores its reason';
  assert (r->>'waiting_on_type') is null and (r->>'waiting_on_user_id') is null and (r->>'waiting_on_text') is null,
    'leaving waiting clears the whole waiting-on subject';
  assert (select note from public.task_activity_log where id = (r->>'activity_log_id')::uuid) = 'ASSERT blocker',
    'the reason is the history note';

  r := public.change_task_status(t::uuid, 'waiting', null, null, 'external', null, '  Supplier in Pune  ');
  assert r->>'waiting_on_type' = 'external' and r->>'waiting_on_text' = 'Supplier in Pune' and (r->>'waiting_on_user_id') is null,
    'waiting on someone outside stores trimmed text and no user';
  assert (r->>'blocker_reason') is null, 'leaving blocked clears the blocker';

  r := public.change_task_status(t::uuid, 'working');
  assert (r->>'waiting_on_type') is null and (r->>'waiting_on_text') is null, 'back to working clears waiting';
end $$;

-- ── 3. Every refusal changes nothing ─────────────────────────────────────────
do $$
declare
  t_deleg text := current_setting('t.deleg'); t_unack text := current_setting('t.unack');
  t_self  text := current_setting('t.self');  t_done  text := current_setting('t.done');
  rows_deleg bigint; rows_unack bigint; status_deleg text;
begin
  perform pg_temp.act_as(current_setting('test.assignee_id'));
  rows_deleg := pg_temp.rows_for(t_deleg); status_deleg := pg_temp.status_of(t_deleg); rows_unack := pg_temp.rows_for(t_unack);

  perform pg_temp.refused(format('select public.change_task_status(%L, ''completed'')', t_deleg),
    '42501', 'TASK_STATUS_USE_REVIEW:');
  perform pg_temp.refused(format('select public.change_task_status(%L, ''pending_approval'')', t_deleg),
    '22023', 'TASK_STATUS_NOT_HERE:');
  perform pg_temp.refused(format('select public.change_task_status(%L, ''cancelled'')', t_deleg),
    '22023', 'TASK_STATUS_NOT_HERE:');
  perform pg_temp.refused(format('select public.change_task_status(%L, ''archived'')', t_deleg),
    '22023', 'TASK_STATUS_INVALID:');
  perform pg_temp.refused(format('select public.change_task_status(%L, null)', t_deleg),
    '22023', 'TASK_STATUS_INVALID:');
  perform pg_temp.refused(format('select public.change_task_status(%L, ''working'')', t_deleg),
    '55000', 'TASK_STATUS_UNCHANGED:');
  perform pg_temp.refused(format('select public.change_task_status(%L, ''waiting'')', t_deleg),
    '22023', 'TASK_WAITING_DETAIL_REQUIRED:');
  perform pg_temp.refused(format('select public.change_task_status(%L, ''waiting'', null, null, ''team_member'', null, null)', t_deleg),
    '22023', 'TASK_WAITING_DETAIL_REQUIRED:');
  perform pg_temp.refused(format('select public.change_task_status(%L, ''waiting'', null, null, ''external'', null, ''   '')', t_deleg),
    '22023', 'TASK_WAITING_DETAIL_REQUIRED:');
  perform pg_temp.refused(format('select public.change_task_status(%L, ''waiting'', null, null, ''external'', null, %L)', t_deleg, repeat('x', 501)),
    '22023', 'TASK_WAITING_DETAIL_TOO_LONG:');
  perform pg_temp.refused(format('select public.change_task_status(%L, ''blocked'', %L)', t_deleg, repeat('x', 1001)),
    '22023', 'TASK_REASON_TOO_LONG:');
  perform pg_temp.refused(format('select public.change_task_status(%L, ''working'')', t_unack),
    '42501', 'TASK_NOT_ACKNOWLEDGED:');
  perform pg_temp.refused(format('select public.change_task_status(%L, ''working'')', t_done),
    '55000', 'TASK_STATUS_FINISHED:');
  perform pg_temp.refused(format('select public.change_task_status(%L, ''working'')', t_self),
    '55000', 'TASK_STATUS_FINISHED:');
  perform pg_temp.refused(format('select public.change_task_status(%L, ''working'')', gen_random_uuid()),
    'P0002', 'TASK_NOT_FOUND:');

  assert pg_temp.rows_for(t_deleg) = rows_deleg, 'refusals wrote no activity row on the delegated task';
  assert pg_temp.status_of(t_deleg) = status_deleg, 'refusals changed no status';
  assert pg_temp.rows_for(t_unack) = rows_unack, 'the unacknowledged task is untouched';

  -- Not the assignee: the creator, an outsider, and nobody at all.
  perform pg_temp.act_as(current_setting('test.creator_id'));
  perform pg_temp.refused(format('select public.change_task_status(%L, ''blocked'')', t_deleg), '42501', 'TASK_STATUS_FORBIDDEN:');
  perform pg_temp.act_as(current_setting('test.outsider_id'));
  perform pg_temp.refused(format('select public.change_task_status(%L, ''blocked'')', t_deleg), '42501', 'TASK_STATUS_FORBIDDEN:');
  perform pg_temp.act_as(null);
  perform pg_temp.refused(format('select public.change_task_status(%L, ''blocked'')', t_deleg), '28000', 'Authentication required');

  assert pg_temp.rows_for(t_deleg) = rows_deleg and pg_temp.status_of(t_deleg) = status_deleg,
    'a non-assignee changed nothing';
end $$;

-- A task awaiting its creator's decision cannot change status through this door.
do $$
declare t text := current_setting('t.deleg'); r jsonb;
begin
  perform pg_temp.act_as(null);
  update public.tasks set status = 'pending_approval' where id = t::uuid;  -- identity-less = the trigger's service exemption
  perform pg_temp.act_as(current_setting('test.assignee_id'));
  perform pg_temp.refused(format('select public.change_task_status(%L, ''working'')', t), '55000', 'TASK_STATUS_IN_REVIEW:');
  perform pg_temp.act_as(null);
  update public.tasks set status = 'working' where id = t::uuid;
end $$;

-- ── 4. The review path is untouched ──────────────────────────────────────────
do $$
declare t text := current_setting('t.deleg'); v_msg text;
begin
  perform pg_temp.act_as(current_setting('test.assignee_id'));
  begin
    update public.tasks set status = 'completed' where id = t::uuid;
    assert false, 'a bare UPDATE must still be unable to complete a delegated task';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'TASK_APPROVAL_REQUIRED:%', 'unexpected refusal: ' || v_msg;
  end;
  -- and the review function is still the door for it
  assert exists (select 1 from pg_proc where proname = 'transition_task_review'),
    'transition_task_review is still there';
end $$;

-- ── 5. No notification, and the grants ───────────────────────────────────────
do $$
declare n_before bigint; n_after bigint;
begin
  perform pg_temp.act_as(null);
  select count(*) into n_before from public.notifications;
  perform pg_temp.act_as(current_setting('test.assignee_id'));
  perform public.change_task_status(current_setting('t.deleg')::uuid, 'blocked', 'ASSERT no notify');
  perform pg_temp.act_as(null);
  select count(*) into n_after from public.notifications;
  assert n_after = n_before, 'change_task_status writes no notification — /api/notify-status-update still owns that';

  assert has_function_privilege('authenticated', 'public.change_task_status(uuid, text, text, text, text, uuid, text)', 'execute'),
    '`authenticated` must be able to execute change_task_status';
  assert not has_function_privilege('anon', 'public.change_task_status(uuid, text, text, text, text, uuid, text)', 'execute'),
    '`anon` must NOT be able to execute change_task_status';
  assert (select prosecdef from pg_proc where proname = 'change_task_status'), 'it is SECURITY DEFINER';
  assert (select 'search_path=public, pg_temp' = any (proconfig) from pg_proc where proname = 'change_task_status'),
    'its search_path is pinned to public, pg_temp';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
