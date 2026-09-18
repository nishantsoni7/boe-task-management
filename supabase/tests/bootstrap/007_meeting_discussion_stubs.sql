-- ═════════════════════════════════════════════════════════════════════════════
-- TEST-ONLY STUBS — Meetings order-discussion workflow (20261213000000)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THIS FILE MUST NEVER ENTER supabase/migrations, AND MUST NEVER DEPLOY.
--
-- Loaded by supabase/tests/run_meeting_discussion_workflow_local.sh AFTER
-- 000_customer_review_module_baseline.sql (public.users) and BEFORE the Meetings
-- migrations. It supplies the two things that chain needs and no migration can
-- provide on a partial database.
--
-- 1. public.tasks
--    One of the four tables the migration history references and never creates
--    (docs/migrations-are-not-self-contained.md). Column names, types, enum values
--    and defaults are quoted from schema.json → definitions.tasks. Its row-level
--    security is quoted from the LINKED PRODUCTION CATALOGUE (pg_policy on
--    public.tasks, read-only, 2026-09-16), because no migration file defines it and
--    the source-task isolation assertions are only meaningful against the real
--    rule:
--
--      "Users can see their tasks"  FOR SELECT
--        USING ((auth.uid() = created_by) OR (auth.uid() = assigned_to)
--               OR (auth.uid() = delegated_by))
--
--    The INSERT / UPDATE / DELETE policies and tasks_module_entry_gate are not
--    reproduced: the suite creates its fixture tasks as postgres, and nothing in
--    the Meetings chain writes to tasks.
--
-- 2. public.module_entry_open(text)
--    Created by 20260905000000_module_view_parent_gates.sql, which cannot run on
--    this chain: its own assertion requires EXACTLY 27 gates across seven modules'
--    tables, and a Meetings-only database has six of them. The function body below
--    is that migration's, verbatim, and the six meeting-table gates it creates are
--    reproduced with the migration's own EXECUTE format. 20261203000000 and
--    20261213000000 add their own gates on top, exactly as they do in production.
--
-- A green run against this proves things about the Meetings migrations. It proves
-- nothing about the parts of production these stubs leave out.

-- ─── 1. public.tasks ─────────────────────────────────────────────────────────

create type public.task_type as enum ('daily_update', 'completion');
create type public.task_priority as enum ('low', 'medium', 'high');
create type public.task_team as enum ('sales', 'operations', 'design', 'purchase', 'bdm', 'management');
create type public.task_status as enum ('pending', 'started', 'working', 'waiting', 'blocked', 'completed');

create table public.tasks (
  id                       uuid primary key default gen_random_uuid(),
  title                    text not null,
  note                     text,
  type                     public.task_type not null default 'completion',
  priority                 public.task_priority not null default 'medium',
  is_urgent                boolean not null default false,
  team                     public.task_team not null,
  created_by               uuid not null,
  assigned_to              uuid not null,
  delegated_by             uuid,
  status                   public.task_status not null default 'pending',
  blocker_user_id          uuid,
  blocker_reason           text,
  due_date                 timestamptz,
  completed_at             timestamptz,
  acknowledged_at          timestamptz,
  last_update_at           timestamptz not null default now(),
  is_stale                 boolean not null default false,
  stale_day_count          integer not null default 0,
  last_status_before_stale public.task_status,
  delegation_accepted      boolean,
  delegation_accepted_at   timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  waiting_on_type          text,
  waiting_on_user_id       uuid,
  waiting_on_text          text
);

alter table public.tasks enable row level security;

create policy "Users can see their tasks" on public.tasks
  for select to authenticated
  using ((auth.uid() = created_by) or (auth.uid() = assigned_to) or (auth.uid() = delegated_by));

-- Table privileges come from production's default privileges, which
-- 006_meeting_discussion_default_privileges.sql reproduces before anything is created.

-- ─── 2. module_entry_open — verbatim from 20260905000000 §1 ──────────────────

CREATE OR REPLACE FUNCTION public.module_entry_open(p_module_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid()
        AND u.role = 'admin'
    )
    OR public.resolve_permission(auth.uid(), p_module_key, 'view');
$$;

-- The six meeting-table gates 20260905000000 §2 creates are in
-- 008_meeting_discussion_gates.sql, which the runner loads AFTER the Meetings
-- migrations have created those tables.
