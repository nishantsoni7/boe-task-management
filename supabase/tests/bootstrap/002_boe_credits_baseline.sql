-- ═════════════════════════════════════════════════════════════════════════════
-- TEST-ONLY BASELINE — BOE Credits Phase 1A testing
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THIS FILE MUST NEVER ENTER supabase/migrations, AND MUST NEVER DEPLOY.
--
-- WHAT IT IS FOR, AND NOTHING ELSE
-- --------------------------------
-- The migration history cannot build a database on its own: four tables are
-- referenced by it and created by none of it (see
-- docs/migrations-are-not-self-contained.md). The BOE Credits chain needs
-- exactly ONE of them — public.users — and never mentions tasks,
-- task_activity_log or notifications.
--
-- So this file creates the smallest thing that lets the REAL prerequisite
-- migration (20260611_create_payroll_periods.sql) and the REAL pending
-- migration (20261101000000_boe_credits_foundation.sql) run unmodified
-- against a throwaway local database. It is a scaffold, not a record of
-- production.
--
-- IT TARGETS A BARE POSTGRESQL CONTAINER, not a Supabase stack. That is a
-- deliberate difference from bootstrap/000 and /001: this chain needs no
-- storage bucket, no auth identity and no PostgREST, and a bare container
-- starts in seconds with no per-machine config.toml. The consequences are
-- stated here so nobody mistakes a green run for more than it is:
--
--   * the three client roles (anon, authenticated, service_role) are CREATED
--     here, NOLOGIN, because a bare container has none. In a Supabase stack
--     they already exist and this block is skipped.
--   * auth.uid() is CREATED here, reading request.jwt.claims exactly as the
--     platform's does. In a Supabase stack the real one is left alone.
--   * Supabase's DEFAULT PRIVILEGES (which grant every new public table to
--     authenticated before a migration can revoke it) are NOT reproduced. The
--     migration under test revokes explicitly anyway, and the assertions
--     check the resulting privileges rather than assuming them — but a
--     migration that RELIED on the defaults would pass here and fail there.
--
-- IT IS AN INCOMPLETE REPRESENTATION OF PRODUCTION public.users.
-- ------------------------------------------------------------
-- Column names and types only, and only the ones the chain touches. Every
-- definition below is quoted from supabase/tests/bootstrap/000_customer_review_
-- module_baseline.sql, which was written and independently reviewed for the
-- same purpose. Nothing here was taken from production, and no production
-- credential was used.
--
-- CONSEQUENCE, STATED PLAINLY: a green run proves things about
-- 20261101000000. It proves NOTHING about how it behaves against production's
-- actual users table, and it is not evidence that the two are the same.

-- ─── 0. The client roles ─────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

-- ─── 1. The auth shim ────────────────────────────────────────────────────────
--
-- A local Supabase stack already has schema `auth` and `auth.uid()`. Both are
-- created here only for a bare PostgreSQL target, and neither is replaced if it
-- already exists.

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

do $$
begin
  if to_regprocedure('auth.uid()') is null then
    execute $fn$
      create function auth.uid() returns uuid language sql stable as $body$
        select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid
      $body$
    $fn$;
    execute 'grant execute on function auth.uid() to anon, authenticated, service_role';
  end if;
end $$;

-- ─── 2. The role enum ────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum ('admin', 'manager', 'member');
  end if;
end $$;

-- ─── 3. Minimal public.users ─────────────────────────────────────────────────
--
-- Only five columns are load-bearing for the migration under test:
--   id          the FK target for employee_id / created_by
--   role        read by can_manage_boe_credits() and the posting function
--   is_active   read by both, and by the settings SELECT policy
--   is_deleted  read by both, and by the settings SELECT policy
--   full_name   read by the routes' name resolution (not exercised here)
-- The rest exist so the row shape resembles production's closely enough that
-- the fixtures in the assertions read naturally.

create table public.users (
  id             uuid primary key,
  full_name      text        not null,
  email          text,
  role           public.user_role not null,
  team           text,
  is_active      boolean     not null default true,
  is_deleted     boolean     not null default false,
  deleted_at     timestamptz,
  employee_code  text,
  payroll_active boolean     not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ─── 4. Production's actual posture on public.users ──────────────────────────
--
-- Reproduced from the migrations that impose it, because the settings SELECT
-- policy under test reads users INLINE (as the invoker) and would be wide open
-- against a users table that is wide open:
--
--   supabase/migrations/20260812000000_attendance_payroll_isolation.sql
--     CREATE POLICY "Users can read all active users" ON public.users
--       FOR SELECT TO authenticated USING (is_active = true);
--
--   supabase/migrations/20260813000000_users_private_column_grants.sql
--     REVOKE SELECT ON public.users FROM anon, authenticated;
--     GRANT  SELECT (<named columns>) ON public.users TO authenticated;

alter table public.users enable row level security;

create policy "Users can read all active users"
  on public.users
  for select
  to authenticated
  using (is_active = true);

revoke select on public.users from anon, authenticated;

grant select (
  id, full_name, email, role, team, is_active, is_deleted, deleted_at,
  employee_code, payroll_active, created_at, updated_at
) on public.users to authenticated;

revoke insert, update, delete on public.users from anon, authenticated;
