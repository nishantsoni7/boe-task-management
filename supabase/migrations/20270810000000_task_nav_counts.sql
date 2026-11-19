-- ════════════════════════════════════════════════════════════════════════════
-- 20270810000000 — Task Management sidebar: the three badge counts in ONE call
-- ════════════════════════════════════════════════════════════════════════════
--
-- THE ASK (owner, 2026-11-19, page speed): after the My Tasks open-work change (#942) the sidebar's three badge
-- counts (My Tasks, Assigned By Me, Quotation Requests) were still three head-only requests, fired beside the
-- page's own reads on every Task Management page. This answers all three in one.
--
-- WHAT IS ADDED, and nothing wider:
--   task_nav_counts(uuid) — three counts over public.tasks for the given user, the SAME rules as the three reads in
--   src/components/layout/DashboardLayout.tsx that it replaces (src/lib/tasks/navCounts.ts keeps them as the fallback):
--     my_active              assigned_to = p_user AND status IN ('pending','started','working')
--                            AND task_type <> 'quotation_request'
--     assigned_by_me_active  created_by = p_user AND assigned_to <> p_user
--                            AND status <> 'completed' AND status <> 'cancelled'
--     quotation_active       assigned_to = p_user AND task_type = 'quotation_request'
--                            AND status <> 'completed' AND status <> 'cancelled'
--   `<>` is what PostgREST's neq is, so a task with no assignee is left out of the second count exactly as before.
--   tasks.task_type is NOT NULL DEFAULT 'general' (20260652), so the first count has no NULL case either.
--
-- AUTHORITY. SECURITY INVOKER: it reads the table as the caller, so row-level security decides which rows are
-- counted, exactly as it does for the three requests it replaces (an administrator previewing somebody else passes
-- that person's id and gets what the administrator may see, as today). It grants nothing and is granted to
-- `authenticated` only.
--
-- NOT TOUCHED: any table, row, policy or grant on tasks. READ-ONLY. No table or data change, so no backup is needed.
--
-- ROLLBACK: drop function public.task_nav_counts(uuid); the sidebar falls back to the three requests by itself when
-- the function is missing.
-- ════════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regclass('public.tasks') is null then
    raise exception '20270810000000: public.tasks is missing';
  end if;
end $$;

create or replace function public.task_nav_counts(p_user uuid)
returns table (my_active bigint, assigned_by_me_active bigint, quotation_active bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*) filter (where t.assigned_to = p_user
                       and t.status in ('pending', 'started', 'working')
                       and t.task_type <> 'quotation_request'),
    count(*) filter (where t.created_by = p_user
                       and t.assigned_to <> p_user
                       and t.status <> 'completed'
                       and t.status <> 'cancelled'),
    count(*) filter (where t.assigned_to = p_user
                       and t.task_type = 'quotation_request'
                       and t.status <> 'completed'
                       and t.status <> 'cancelled')
  from public.tasks t
  where t.assigned_to = p_user or t.created_by = p_user
$$;

revoke all on function public.task_nav_counts(uuid) from public, anon;
grant execute on function public.task_nav_counts(uuid) to authenticated;

comment on function public.task_nav_counts(uuid) is
  'Task Management sidebar badges (my active, assigned by me, quotation requests) in one call; SECURITY INVOKER, RLS decides the rows. 20270810000000.';

-- Self-check: the function exists, is an invoker function, and anon cannot run it.
do $$
declare v_definer boolean;
begin
  select p.prosecdef into v_definer
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'task_nav_counts';
  if v_definer is null then raise exception '20270810000000: function was not created'; end if;
  if v_definer then raise exception '20270810000000: must be SECURITY INVOKER'; end if;
  if has_function_privilege('anon', 'public.task_nav_counts(uuid)', 'execute') then
    raise exception '20270810000000: anon must not execute it';
  end if;
  if not has_function_privilege('authenticated', 'public.task_nav_counts(uuid)', 'execute') then
    raise exception '20270810000000: authenticated must be able to execute it';
  end if;
end $$;
