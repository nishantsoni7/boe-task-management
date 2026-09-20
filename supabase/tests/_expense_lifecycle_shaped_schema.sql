-- ── A SHAPED BASE FOR THE EXPENSE LIFECYCLE SUITE ───────────────────────────
--
-- The minimum public schema that 20261220000000 and 20261222000000 actually
-- reach, plus Supabase-shaped roles and an auth.uid() shim. Same approach as
-- _verified_payment_permanent_shaped_schema.sql: the repository's migration
-- history cannot build a database on its own (docs/migrations-are-not-self-
-- contained.md), so the four tables it assumes are declared here.
--
-- NOTHING HERE IS A MIGRATION. It is never applied to any real database; it
-- exists so the two expense migrations can be run for real, against a row that
-- is a byte-for-byte copy of the one production holds, on a database that is
-- dropped afterwards.

create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;
-- ── SUPABASE'S BOOTSTRAP, REPRODUCED FAITHFULLY ────────────────────────────
--
-- A Supabase project grants ALL on tables AND ON FUNCTIONS in `public` to anon,
-- authenticated and service_role, through default privileges that fire the
-- moment an object is created.
--
-- BOTH LINES MATTER, AND THE SECOND ONE WAS MISSING AT FIRST. A base that never
-- granted DELETE would make 20261222000000 §4's revoke untestable; a base that
-- never granted EXECUTE on functions made 20261223000000 untestable in exactly
-- the same way, and the suite said so rather than passing vacuously. A shaped
-- base is only useful while it is shaped like the thing it stands in for.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- ── auth.uid(), as a settable shim ─────────────────────────────────────────
-- The suite switches actor with `set local request.jwt.claim.sub`.

create schema if not exists auth;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- Supabase grants these; without them a policy that calls auth.uid() fails with
-- "permission denied for schema auth" the moment a client role is assumed.
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- ── The four tables the history assumes ────────────────────────────────────
-- Only the columns the expense migrations and their helpers read.

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  full_name text,
  role text not null default 'employee',
  is_active boolean not null default true,
  is_deleted boolean not null default false
);

-- ── The helpers the policies call ──────────────────────────────────────────
--
-- SHAPED, NOT COPIED. Each returns the same answer the deployed function
-- returns for the cases this suite exercises, from a table the suite can set:
-- who holds which finance action, and who has Finance entry at all.

create table if not exists public.test_permissions (
  user_id uuid not null,
  module_key text not null,
  action_key text not null,
  primary key (user_id, module_key, action_key)
);

create table if not exists public.test_module_entry (
  user_id uuid not null,
  module_key text not null,
  primary key (user_id, module_key)
);

create or replace function public.module_entry_open(p_module_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.role = 'admin' and u.is_active and not u.is_deleted
  ) or exists (
    select 1 from public.test_module_entry e
    where e.user_id = auth.uid() and e.module_key = p_module_key
  );
$$;

create or replace function public.actor_has_permission(p_module_key text, p_action_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.test_permissions p
    join public.users u on u.id = p.user_id
    where p.user_id = auth.uid()
      and p.module_key = p_module_key
      and p.action_key = p_action_key
      and u.is_active and not u.is_deleted
  );
$$;

create or replace function public.actor_has_module_permission(p_module_key text, p_action_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.role = 'admin' and u.is_active and not u.is_deleted
  ) or public.actor_has_permission(p_module_key, p_action_key);
$$;

grant execute on function public.module_entry_open(text) to authenticated;
grant execute on function public.actor_has_permission(text, text) to authenticated;
grant execute on function public.actor_has_module_permission(text, text) to authenticated;

-- ── set_updated_at(), from 20260609_create_attendance_records.sql ──────────

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
