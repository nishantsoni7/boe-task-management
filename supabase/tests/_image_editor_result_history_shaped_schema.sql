-- A Supabase-shaped database for 20261021000000_image_editor_result_history.sql.
--
-- WHAT THIS IS. Everything that migration touches or leans on, and nothing else:
-- the three Supabase roles, `auth.uid()`, `storage.buckets` and
-- `storage.objects`, `public.users`, and the `module_entry_open()` gate the
-- restrictive policy calls. The migration itself is then applied VERBATIM on top
-- — it is not reproduced here — so what the assertions exercise is the real
-- file, in a real PostgreSQL, with real row-level security.
--
-- WHY IT EXISTS. The policy conditions this migration turns on
-- (`kept or expires_at > now()`, on the table AND on the object) are the kind of
-- thing a text search says nothing useful about: a regex cannot tell you whether
-- an expired row is actually unreadable, only that a word appears in a file. The
-- foreign key's ON DELETE RESTRICT is the same — it either refuses a delete or
-- it does not, and only a database can say which.
--
-- WHAT IT IS NOT. Not Supabase. `storage.objects` here carries the columns the
-- policies read and no more, and the real Storage API's own authorization sits
-- in front of it in production. What is faithful is the part under test: the
-- policy predicates, the grants, the roles, and `auth.uid()` reading the session
-- claim exactly as the deployed function does.
--
-- Used by run_image_editor_result_history_suite.sh, which builds a disposable
-- database from this file, applies the migration, and runs
-- image_editor_result_history_assertions.sql. It never talks to a linked
-- project — see the guard at the foot of this file.

-- ── The refusal, before anything is created ──────────────────────────────────
-- This file CREATES tables in `storage` and `public`. Run against a real project
-- it would be destructive, so it refuses anywhere but the disposable database
-- its runner makes, and it refuses FIRST.
do $$
begin
  if current_database() not like 'boe_image_editor%' then
    raise exception
      'refusing to build a fixture in %, which is not a disposable test database',
      current_database();
  end if;
end $$;

-- The Supabase role model, as much of it as the migration's policies name.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  -- BYPASSRLS, as Supabase grants it: the API routes act with this role and the
  -- policies below do NOT constrain them. That is why the cleanup assertion is
  -- meaningful and why every route filters ownership in code.
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

create schema if not exists auth;
create schema if not exists storage;
grant usage on schema public, auth, storage to anon, authenticated, service_role;

-- auth.uid(), as Supabase provides it: the session's JWT claim, blank when there
-- is no JWT rather than an error.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub',
    nullif(current_setting('request.jwt.claim.sub', true), '')), '')::uuid
$$;

-- ── Storage ──────────────────────────────────────────────────────────────────
-- The two columns the migration writes to `buckets` and the two the policies
-- read on `objects`. `name` is the object KEY — '<user_id>/<result_id>.png' —
-- which is what split_part() parses and what the storage SELECT policy joins to
-- image_editor_results.storage_path.
create table storage.buckets (
  id                text primary key,
  name              text not null,
  public            boolean not null default false,
  file_size_limit   bigint,
  allowed_mime_types text[],
  created_at        timestamptz not null default now()
);

create table storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text not null references storage.buckets(id),
  name       text not null,
  owner      uuid,
  metadata   jsonb,
  created_at timestamptz not null default now(),
  unique (bucket_id, name)
);

alter table storage.objects enable row level security;

grant select on storage.buckets to authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated, service_role;

-- ── People ───────────────────────────────────────────────────────────────────
-- Only what the foreign key needs. The RESTRICT under test is a property of the
-- reference, not of this table.
create table public.users (
  id         uuid primary key default gen_random_uuid(),
  email      text unique,
  full_name  text,
  role       text not null default 'member',
  is_active  boolean not null default true,
  is_deleted boolean not null default false
);

-- ── The house parent gate ────────────────────────────────────────────────────
-- 20260905000000's module_entry_open(), stood in as a switch this suite can
-- flip. Faithful to the SHAPE that matters here: it returns a boolean and the
-- migration AND-s it into every policy as RESTRICTIVE, so `false` must close
-- every door and `true` must open none by itself.
create or replace function public.module_entry_open(p_module_key text)
returns boolean
language sql
stable
as $$
  select coalesce(nullif(current_setting('boe.module_entry_open', true), '')::boolean, true)
$$;

grant execute on function public.module_entry_open(text) to anon, authenticated, service_role;
