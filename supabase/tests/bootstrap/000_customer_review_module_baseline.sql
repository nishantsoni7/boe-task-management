-- ═════════════════════════════════════════════════════════════════════════════
-- TEST-ONLY BASELINE — Customer Review Outreach dependency testing
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THIS FILE MUST NEVER ENTER supabase/migrations, AND MUST NEVER DEPLOY.
--
-- WHAT IT IS FOR, AND NOTHING ELSE
-- --------------------------------
-- The migration history cannot build a database on its own: four tables are
-- referenced by it and created by none of it (see
-- docs/migrations-are-not-self-contained.md). Of those four, the Customer
-- Review Outreach migration needs exactly ONE — public.users — and never
-- mentions tasks, task_activity_log or notifications.
--
-- So this file creates the smallest thing that lets the REAL prerequisite
-- migrations and the REAL pending migration run unmodified against a throwaway
-- local database. It is a scaffold, not a record of production.
--
-- IT IS AN INCOMPLETE REPRESENTATION OF PRODUCTION public.users.
-- ------------------------------------------------------------
-- It carries column names and types only. It deliberately does NOT reproduce
-- production's defaults, indexes, row-level security, policies, triggers,
-- foreign keys to auth.users, or the column-level GRANTs that keep
-- monthly_salary and payroll_notes away from `authenticated` (20260813000000).
-- `monthly_salary` is omitted entirely: nothing in this module reads it, and a
-- test database has no business holding a salary column at all.
--
-- CONSEQUENCE, STATED PLAINLY: a test run against this baseline proves things
-- about the Customer Review Outreach migration. It proves NOTHING about how
-- that migration behaves against production's actual users table, and it is not
-- evidence that the two are the same. Anyone reading a green result must carry
-- that caveat with it.
--
-- EVERY DEFINITION BELOW IS QUOTED FROM A COMMITTED REPOSITORY FILE.
-- Nothing here was taken from production, and no production credential was used
-- to write it.
--
--   public.user_role values   src/lib/types.ts:23
--                             export type UserRole = 'admin' | 'manager' | 'member'
--
--   public.user_team values   supabase/migrations/20260666_convert_users_team_to_text.sql,
--                             header line 3: "the fixed Postgres enum `user_team`
--                             (sales, operations, design, purchase, bdm, management)"
--
--   users column names/types  schema.json — the committed PostgREST OpenAPI
--                             snapshot, definitions.users
--
--   is_deleted default        supabase/migrations/20260605_add_soft_delete_users.sql
--                             ("is_deleted boolean NOT NULL DEFAULT false")
--
--   payroll_active,           supabase/migrations/20260607000100_add_payroll_config_fields.sql
--   employment_type           (verbatim, including the CHECK)
--
-- WHY THE ENUMS ARE ENUMS AND NOT text
-- ------------------------------------
-- users.team really was the enum `user_team` until 20260666 converted it, and
-- 20260662 exists ONLY because resolve_effective_permissions() joined that enum
-- against departments.department_key (text) with no cast and errored 42883.
-- Declaring team as text here would make 20260662 a no-op and quietly stop the
-- test exercising the bug it was written to fix. 20260666 is deliberately NOT in
-- the prerequisite chain, so team stays an enum throughout the run.

-- ─── 1. The two enum types ───────────────────────────────────────────────────

create type public.user_role as enum ('admin', 'manager', 'member');

create type public.user_team as enum (
  'sales', 'operations', 'design', 'purchase', 'bdm', 'management'
);

-- ─── 2. Minimal public.users ─────────────────────────────────────────────────
--
-- Column set = what schema.json records, MINUS monthly_salary, PLUS the two
-- columns the application's profile query needs that post-date that snapshot.
--
-- Only four of these are load-bearing for the migrations under test:
--   id        the FK target for created_by / verified_by / actor_id / uploaded_by
--   role      read by can_view_/can_edit_ and by the permission resolver
--   team      joined against departments.department_key by the resolver
--   is_active read by every predicate in the pending migration
-- The rest exist so the application's own profile read (USER_PROFILE_COLUMNS in
-- src/lib/users/safeColumns.ts) succeeds during the browser test.

create table public.users (
  id                        uuid primary key,
  full_name                 text        not null,
  phone                     text,
  email                     text,
  role                      public.user_role not null,
  team                      public.user_team not null,
  is_active                 boolean     not null,
  created_at                timestamptz not null,
  updated_at                timestamptz not null,
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

-- NO ROW-LEVEL SECURITY IS ENABLED ON THIS TABLE, and that is a deliberate
-- deviation rather than an oversight.
--
-- Production does restrict public.users — row security plus column-level GRANTs
-- from 20260813000000. Reproducing that here would mean inventing a policy this
-- repository does not contain, which is exactly what this baseline must not do.
-- Supabase's default privileges leave a new public table readable by
-- `authenticated`, which is what lets the application's profile read work.
--
-- This makes the local users table MORE permissive than production. It does not
-- affect any claim being tested: every Customer Review Outreach predicate reads
-- users from inside a SECURITY DEFINER function, where row security is bypassed
-- in production too.
