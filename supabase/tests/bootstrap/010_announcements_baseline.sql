-- ═════════════════════════════════════════════════════════════════════════════
-- TEST-ONLY BASELINE — for 20270110000000_announcements.sql. NOT A MIGRATION.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Applied by run_announcements_local.sh onto a BLANK local Supabase stack
-- (auth and storage present, public empty), after 006 has reproduced
-- production's default privileges. It supplies the one table the migration
-- reads that no migration creates: public.users, in the shape production has
-- for the columns the announcement rules use.
--
-- Because 006 runs first, anon and authenticated are granted everything on this
-- table and on the migration's tables the moment they are created — so an
-- assertion that "authenticated cannot insert" can only pass because the
-- migration REVOKED it.

create table if not exists public.users (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  email       text,
  role        text not null default 'member',
  team        text,
  is_active   boolean not null default true,
  is_deleted  boolean default false
);
