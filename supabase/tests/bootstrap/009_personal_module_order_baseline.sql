-- ═════════════════════════════════════════════════════════════════════════════
-- TEST-ONLY BASELINE — personal module order (20261228000000)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THIS FILE MUST NEVER ENTER supabase/migrations, AND MUST NEVER DEPLOY.
--
-- WHAT IT IS FOR, AND NOTHING ELSE
-- --------------------------------
-- 20261228000000 references exactly ONE thing it does not create: auth.users,
-- as the cascade target for its primary key. It mentions no public table, no
-- other migration, no RPC and no enum — which is the point of the table's shape
-- and is asserted in personal_module_order_assertions.sql.
--
-- So this baseline is the smallest thing that lets the REAL migration run
-- unmodified against a throwaway local database: the three client roles, the
-- auth shim, an auth.users stand-in with nothing in it but ids, and — unlike
-- bootstrap/002 — PRODUCTION'S DEFAULT PRIVILEGES.
--
-- WHY THE DEFAULT PRIVILEGES ARE REPRODUCED HERE
-- ---------------------------------------------
-- Because the thing most worth proving about this migration is a REVOKE. A
-- Supabase project's bootstrap grants every newly created public table to anon,
-- authenticated and service_role, and 20261228000000 revokes that by name before
-- granting authenticated the three commands it needs. Against a bare container
-- with no such defaults, that revoke would be a no-op and the assertion "anon
-- cannot read a preference row" would pass for the wrong reason — it would be
-- proving that a grant was never made, not that the migration removed it. The
-- three statements below are the ones bootstrap/006 read from the production
-- catalogue; loading them FIRST, before any table exists, is what makes the
-- anon-lockout assertions mean something.
--
-- IT TARGETS A BARE POSTGRESQL CONTAINER, not a local Supabase stack. This
-- migration needs no storage bucket, no PostgREST and no real auth identity, and
-- a bare container starts in seconds with no per-machine config.toml. The
-- consequences, stated so nobody mistakes a green run for more than it is:
--
--   * anon, authenticated and service_role are CREATED here, NOLOGIN, because a
--     bare container has none. In a Supabase stack they exist and this is
--     skipped.
--   * auth.uid() is CREATED here, reading request.jwt.claims exactly as the
--     platform's does. In a Supabase stack the real one is left alone.
--   * auth.users holds ids and nothing else. The migration reads no other
--     column of it, and the assertions insert their own two accounts.
--
-- CONSEQUENCE, STATED PLAINLY: a green run proves things about 20261228000000.
-- It proves nothing about production's data, and no production credential was
-- used to write this file.

-- ─── 0. Production's default privileges — BEFORE anything is created ─────────
--
-- Quoted from supabase/tests/bootstrap/006_meeting_discussion_default_privileges.sql,
-- which read them from the linked production catalogue (pg_default_acl, public
-- schema, role postgres, read-only, 2026-09-16). Default privileges only apply to
-- objects created after them, which is why this block is first in the file and
-- the file is first in the runner.

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

alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  grant execute on functions to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;

-- ─── 1. The auth shim ───────────────────────────────────────────────────────
--
-- A local Supabase stack already has schema `auth`, `auth.uid()` and
-- `auth.users`. None is replaced if it already exists.

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

-- ─── 2. Minimal auth.users ──────────────────────────────────────────────────
--
-- ONE COLUMN, because the migration references exactly one: `id`, as the
-- cascade target. Deliberately not a fuller shape — a wider stand-in would
-- suggest this migration reads something about an account, and it does not.

create table if not exists auth.users (
  id uuid primary key
);
