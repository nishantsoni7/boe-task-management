-- ═════════════════════════════════════════════════════════════════════════════
-- TEST-ONLY STUBS — the Custom Review phase (20261206000000) on a bare
-- PostgreSQL container
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THIS FILE MUST NEVER ENTER supabase/migrations, AND MUST NEVER DEPLOY.
--
-- The bare-container chain (002 → … → 004) has no notifications table: the
-- platform created it long before this repository's migrations. The migration
-- under test adds two enum values to notification_type and its trigger inserts
-- into public.notifications, so both are created here in their smallest form —
-- the columns the trigger writes and the suite reads, nothing else.
--
-- Nothing here is taken from production.

do $$
begin
  if to_regtype('public.notification_type') is null then
    create type public.notification_type as enum ('task_assigned', 'task_acknowledged');
  end if;
end $$;

create table if not exists public.notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  task_id      uuid,
  entity_id    uuid,
  type         public.notification_type not null,
  title        text not null,
  body         text,
  is_read      boolean not null default false,
  is_push_sent boolean not null default false,
  created_at   timestamptz not null default now()
);
