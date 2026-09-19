-- ═════════════════════════════════════════════════════════════════════════════
-- TEST-ONLY BASELINE — Assets & Access delegation and handover testing
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THIS FILE MUST NEVER ENTER supabase/migrations, AND MUST NEVER DEPLOY.
--
-- WHAT IT IS FOR, AND NOTHING ELSE
-- --------------------------------
-- The migration history cannot build a database on its own: four tables are
-- referenced by it and created by none of it (see
-- docs/migrations-are-not-self-contained.md). Of those four, the Assets &
-- Access chain needs exactly ONE — public.users — and never mentions tasks or
-- task_activity_log.
--
-- `notifications` IS referenced by two Assets migrations (20260731000000 and
-- 20260802000000), but both only ADD VALUEs to the `notification_type` enum and
-- create one index. Nothing in the delegation or handover work reads either,
-- and no assertion inserts a notification — so those two migrations are left
-- OUT of the prerequisite chain instead of being faked here. See the runner,
-- which says the same thing where the chain is listed.
--
-- So this file creates the smallest thing that lets the REAL prerequisite
-- migrations and the REAL pending migrations run unmodified against a throwaway
-- local database. It is a scaffold, not a record of production.
--
-- IT IS AN INCOMPLETE REPRESENTATION OF PRODUCTION public.users.
-- ------------------------------------------------------------
-- Column names and types only, and only the ones the chain touches. It
-- deliberately does NOT reproduce production's defaults, indexes, foreign keys
-- to auth.users, or its triggers.
--
-- CONSEQUENCE, STATED PLAINLY: a green run proves things about
-- 20261028000000 and 20261029000000. It proves NOTHING about how they behave
-- against production's actual users table, and it is not evidence that the two
-- are the same. Anyone reading a green result must carry that caveat with it.
--
-- EVERY DEFINITION BELOW IS QUOTED FROM A COMMITTED REPOSITORY FILE — most of
-- them from supabase/tests/bootstrap/000_customer_review_module_baseline.sql,
-- which was written and independently reviewed for the same purpose. Nothing
-- here was taken from production, and no production credential was used.

-- ─── 0. The auth shim ────────────────────────────────────────────────────────
--
-- A local Supabase stack already has schema `auth` and `auth.uid()`. Both are
-- created here only for a bare PostgreSQL target, and neither is replaced if it
-- already exists — overwriting the stack's own auth.uid() would be a change to
-- something this file has no business owning.

create schema if not exists auth;

do $$
begin
  if to_regprocedure('auth.uid()') is null then
    execute $fn$
      create function auth.uid() returns uuid language sql stable as $body$
        select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid
      $body$
    $fn$;
  end if;
end $$;

-- ─── 1. The two enum types ───────────────────────────────────────────────────
--
-- users.team really was the enum `user_team` until 20260666 converted it, and
-- 20260662 exists ONLY because resolve_effective_permissions() joined that enum
-- against departments.department_key (text) with no cast and errored 42883.
-- Declaring team as text here would make 20260662 a no-op and quietly stop the
-- run exercising the bug it was written to fix. 20260666 is deliberately NOT in
-- the prerequisite chain, so team stays an enum throughout.

create type public.user_role as enum ('admin', 'manager', 'member');

create type public.user_team as enum (
  'sales', 'operations', 'design', 'purchase', 'bdm', 'management'
);

-- ─── 2. Minimal public.users ─────────────────────────────────────────────────
--
-- Only five columns are load-bearing for the migrations under test:
--   id          the FK target for employee_id / assigned_by / accepted_by /
--               updated_by / granted_by
--   role        read by can_manage_access_records() and every asset predicate
--   team        joined against departments.department_key by the resolver
--   is_active   read by every predicate in both pending migrations
--   is_deleted  read by asset_user_display_name() and the grant guards

create table public.users (
  id                        uuid primary key,
  full_name                 text        not null,
  phone                     text,
  email                     text,
  role                      public.user_role not null,
  team                      public.user_team not null,
  is_active                 boolean     not null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  position                  text,
  is_deleted                boolean     not null default false,
  deleted_at                timestamptz,
  deleted_by                uuid,
  deletion_scheduled_at     timestamptz,
  employee_code             text,
  joining_date              date,
  office_timing             text,
  fingerprint_employee_code text,
  payroll_active            boolean     not null default true,
  employment_type           text        check (employment_type in ('permanent', 'contract'))
);

-- ─── 3. Production's actual posture on public.users ──────────────────────────
--
-- Reproduced because the delegation assertions include "the Access Register
-- grant must not deactivate an employee", and a wide-open users table would
-- make that assertion pass for the wrong reason.
--
--   supabase/migrations/20260812000000_attendance_payroll_isolation.sql
--     CREATE POLICY "Users can read all active users" ON public.users
--       FOR SELECT TO authenticated USING (is_active = true);
--
--   supabase/migrations/20260813000000_users_private_column_grants.sql
--     REVOKE SELECT ON public.users FROM anon, authenticated;
--     GRANT  SELECT (<named columns>) ON public.users TO authenticated;
--
-- ONE HONEST GAP REMAINS, identical to the one 000_… records: no migration in
-- this repository enables row security on public.users, because the table
-- predates the chain. Enabling it here matches 20260812000000's own description
-- of what its policy is for. If production turns out NOT to have it enabled,
-- this baseline is stricter than production, which is the safe direction.

alter table public.users enable row level security;

create policy "Users can read all active users"
  on public.users
  for select
  to authenticated
  using (is_active = true);

revoke select on public.users from anon, authenticated;

grant select (
  id,
  full_name,
  email,
  phone,
  role,
  team,
  position,
  is_active,
  created_at,
  updated_at,
  employee_code,
  joining_date,
  office_timing,
  fingerprint_employee_code,
  payroll_active,
  employment_type,
  is_deleted,
  deleted_at,
  deleted_by,
  deletion_scheduled_at
) on public.users to authenticated;

-- No INSERT / UPDATE / DELETE for the API roles. This is what makes "a Manage
-- Access Records holder cannot deactivate an employee" a real test.
revoke insert, update, delete on public.users from anon, authenticated;

-- ─── 4. set_updated_at() ─────────────────────────────────────────────────────
--
-- Referenced by 20260640 and by the permission engine, created by no migration
-- (it predates the chain, like public.users). Quoted from its use sites: every
-- caller attaches it as a BEFORE UPDATE trigger and expects updated_at stamped.

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;
