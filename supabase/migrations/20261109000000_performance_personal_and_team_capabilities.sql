-- ════════════════════════════════════════════════════════════════════════════
-- Performance: Personal and Team become separately configurable capabilities
-- ════════════════════════════════════════════════════════════════════════════
--
-- THE DEFECT. `users.role` decided both halves of the Performance module, and it
-- decided them in opposite directions:
--
--   canViewTeamPerformance()   role = admin OR manager  → the management screen
--   src/app/modules/page.tsx   role = admin OR manager  → the launcher card sent
--                              them to /performance/team, so a Manager was
--                              offered no route to their OWN report
--   src/app/performance/page.tsx  refused any non-admin holding a View As
--                              target, so the one link that did go there from
--                              the team screen bounced a Manager to /dashboard
--
-- A Manager therefore lost Personal Performance — their own score, their own
-- month, their own EOD — by being a Manager. Nobody decided that; it fell out of
-- deriving a module capability from a role. An administrator had no control that
-- could put it back, because none of the three rules above reads the permission
-- engine.
--
-- WHAT THIS MIGRATION ADDS. Two actions on the existing `performance` module, so
-- the three capabilities are separately grantable in Control Center:
--
--   view        PERSONAL PERFORMANCE (already registered, by 20260660). Own
--               report, own month, own daily history, own EOD and self-rating.
--               Also module entry, which is what ModuleGuard and the launcher
--               already read — so nothing about who may open the module changes.
--   view_team   TEAM PERFORMANCE. /performance/team and the management dataset.
--   view_all    FULL TEAM VISIBILITY. Every eligible employee, rather than only
--               the caller's own department.
--
-- Both new actions are PROTECTED in src/lib/permissions/levels.ts: no access
-- level hands either out, and the dependency chain view_all → view_team → view
-- means neither can be stored without somewhere to act.
--
-- NOBODY'S ACCESS CHANGES WHEN THIS APPLIES. The grants below are written at
-- ROLE level and reproduce exactly what the role checks did on the day this was
-- written:
--
--   admin    saw the team screen and every employee in it       → view_team, view_all
--   manager  saw the team screen and every employee in it       → view_team, view_all
--   member   saw neither                                        → no rows
--
-- Role level, not employee level, is deliberate and is what makes this
-- deterministic and safe to run once: it touches NO employee_permission_overrides
-- row, so no administrator's hand-made grant is overwritten, and no individual
-- employee is named anywhere in this file. An administrator can now revoke either
-- action for one person in Control Center, and that employee override outranks
-- the role row — Employee Override > Department > Role > System Default.
--
-- WHAT IS NOT HERE. No individual is configured by name, id or email. Dhruv
-- already holds `performance.view` as an employee override (as does every other
-- active employee), so Personal Performance is his the moment the code stops
-- deriving it from his role; Team Performance and full visibility reach him
-- through the `manager` role rows below, exactly as they reached him through the
-- role check before. A migration that named him would have been a hard-coded
-- exception wearing SQL.
--
-- Idempotent throughout: every insert is ON CONFLICT DO NOTHING or DO UPDATE, so
-- re-running changes nothing.

-- ─── 1. The action rows ──────────────────────────────────────────────────────
--
-- `view_all` already exists — Orders and Finance registered it in 20260903000000
-- and its display_name is the GLOBAL vocabulary ('View All Records'). DO NOTHING
-- rather than DO UPDATE, so this file cannot rename it underneath those two
-- modules. Control Center renders Performance's as "View All Employees" through
-- the module-scoped label map in
-- src/app/api/control-center/permissions/employees/[id]/route.ts.
--
-- `view_team` is new and belongs to Performance alone, so it may carry its own
-- words.

insert into public.permission_actions (action_key, display_name, is_system)
values
  ('view_team', 'Team Performance', false),
  ('view_all',  'View All Records', false)
on conflict (action_key) do nothing;

-- ─── 2. Link both actions to the Performance module ──────────────────────────
--
-- default_allowed false: the System Default level denies both, so an employee
-- acquires either only from a role, a department or an explicit override.

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select m.id, a.id, false
from public.permission_modules m
cross join public.permission_actions a
where m.module_key = 'performance'
  and a.action_key in ('view_team', 'view_all')
on conflict (module_id, action_id) do nothing;

-- ─── 3. Role grants that preserve today's behaviour exactly ──────────────────
--
-- admin already holds view/create/edit/export/manage on this module at role
-- level (20260660); this adds the two new actions to that same set.
--
-- manager holds NO role rows on any module today — every manager's access is an
-- employee override. These two rows are the first, and they exist so that the
-- rule the code is dropping (`role = manager` ⇒ the team screen, all employees)
-- survives the change as configuration instead of as a hard-coded role test.
-- Every manager keeps precisely the sight they had.

insert into public.role_permissions (role, module_id, action_id, allowed)
select r.role, m.id, a.id, true
from (values ('admin'), ('manager')) as r(role)
cross join public.permission_modules m
cross join public.permission_actions a
where m.module_key = 'performance'
  and a.action_key in ('view_team', 'view_all')
on conflict (role, module_id, action_id) do update set allowed = excluded.allowed;

-- ─── 4. Assertions ───────────────────────────────────────────────────────────
--
-- The migration states what it did, or fails. A silently partial permission
-- migration is the failure mode 20260723000000 exists to undo.

do $$
declare
  v_module_id  uuid;
  v_links      int;
  v_role_rows  int;
begin
  select id into v_module_id from public.permission_modules where module_key = 'performance';
  if v_module_id is null then
    raise exception 'permission_modules has no "performance" row; 20260660 has not been applied';
  end if;

  select count(*) into v_links
  from public.module_permission_actions mpa
  join public.permission_actions a on a.id = mpa.action_id
  where mpa.module_id = v_module_id
    and a.action_key in ('view_team', 'view_all');
  if v_links <> 2 then
    raise exception 'performance should link view_team and view_all; found % of 2', v_links;
  end if;

  select count(*) into v_role_rows
  from public.role_permissions rp
  join public.permission_actions a on a.id = rp.action_id
  where rp.module_id = v_module_id
    and rp.role in ('admin', 'manager')
    and a.action_key in ('view_team', 'view_all')
    and rp.allowed;
  if v_role_rows <> 4 then
    raise exception 'expected 4 allowed admin/manager role grants; found %', v_role_rows;
  end if;
end $$;
