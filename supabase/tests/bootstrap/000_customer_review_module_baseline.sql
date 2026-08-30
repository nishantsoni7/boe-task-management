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

-- ─── 3. Production's actual posture on public.users ──────────────────────────
--
-- THIS SECTION WAS ADDED AFTER AN INDEPENDENT REVIEW, and the reason is worth
-- recording because the omission had already misled one round of testing.
--
-- The first version of this baseline left public.users wide open and said so:
-- "more permissive than production, but it does not affect any claim being
-- tested, because every module predicate reads users from inside a SECURITY
-- DEFINER function". That was true when it was written. It stopped being true
-- the moment the request SELECT policy was rewritten to read users inline —
-- and because this baseline could not tell the difference, a full green run
-- proved nothing about whether that policy could read users in production at
-- all. A test environment that cannot fail in the way production would is not
-- evidence.
--
-- So the two real restrictions are reproduced here, quoted from the migrations
-- that impose them. Both are still repository-sourced; nothing was taken from
-- production.
--
--   supabase/migrations/20260812000000_attendance_payroll_isolation.sql
--     CREATE POLICY "Users can read all active users" ON public.users
--       FOR SELECT TO authenticated USING (is_active = true);
--
--   supabase/migrations/20260813000000_users_private_column_grants.sql
--     REVOKE SELECT ON public.users FROM anon, authenticated;
--     GRANT  SELECT (<named columns>) ON public.users TO authenticated;
--
-- ONE HONEST GAP REMAINS. No migration in this repository enables row security
-- on public.users — the table predates the chain, so the ENABLE lives outside
-- it. That it IS enabled in production is inferred from 20260812000000's own
-- comment, which describes the policy as what "stops the anon key returning the
-- whole employee directory". Enabling it here matches that description. If
-- production turns out NOT to have it enabled, this baseline is stricter than
-- production, which is the safe direction to be wrong in.

alter table public.users enable row level security;

create policy "Users can read all active users"
  on public.users
  for select
  to authenticated
  using (is_active = true);

-- Column-level SELECT, mirroring 20260813000000. The list is the intersection of
-- that migration's grant with the columns this baseline actually creates —
-- monthly_salary, payroll_notes, performance_tracking_note, exit_date and
-- performance_tracking_enabled are absent from the table above, so they cannot
-- be named here. Every column the application's own profile read needs
-- (USER_PROFILE_COLUMNS in src/lib/users/safeColumns.ts) is present.
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

revoke insert, update, delete on public.users from anon, authenticated;
