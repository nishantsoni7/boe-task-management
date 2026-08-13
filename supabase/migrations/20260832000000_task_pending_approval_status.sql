-- `pending_approval` — the status a delegated task sits in between the assignee
-- finishing it and the creator accepting it.
--
-- The VALUE ONLY. The workflow that reaches it — transition_task_review() and
-- the trigger that makes it the only path — is 20260833000000, deliberately a
-- separate file: PostgreSQL forbids USING an enum label in the same transaction
-- that added it, and Supabase runs each migration file in its own transaction.
-- Splitting them is how the repo already handles enum growth (20260731000000,
-- 20260824000000, 20260825000000).
--
-- APPLY THIS ONE FIRST. On its own it changes no behaviour whatsoever: nothing
-- writes the value, nothing reads it, and every existing row keeps the status it
-- has. It is safe to apply ahead of the code and ahead of 20260833000000.
--
-- Same defensive idiom as 20260633_add_task_cancellation.sql. `tasks.status` and
-- `task_activity_log.from_status` / `.to_status` are all the enum
-- `public.task_status` (confirmed against the live PostgREST schema), but the DO
-- blocks also no-op cleanly if a column is ever a plain text/CHECK column.

do $$
declare
  v_type_name text;
begin
  select t.typname into v_type_name
    from pg_attribute a
    join pg_type     t on t.oid = a.atttypid
    join pg_class    c on c.oid = a.attrelid
   where c.relname = 'tasks'
     and a.attname = 'status'
     and t.typtype = 'e';

  if v_type_name is not null then
    execute format('alter type %I add value if not exists ''pending_approval''', v_type_name);
  end if;
end $$;

do $$
declare
  v_type_name text;
begin
  select t.typname into v_type_name
    from pg_attribute a
    join pg_type     t on t.oid = a.atttypid
    join pg_class    c on c.oid = a.attrelid
   where c.relname = 'task_activity_log'
     and a.attname = 'from_status'
     and t.typtype = 'e';

  if v_type_name is not null then
    execute format('alter type %I add value if not exists ''pending_approval''', v_type_name);
  end if;
end $$;

do $$
declare
  v_type_name text;
begin
  select t.typname into v_type_name
    from pg_attribute a
    join pg_type     t on t.oid = a.atttypid
    join pg_class    c on c.oid = a.attrelid
   where c.relname = 'task_activity_log'
     and a.attname = 'to_status'
     and t.typtype = 'e';

  if v_type_name is not null then
    execute format('alter type %I add value if not exists ''pending_approval''', v_type_name);
  end if;
end $$;
