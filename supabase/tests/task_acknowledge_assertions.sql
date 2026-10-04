-- acknowledge_task() assertions
-- ===========================================================================
-- Covers 20270303000000_task_acknowledge_rpc.sql on top of the Task Management review path
-- (20260832 status value, 20260833 review RPC, 20260834 enforcement).
--
-- WHAT IT PROVES
--   §1  the assignee's Acknowledge writes the stamp, moves the task to Working, and leaves EXACTLY TWO history
--       rows ('acknowledged' and 'status_changed' from the old status to working), both authored by the caller,
--       both written by the same call; the returned ids name those two rows
--   §2  every refusal — a non-assignee, the creator, a self task, a quotation request, an already-acknowledged
--       task, a finished task, a task in review, a missing task, no session — raises its own code and message
--       and changes NOTHING: no change to the task row, no activity row
--   §3  no notification is written; the grants are `authenticated` only, read from the ACL itself
--   §4  a FORCED history-insert failure (on the first row, and again on the second) rolls the task update back
--       (identical row, no history rows), and the identical call succeeds once the obstacle is removed
--   §5  a double press, one session after the other: one acknowledgement, two history rows, a clean refusal for
--       the second press
--   §6  the review path is untouched: a delegated task moving to Working is not a review move, and a bare
--       completion of a delegated task is still refused
--
-- Runs in ONE transaction that ends in ROLLBACK; every fixture is discarded.
--
-- ⚠ NOT RUN AGAINST PRODUCTION. This script writes rows. Run it only against a database that is positively
--   identified as non-production and that has the four migrations above.
--
-- PREREQUISITES: psql as a role that may set session GUCs. Replace the three user ids in the Config block;
-- all must exist in public.users and be distinct.
--
-- On success it prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

-- ── 0. The migrations must be applied ───────────────────────────────────────
do $$
begin
  assert exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'acknowledge_task'
       and pg_get_function_identity_arguments(p.oid) = 'p_task_id uuid'),
    '20270303000000_task_acknowledge_rpc.sql is NOT applied: public.acknowledge_task does not exist with the expected signature';
  assert exists (select 1 from pg_trigger where tgrelid = 'public.tasks'::regclass
                  and tgname = 'tasks_enforce_review_path' and not tgisinternal),
    '20260834000000 is NOT applied: the review-path trigger is missing, so §6 would prove nothing';
end $$;

-- ── Config: the ONLY lines a tester edits ───────────────────────────────────
do $$
begin
  perform set_config('test.creator_id',  '11111111-1111-1111-1111-111111111111', true); -- REPLACE
  perform set_config('test.assignee_id', '22222222-2222-2222-2222-222222222222', true); -- REPLACE
  perform set_config('test.outsider_id', '33333333-3333-3333-3333-333333333333', true); -- REPLACE
  perform set_config('t.main',    gen_random_uuid()::text, true); -- delegated, pending, NOT acknowledged
  perform set_config('t.waiting', gen_random_uuid()::text, true); -- delegated, waiting, NOT acknowledged
  perform set_config('t.self',    gen_random_uuid()::text, true); -- self task
  perform set_config('t.quote',   gen_random_uuid()::text, true); -- quotation request
  perform set_config('t.acked',   gen_random_uuid()::text, true); -- delegated, already acknowledged
  perform set_config('t.done',    gen_random_uuid()::text, true); -- delegated, completed, never acknowledged
  perform set_config('t.cancel',  gen_random_uuid()::text, true); -- delegated, cancelled
  perform set_config('t.review',  gen_random_uuid()::text, true); -- delegated, pending_approval
  perform set_config('t.nobody',  gen_random_uuid()::text, true); -- an id that is no task
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

create or replace function pg_temp.ack_rows(p_task text) returns bigint
language sql as $$
  select count(*) from public.task_activity_log where task_id = p_task::uuid and action in ('acknowledged', 'status_changed')
$$;

create or replace function pg_temp.row_of(p_task text) returns jsonb
language sql as $$ select to_jsonb(x) from public.tasks x where x.id = p_task::uuid $$;

-- ── Fixtures (written with no identity, so the trigger does not police them) ─
do $$ begin perform pg_temp.act_as(null); end $$;

insert into public.tasks (id, title, status, priority, created_by, assigned_to, task_type, acknowledged_at, team)
select v.id::uuid, v.title, v.status::public.task_status, 'medium',
       v.created_by::uuid, current_setting('test.assignee_id')::uuid, v.task_type, v.ack,
       (select u.team from public.users u where u.id = current_setting('test.assignee_id')::uuid)
  from (values
    (current_setting('t.main'),    'ASSERT main',      'pending',          current_setting('test.creator_id'),  'general',           null::timestamptz),
    (current_setting('t.waiting'), 'ASSERT waiting',   'waiting',          current_setting('test.creator_id'),  'general',           null),
    (current_setting('t.self'),    'ASSERT self',      'pending',          current_setting('test.assignee_id'), 'general',           null),
    (current_setting('t.quote'),   'ASSERT quotation', 'pending',          current_setting('test.creator_id'),  'quotation_request', null),
    (current_setting('t.acked'),   'ASSERT acked',     'working',          current_setting('test.creator_id'),  'general',           now() - interval '1 day'),
    (current_setting('t.done'),    'ASSERT finished',  'completed',        current_setting('test.creator_id'),  'general',           null),
    (current_setting('t.cancel'),  'ASSERT cancelled', 'cancelled',        current_setting('test.creator_id'),  'general',           null),
    (current_setting('t.review'),  'ASSERT in review', 'pending_approval', current_setting('test.creator_id'),  'general',           null)
  ) as v(id, title, status, created_by, task_type, ack);

-- ── 1. The assignee's Acknowledge: one transaction, two history rows ─────────
do $$
declare
  r jsonb; v_ack public.task_activity_log%rowtype; v_st public.task_activity_log%rowtype;
  t text := current_setting('t.main'); v_row public.tasks%rowtype; n_notif_before bigint;
begin
  select count(*) into n_notif_before from public.notifications;
  perform pg_temp.act_as(current_setting('test.assignee_id'));
  assert pg_temp.ack_rows(t) = 0, 'fixture starts with no history';

  r := public.acknowledge_task(t::uuid);

  assert r->>'status' = 'working' and r->>'from_status' = 'pending', 'returned status / from_status';
  assert (r->>'acknowledged_at') is not null and (r->>'last_update_at') is not null, 'returned timestamps';
  select * into v_row from public.tasks where id = t::uuid;
  assert v_row.status::text = 'working', 'the task is Working';
  assert v_row.acknowledged_at is not null, 'the task is stamped acknowledged';
  assert v_row.acknowledged_at = (r->>'acknowledged_at')::timestamptz
     and v_row.last_update_at = (r->>'last_update_at')::timestamptz, 'the returned state IS the saved state';
  assert pg_temp.ack_rows(t) = 2, 'EXACTLY two history rows for one acknowledgement';

  select * into v_ack from public.task_activity_log where id = (r->>'acknowledged_log_id')::uuid;
  assert v_ack.task_id = t::uuid and v_ack.actor_id = current_setting('test.assignee_id')::uuid
     and v_ack.action = 'acknowledged' and v_ack.note is null and v_ack.from_status is null and v_ack.to_status is null,
    'acknowledged_log_id names the acknowledged row, authored by the caller';
  select * into v_st from public.task_activity_log where id = (r->>'status_changed_log_id')::uuid;
  assert v_st.task_id = t::uuid and v_st.actor_id = current_setting('test.assignee_id')::uuid
     and v_st.action = 'status_changed' and v_st.note is null
     and v_st.from_status::text = 'pending' and v_st.to_status::text = 'working',
    'status_changed_log_id names the pending -> working row, authored by the caller';

  -- The status the task HELD is what the history records, for any acknowledgeable status.
  r := public.acknowledge_task(current_setting('t.waiting')::uuid);
  select * into v_st from public.task_activity_log where id = (r->>'status_changed_log_id')::uuid;
  assert r->>'from_status' = 'waiting' and v_st.from_status::text = 'waiting' and v_st.to_status::text = 'working',
    'a waiting task acknowledges to working, from waiting';

  assert (select count(*) from public.notifications) = n_notif_before, 'no notification is written by the function';
end $$;

-- ── 2. Every refusal changes nothing ─────────────────────────────────────────
do $$
declare
  before_rows jsonb; after_rows jsonb;
  ids text[] := array[current_setting('t.main'), current_setting('t.self'), current_setting('t.quote'),
                      current_setting('t.acked'), current_setting('t.done'), current_setting('t.cancel'), current_setting('t.review')];
  n_log_before bigint; n_log_after bigint;
begin
  perform pg_temp.act_as(null);
  select jsonb_agg(to_jsonb(x) order by x.id) into before_rows from public.tasks x where x.id::text = any (ids);
  select count(*) into n_log_before from public.task_activity_log;

  -- No session.
  perform pg_temp.refused(format('select public.acknowledge_task(%L)', current_setting('t.self')), '28000', 'Authentication required');

  -- A task that is not there.
  perform pg_temp.act_as(current_setting('test.assignee_id'));
  perform pg_temp.refused(format('select public.acknowledge_task(%L)', current_setting('t.nobody')), 'P0002', 'TASK_NOT_FOUND:');

  -- t.main was acknowledged in §1; the same press again is a clean refusal, not a second pair of rows.
  perform pg_temp.refused(format('select public.acknowledge_task(%L)', current_setting('t.main')), '55000', 'TASK_ALREADY_ACKNOWLEDGED:');
  perform pg_temp.refused(format('select public.acknowledge_task(%L)', current_setting('t.acked')), '55000', 'TASK_ALREADY_ACKNOWLEDGED:');

  -- Not the assignee: the creator, an admin-like outsider.
  perform pg_temp.act_as(current_setting('test.creator_id'));
  perform pg_temp.refused(format('select public.acknowledge_task(%L)', current_setting('t.done')), '42501', 'TASK_ACK_FORBIDDEN:');
  perform pg_temp.refused(format('select public.acknowledge_task(%L)', current_setting('t.review')), '42501', 'TASK_ACK_FORBIDDEN:');
  perform pg_temp.act_as(current_setting('test.outsider_id'));
  perform pg_temp.refused(format('select public.acknowledge_task(%L)', current_setting('t.quote')), '42501', 'TASK_ACK_FORBIDDEN:');

  -- The assignee, but not an acknowledgeable task.
  perform pg_temp.act_as(current_setting('test.assignee_id'));
  perform pg_temp.refused(format('select public.acknowledge_task(%L)', current_setting('t.self')),  '42501', 'TASK_ACK_NOT_APPLICABLE:');
  perform pg_temp.refused(format('select public.acknowledge_task(%L)', current_setting('t.quote')), '42501', 'TASK_ACK_NOT_APPLICABLE:');
  perform pg_temp.refused(format('select public.acknowledge_task(%L)', current_setting('t.done')),   '55000', 'TASK_ACK_WRONG_STATUS:');
  perform pg_temp.refused(format('select public.acknowledge_task(%L)', current_setting('t.cancel')), '55000', 'TASK_ACK_WRONG_STATUS:');
  perform pg_temp.refused(format('select public.acknowledge_task(%L)', current_setting('t.review')), '55000', 'TASK_ACK_WRONG_STATUS:');

  perform pg_temp.act_as(null);
  select jsonb_agg(to_jsonb(x) order by x.id) into after_rows from public.tasks x where x.id::text = any (ids);
  select count(*) into n_log_after from public.task_activity_log;
  -- t.main was changed by §1 (not by a refusal); compare everything else, and the log is unchanged since §1.
  assert (select jsonb_agg(e order by e->>'id') from jsonb_array_elements(before_rows) e where e->>'id' <> current_setting('t.main'))
       = (select jsonb_agg(e order by e->>'id') from jsonb_array_elements(after_rows)  e where e->>'id' <> current_setting('t.main')),
    'no refused call changed a task row';
  assert (before_rows -> 0) is not null and n_log_after = n_log_before, 'no refused call wrote a history row';
end $$;

-- ── 3. Grants: authenticated only, read from the ACL ─────────────────────────
do $$
begin
  assert (select proacl is not null from pg_proc where proname = 'acknowledge_task'),
    'the ACL must be explicit (a null ACL means PUBLIC may still execute)';
  assert not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) a
     where p.proname = 'acknowledge_task' and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
    'EXECUTE must be explicitly REVOKED from PUBLIC';
  assert not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) a
     where p.proname = 'acknowledge_task' and a.grantee = 'anon'::regrole::oid and a.privilege_type = 'EXECUTE'),
    'EXECUTE must be explicitly REVOKED from anon';
  assert exists (
    select 1 from pg_proc p, aclexplode(p.proacl) a
     where p.proname = 'acknowledge_task' and a.grantee = 'authenticated'::regrole::oid and a.privilege_type = 'EXECUTE'),
    'EXECUTE must be explicitly GRANTED to authenticated';
  assert has_function_privilege('authenticated', 'public.acknowledge_task(uuid)', 'execute'), '`authenticated` can execute';
  assert not has_function_privilege('anon', 'public.acknowledge_task(uuid)', 'execute'), '`anon` must NOT be able to execute';
  assert (select prosecdef from pg_proc where proname = 'acknowledge_task'), 'it is SECURITY DEFINER';
  assert (select 'search_path=public, pg_temp' = any (proconfig) from pg_proc where proname = 'acknowledge_task'),
    'its search_path is pinned to public, pg_temp';
end $$;

-- ── 4. A forced history-insert failure rolls the task update back ───────────
-- If either history row cannot be written, the acknowledgement must not survive. A trigger that refuses ONE kind of
-- history row on ONE task stands in for any failure of that insert (constraint, lock timeout, full disk). The failing
-- call runs inside a sub-transaction (the exception handler), exactly as a failed RPC rolls back its own transaction.
-- It is run twice: failing the FIRST row, then failing the SECOND (so the first row has already been written when the
-- second fails — it must be rolled back with the task).

do $$
declare
  t           text := current_setting('t.main');
  v_before    jsonb;
  v_after     jsonb;
  rows_before bigint;
  v_msg       text;
  r           jsonb;
  v_action    text;
begin
  -- A second unacknowledged task to attack, so §1's state is not disturbed.
  perform pg_temp.act_as(null);
  t := gen_random_uuid()::text;
  insert into public.tasks (id, title, status, priority, created_by, assigned_to, task_type, team)
  values (t::uuid, 'ASSERT forced failure', 'pending', 'medium',
          current_setting('test.creator_id')::uuid, current_setting('test.assignee_id')::uuid, 'general',
          (select u.team from public.users u where u.id = current_setting('test.assignee_id')::uuid));

  perform set_config('t.fail_task', t, true);
  create or replace function public.zz_force_history_failure() returns trigger language plpgsql as $f$
  begin
    if new.action = current_setting('zz.fail_action', true) then
      raise exception 'ZZ_FORCED_HISTORY_FAILURE' using errcode = 'XX000';
    end if;
    return new;
  end $f$;
  create trigger zz_force_history_failure before insert on public.task_activity_log
    for each row when (new.task_id = current_setting('t.fail_task')::uuid)
    execute function public.zz_force_history_failure();

  foreach v_action in array array['acknowledged', 'status_changed'] loop
    perform set_config('zz.fail_action', v_action, true);
    perform pg_temp.act_as(null);
    v_before    := pg_temp.row_of(t);
    rows_before := pg_temp.ack_rows(t);

    perform pg_temp.act_as(current_setting('test.assignee_id'));
    begin
      perform public.acknowledge_task(t::uuid);
      assert false, 'the call must fail when its ' || v_action || ' history insert fails';
    exception when others then
      get stacked diagnostics v_msg = message_text;
      assert v_msg = 'ZZ_FORCED_HISTORY_FAILURE', 'unexpected failure: ' || v_msg;
    end;

    perform pg_temp.act_as(null);
    v_after := pg_temp.row_of(t);
    assert v_after = v_before, 'the task row must be EXACTLY as it was (failed ' || v_action || '): the update rolled back';
    assert pg_temp.ack_rows(t) = rows_before, 'and no history row exists (failed ' || v_action || ')';
  end loop;

  -- Positive control: remove the obstacle and the identical call succeeds, so the failures above were the trigger.
  perform pg_temp.act_as(null);
  drop trigger zz_force_history_failure on public.task_activity_log;
  drop function public.zz_force_history_failure();
  perform pg_temp.act_as(current_setting('test.assignee_id'));
  r := public.acknowledge_task(t::uuid);
  assert r->>'status' = 'working', 'the same call succeeds once the history inserts can succeed';
  assert pg_temp.ack_rows(t) = rows_before + 2, 'with exactly two rows';
end $$;

-- ── 5. Double press, one session after the other ─────────────────────────────
-- Two presses of Acknowledge (or a retry of a request whose answer was lost): one acknowledgement, two history rows,
-- and the second call is a clean refusal that the client reconciles by reading. The two-connection version of this is a
-- manual race (two psql sessions on the same row); the row lock makes the second wait and then find it acknowledged.

do $$
declare t text := gen_random_uuid()::text; r jsonb; v_at timestamptz;
begin
  perform pg_temp.act_as(null);
  insert into public.tasks (id, title, status, priority, created_by, assigned_to, task_type, team)
  values (t::uuid, 'ASSERT double press', 'pending', 'medium',
          current_setting('test.creator_id')::uuid, current_setting('test.assignee_id')::uuid, 'general',
          (select u.team from public.users u where u.id = current_setting('test.assignee_id')::uuid));
  perform pg_temp.act_as(current_setting('test.assignee_id'));
  r := public.acknowledge_task(t::uuid);
  v_at := (r->>'acknowledged_at')::timestamptz;
  perform pg_temp.refused(format('select public.acknowledge_task(%L)', t), '55000', 'TASK_ALREADY_ACKNOWLEDGED:');
  assert pg_temp.ack_rows(t) = 2, 'exactly TWO history rows for two presses';
  assert (select acknowledged_at from public.tasks where id = t::uuid) = v_at, 'the first acknowledgement stamp is kept';
end $$;

-- ── 6. The review path is untouched ──────────────────────────────────────────
-- Acknowledging a DELEGATED task moves it to Working, which tasks_enforce_review_path allows (§1 already did it as a
-- non-superuser caller identity). A delegated task is still not completable by a bare UPDATE from the assignee.

do $$
declare t text := gen_random_uuid()::text;
begin
  perform pg_temp.act_as(null);
  insert into public.tasks (id, title, status, priority, created_by, assigned_to, task_type, team)
  values (t::uuid, 'ASSERT review path', 'pending', 'medium',
          current_setting('test.creator_id')::uuid, current_setting('test.assignee_id')::uuid, 'general',
          (select u.team from public.users u where u.id = current_setting('test.assignee_id')::uuid));
  perform pg_temp.act_as(current_setting('test.assignee_id'));
  perform public.acknowledge_task(t::uuid);
  perform pg_temp.refused(
    format('update public.tasks set status = ''completed'' where id = %L', t), '42501', 'TASK_APPROVAL_REQUIRED:');
  assert (select status::text from public.tasks where id = t::uuid) = 'working', 'still Working after the refused completion';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
