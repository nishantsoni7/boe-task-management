-- notifications_event_once_idx assertions
-- ===========================================================================
-- Covers 20270301000000_notifications_event_idempotency.sql.
--
--   §1  the index: unique, partial (activity_log_id is not null), on (activity_log_id, user_id, type), in `public`
--   §2  the same event announced twice to the same person, same type -> refused by THIS index (SQLSTATE 23505, index named)
--   §3  what stays allowed: another recipient, another type, another event, and any number of unlinked notices
--   §4  removing the activity row (ON DELETE SET NULL) leaves the notice and takes it out of the index
--
-- Overlapping sends and the guard over pre-existing duplicates need two connections / a populated table, so they are
-- proved by the real-server run described on the PR, not here.
--
-- Runs in ONE transaction that ends in ROLLBACK. ⚠ NOT RUN AGAINST PRODUCTION: it writes rows. Run it only on a disposable
-- database that has public.users, public.tasks, public.task_activity_log, public.notifications and the migration applied.
-- Replace the two user ids below; both must exist in public.users and be distinct.

\set ON_ERROR_STOP on

begin;

do $$
begin
  assert exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'notifications_event_once_idx' and c.relkind = 'i'),
    '20270301000000_notifications_event_idempotency.sql is NOT applied: notifications_event_once_idx is missing';
  perform set_config('test.recipient_a', '11111111-1111-1111-1111-111111111111', true);  -- REPLACE
  perform set_config('test.recipient_b', '22222222-2222-2222-2222-222222222222', true);  -- REPLACE
  assert (select count(*) from public.users
           where id in (current_setting('test.recipient_a')::uuid, current_setting('test.recipient_b')::uuid)) = 2,
    'the two configured user ids must exist and be distinct — replace the placeholders';
end $$;

-- ── 1. the index ─────────────────────────────────────────────────────────────
do $$
declare v_def text;
begin
  select pg_get_indexdef(i.indexrelid) into v_def
    from pg_index i join pg_class c on c.oid = i.indexrelid
   where c.relname = 'notifications_event_once_idx';
  assert v_def like 'CREATE UNIQUE INDEX notifications_event_once_idx ON public.notifications USING btree (activity_log_id, user_id, type) WHERE (activity_log_id IS NOT NULL)',
    'unexpected index definition: ' || coalesce(v_def, '<none>');
end $$;

-- ── fixtures ─────────────────────────────────────────────────────────────────
create temp table _fx as
  select gen_random_uuid() as task_id, gen_random_uuid() as ev1, gen_random_uuid() as ev2,
         (select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'notification_type' order by e.enumsortorder limit 1) as type_a,
         (select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'notification_type' order by e.enumsortorder offset 1 limit 1) as type_b;

do $$
declare f record;
begin
  select * into f from _fx;
  assert f.type_a is not null and f.type_b is not null and f.type_a <> f.type_b, 'need two distinct notification types';
  insert into public.tasks (id, title, status, priority, created_by, assigned_to, task_type, team)
  values (f.task_id, 'ASSERT event key', 'working', 'medium',
          current_setting('test.recipient_a')::uuid, current_setting('test.recipient_b')::uuid, 'general',
          (select u.team from public.users u where u.id = current_setting('test.recipient_b')::uuid));
  insert into public.task_activity_log (id, task_id, actor_id, action, from_status, to_status)
  values (f.ev1, f.task_id, current_setting('test.recipient_a')::uuid, 'status_changed', 'working', 'waiting'),
         (f.ev2, f.task_id, current_setting('test.recipient_a')::uuid, 'status_changed', 'waiting', 'working');
end $$;

-- ── 2. the same event, the same person, the same type: once ──────────────────
do $$
declare f record; v_msg text; v_state text;
begin
  select * into f from _fx;
  execute format('insert into public.notifications (user_id, task_id, type, title, body, is_push_sent, activity_log_id) values (%L, %L, %L, %L, %L, true, %L)',
                 current_setting('test.recipient_b'), f.task_id, f.type_a, 'ASSERT first', 'b', f.ev1);
  begin
    execute format('insert into public.notifications (user_id, task_id, type, title, body, is_push_sent, activity_log_id) values (%L, %L, %L, %L, %L, true, %L)',
                   current_setting('test.recipient_b'), f.task_id, f.type_a, 'ASSERT repeat', 'b', f.ev1);
    assert false, 'the second announcement of the same event to the same person must be refused';
  exception when unique_violation then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    assert v_state = '23505' and v_msg like '%notifications_event_once_idx%', 'refused by the wrong constraint: ' || v_msg;
  end;
  assert (select count(*) from public.notifications where activity_log_id = f.ev1 and user_id = current_setting('test.recipient_b')::uuid) = 1,
    'exactly one notice for the event';
end $$;

-- ── 3. what stays allowed ────────────────────────────────────────────────────
do $$
declare f record;
begin
  select * into f from _fx;
  -- another recipient, the same event and type
  execute format('insert into public.notifications (user_id, task_id, type, title, body, is_push_sent, activity_log_id) values (%L, %L, %L, %L, %L, true, %L)',
                 current_setting('test.recipient_a'), f.task_id, f.type_a, 'ASSERT other person', 'a', f.ev1);
  -- the same person and event, another type
  execute format('insert into public.notifications (user_id, task_id, type, title, body, is_push_sent, activity_log_id) values (%L, %L, %L, %L, %L, true, %L)',
                 current_setting('test.recipient_b'), f.task_id, f.type_b, 'ASSERT other type', 'b', f.ev1);
  -- the same person and type, another event
  execute format('insert into public.notifications (user_id, task_id, type, title, body, is_push_sent, activity_log_id) values (%L, %L, %L, %L, %L, true, %L)',
                 current_setting('test.recipient_b'), f.task_id, f.type_a, 'ASSERT other event', 'b', f.ev2);
  -- unlinked notices are outside the index: any number of identical ones
  for i in 1..3 loop
    execute format('insert into public.notifications (user_id, task_id, type, title, body, is_push_sent, activity_log_id) values (%L, %L, %L, %L, %L, true, null)',
                   current_setting('test.recipient_b'), f.task_id, f.type_a, 'ASSERT unlinked', 'b');
  end loop;
  assert (select count(*) from public.notifications where task_id = f.task_id and activity_log_id is null) = 3, 'unlinked notices are unconstrained';
end $$;

-- ── 4. removing the event takes its notices out of the index, it does not collide ─
do $$
declare f record;
begin
  select * into f from _fx;
  delete from public.task_activity_log where id = f.ev2;
  assert (select count(*) from public.notifications where task_id = f.task_id and title = 'ASSERT other event' and activity_log_id is null) = 1,
    'the notice survives with its link cleared (ON DELETE SET NULL)';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
