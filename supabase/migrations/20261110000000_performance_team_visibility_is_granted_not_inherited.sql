-- ════════════════════════════════════════════════════════════════════════════
-- Performance: Team visibility is GRANTED, never inherited from a role name
-- ════════════════════════════════════════════════════════════════════════════
--
-- Forward-only correction to 20261109000000, which is already applied in
-- production and is NOT edited.
--
-- WHAT 20261109000000 GOT RIGHT. Personal Performance, Team Performance and
-- company-wide visibility became three separately grantable actions on the
-- `performance` module, so a Manager could stop losing their own report. That
-- part stands: this file registers nothing, removes no action, and changes no
-- module_permission_actions row.
--
-- WHAT IT GOT WRONG. It seeded `role_permissions` for `manager` with BOTH
-- view_team and view_all, on the reasoning that this reproduced the role checks
-- it was replacing. Reproducing them is exactly the problem. It means:
--
--   · every manager, present and FUTURE, silently acquires sight of every
--     employee's score the moment their role is set — the authority arrives
--     with a job title rather than with a decision;
--   · `view_all` in particular is company-wide sight of other people's measured
--     work, and it was being handed out by inheritance;
--   · an administrator opening Control Center saw two capabilities they had
--     never granted and could not have reasoned about.
--
-- Splitting Personal from Team was the point of the previous migration. Leaving
-- Team attached to the role name undoes half of it: the module stops being
-- role-derived for the person who was harmed by it and stays role-derived for
-- everybody else.
--
-- THE RULE THIS ESTABLISHES, and it is the same one 20260723000000 §2 wrote for
-- Assets & Access: NOBODY GETS PERFORMANCE MANAGEMENT VISIBILITY FROM THEIR ROLE
-- NAME EXCEPT THE ADMIN. It is granted per employee in Control Center, or not at
-- all.
--
-- WHAT DOES NOT CHANGE
--
--   · Personal Performance. `performance.view` is untouched at every level.
--     Every active employee — managers included — holds it as an employee
--     override today, and managers must keep it: a manager is still an employee
--     who submits an EOD and carries a score. Re-creating that bug is the one
--     thing this correction must not do.
--   · Admin. All seven `admin` role rows on this module survive, and the
--     application's admin short-circuit is independent of them anyway.
--   · Every other module. Every statement below is scoped to
--     module_key = 'performance'.
--   · The registered actions. view_team and view_all remain declared, linked to
--     the module, and default-deny — asserted in section 4.
--
-- KNOWN CONSEQUENCE, stated rather than discovered later: the OTHER manager
-- holds no explicit grant, so after this applies they see their own Performance
-- and no team screen. That is the conservative default this file exists to
-- install; restoring their access is one tick of Team Performance in Control
-- Center, which is now a decision somebody makes instead of a side effect of
-- their job title.
--
-- Idempotent throughout. Re-running deletes nothing further and rewrites no
-- grant timestamp.

-- ─── 1. No role name grants Performance management visibility ────────────────
--
-- DELETE rather than `allowed = false`, deliberately, and for the reason
-- 20260723000000 §2 records: role_permissions has no revoked_at column, and a
-- role row set to false is an ACTIVE role-level DENY. A deny is not what is
-- meant here — what is meant is "the role says nothing", so the decision falls
-- through to the module's system default (default_allowed = false) and any
-- employee override can still speak. Writing false would also be a statement
-- about future managers that nobody made.
--
-- Scoped three ways — this module, these two actions, and role <> 'admin' — so
-- the admin's own grants and every other module are untouched. In production
-- this removes exactly two rows, both written by 20261109000000:
--
--   manager  view_all   6b7e44bf-c56d-404c-a95f-766cef8bd2ce
--   manager  view_team  1f897498-35f6-454b-aa40-5c6831dbd900
--
-- After it, `manager` once again holds no role_permissions row on any module,
-- which was the invariant before 20261109000000 disturbed it.

delete from public.role_permissions rp
 using public.permission_modules pm,
       public.permission_actions pa
 where rp.module_id = pm.id
   and rp.action_id = pa.id
   and pm.module_key = 'performance'
   and pa.action_key in ('view_team', 'view_all')
   and rp.role <> 'admin';

-- ─── 2. The one employee who is meant to hold it, holds it explicitly ────────
--
-- Dhruv (BDM) monitors the whole company's execution, which is the business
-- need the original defect report was about. He now holds that authority the
-- way every other delegated authority in this system is held: as an
-- employee_permission_overrides row an administrator can read and withdraw in
-- Control Center — not as a property of the word "manager".
--
-- TARGETED BY users.id, which is the stable identifier and the repository's
-- established convention for a per-employee grant (see 20260723000000 §3a/§3b,
-- which lists ten ids with the name in a trailing comment). A display name is
-- editable free text and two employees may share one; the primary key is
-- neither. Section 4 additionally refuses to let this row be written against
-- the wrong person.
--
-- INSERT ... SELECT FROM users, so on a database that does not contain this id
-- — a fresh local stack, a restored fixture — zero rows are written and nothing
-- fails. The grant is a production fact, not a schema fact.
--
-- granted_by is resolved to the acting administrator by role rather than
-- hardcoded, exactly as 20260723000000 resolves revoked_by.
--
-- ON CONFLICT DO UPDATE re-activates a row that was previously revoked and
-- leaves granted_at / granted_by alone, so re-running this migration does not
-- rewrite the audit trail of when the authority was first given.

insert into public.employee_permission_overrides
  (user_id, module_id, action_id, allowed, granted_by, granted_at)
select u.id,
       pm.id,
       pa.id,
       true,
       (select id from public.users where role = 'admin' and is_active order by created_at limit 1),
       now()
  from public.users u
 cross join public.permission_modules pm
 cross join public.permission_actions pa
 where u.id = '61f4a1f7-3c2a-435f-abca-f884301dcc96'   -- Dhruv, boebdm@gmail.com
   and pm.module_key = 'performance'
   and pa.action_key in ('view_team', 'view_all')
on conflict (user_id, module_id, action_id) do update
   set allowed    = true,
       revoked_by = null,
       revoked_at = null;

-- ─── 3. Nothing else about anybody's permissions is touched ──────────────────
--
-- There is deliberately no statement here for Dhruv's five existing
-- `performance` overrides (view, create, edit, export allowed; manage denied),
-- for any other employee's overrides on this or any module, or for the
-- `users` table. Section 2 addresses two (user_id, module_id, action_id)
-- triples and no others; section 1 addresses two role rows and no others.

-- ─── 4. Assertions ───────────────────────────────────────────────────────────
--
-- The migration states what it did, or fails. A silently partial permission
-- migration is the failure mode 20260723000000 exists to undo — and the row
-- being written here is company-wide sight of every employee's measured work,
-- which is the last row in this system that should land unverified.

do $$
declare
  v_module_id   uuid;
  v_actions     int;
  v_role_rows   int;
  v_admin_rows  int;
  v_target      record;
  v_dhruv_rows  int;
begin
  select id into v_module_id from public.permission_modules where module_key = 'performance';
  if v_module_id is null then
    raise exception 'permission_modules has no "performance" row; 20260660 has not been applied';
  end if;

  -- 4a. The actions 20261109000000 registered are still registered. This file
  --     corrects who holds them, and must never be a route to removing them.
  select count(*) into v_actions
    from public.module_permission_actions mpa
    join public.permission_actions pa on pa.id = mpa.action_id
   where mpa.module_id = v_module_id
     and pa.action_key in ('view_team', 'view_all')
     and mpa.default_allowed = false;
  if v_actions <> 2 then
    raise exception 'view_team and view_all must stay registered and default-deny; found % of 2', v_actions;
  end if;

  -- 4b. No non-admin role grants either action any more.
  select count(*) into v_role_rows
    from public.role_permissions rp
    join public.permission_actions pa on pa.id = rp.action_id
   where rp.module_id = v_module_id
     and pa.action_key in ('view_team', 'view_all')
     and rp.role <> 'admin';
  if v_role_rows <> 0 then
    raise exception 'a non-admin role still grants Performance management visibility (% row(s))', v_role_rows;
  end if;

  -- 4c. The admin keeps everything it had.
  select count(*) into v_admin_rows
    from public.role_permissions rp
   where rp.module_id = v_module_id and rp.role = 'admin' and rp.allowed;
  if v_admin_rows < 7 then
    raise exception 'admin role grants on performance dropped to %; expected at least 7', v_admin_rows;
  end if;

  -- 4d. If the targeted id exists, it must still be the person this grant was
  --     reviewed for. A primary key does not get reassigned, but company-wide
  --     visibility is not an authority to hand over on that assumption alone —
  --     so the identity is re-checked against the email and the row count, and
  --     a mismatch stops the migration instead of quietly granting the wrong
  --     person sight of everybody.
  select id, lower(trim(email)) as email, role, is_active, is_deleted
    into v_target
    from public.users
   where id = '61f4a1f7-3c2a-435f-abca-f884301dcc96';

  if v_target.id is not null then
    if v_target.email is distinct from 'boebdm@gmail.com' then
      raise exception 'refusing to grant company-wide Performance visibility: % is %, not the reviewed account',
        v_target.id, coalesce(v_target.email, '<no email>');
    end if;
    if v_target.is_active is not true or v_target.is_deleted is true then
      raise exception 'refusing to grant Performance visibility to an inactive or deleted account (%)', v_target.id;
    end if;

    select count(*) into v_dhruv_rows
      from public.employee_permission_overrides eo
      join public.permission_actions pa on pa.id = eo.action_id
     where eo.user_id = v_target.id
       and eo.module_id = v_module_id
       and pa.action_key in ('view_team', 'view_all')
       and eo.allowed
       and eo.revoked_at is null;
    if v_dhruv_rows <> 2 then
      raise exception 'the reviewed account should hold 2 live management grants; found %', v_dhruv_rows;
    end if;

    -- 4e. And Personal Performance survived. This is the bug the whole piece of
    --     work exists to prevent coming back: a manager must not lose their own
    --     report as a side effect of a change to team visibility.
    if not exists (
      select 1
        from public.employee_permission_overrides eo
        join public.permission_actions pa on pa.id = eo.action_id
       where eo.user_id = v_target.id
         and eo.module_id = v_module_id
         and pa.action_key = 'view'
         and eo.allowed
         and eo.revoked_at is null
    ) then
      raise exception 'the reviewed account lost Personal Performance; this migration must never do that';
    end if;
  end if;
end $$;
