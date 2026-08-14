-- Access Control V1 — default-deny compatibility.
--
-- MUST RUN IMMEDIATELY AFTER 20260901000000. That migration makes stored
-- Finance and Orders grants real; this one removes the stored Orders grants
-- that must NOT become real, and converts Meetings from "everybody, by role" to
-- "the people who have it today, by name". Applying the first without the
-- second hands Order Request approval and Order amendment authority to a test
-- account. A repository test asserts these two files sort adjacently.
--
-- OWNER DECISION (2026-08-14)
-- ---------------------------
-- Test and objection accounts must carry NO operational access by default.
-- Not "no protected access" — no access at all. The earlier draft of this file
-- revoked only orders.approve and orders.manage on the reasoning that
-- 20260901000000 leaves view/create/edit inert, so removing them would be an
-- unrelated change. The owner overruled that: an inert grant is still a stored
-- decision, and the next migration that wires up Orders view/create/edit would
-- make it live without anyone re-reading this file. So all five go.
--
-- The accounts are NOT deactivated and NOT deleted. They may be granted
-- temporary explicit permissions later for a specific controlled test; their
-- DEFAULT state is no operational access.
--
-- WHAT IT DOES
-- ------------
--   1. Revokes all five of Test Sales User (DUMMY)'s stored Orders grants —
--      view, create, edit, approve and manage.
--   2. Removes the Meetings role defaults for 'member' and 'manager'.
--   3. Re-grants Meetings, per employee, to the eleven ACTIVE REAL employees
--      who hold it today — so nobody loses access on the day this lands.
--   4. Leaves future employees with no Meetings access at all, and leaves every
--      captured (DUMMY)/Objection account with no Meetings access at all.
--
-- WHAT IT DOES NOT DO
-- -------------------
--   * No change to Attendance or Payroll, management or self-service.
--   * No change to Dhruv's Finance or Orders grants — they are intentional.
--   * No change to Aditya's Assets grants, `assign` included.
--   * No change to the Contributor-level Finance/Orders rows held by Prerna,
--     Saksham, Mohit Sharma, Shravi and Ashok Choudhary. Those belong to REAL
--     employees and are preserved; the owner decision above is about test
--     accounts, not about the inert-grant question in general.
--   * It does not deactivate, delete or otherwise alter any user row.
--   * No other module's permissions are read or written.
--
-- IDENTITY
-- --------
-- Every employee is addressed by the exact UUID captured in the 2026-08-14
-- baseline. Names appear only in comments. Nothing here matches on a name at
-- runtime, so renaming an employee cannot change what this migration does, and
-- no name is used for authorization anywhere.
--
-- FAIL-SAFE
-- ---------
-- Every section asserts the state it expects BEFORE changing anything, and
-- raises if the database has moved on since the baseline. A drifted database
-- gets a failed migration and a readable message, never a partial mutation
-- against assumptions that no longer hold. The whole file runs in one
-- transaction, so any raise rolls the entire thing back.
--
-- ROLLBACK
-- --------
-- Documented in full at the foot of this file.

-- ─── 0. Baseline assertions ──────────────────────────────────────────────────

do $$
declare
  v_dummy_sales constant uuid := 'ac5e5888-cb72-4f9c-ab36-5b4d32efe54c';
  -- The five Orders overrides the 2026-08-14 baseline captured on that account,
  -- sorted, because the assertion below compares sorted arrays.
  v_expected constant text[] := array['approve', 'create', 'edit', 'manage', 'view'];
  v_meetings_id uuid;
  v_orders_id   uuid;
  v_count       int;
  v_actions     text[];
begin
  select id into v_meetings_id from public.permission_modules where module_key = 'meetings';
  select id into v_orders_id   from public.permission_modules where module_key = 'orders';

  if v_meetings_id is null or v_orders_id is null then
    raise exception 'ACCESS_CONTROL_V1: the meetings or orders permission module is missing; the baseline no longer holds';
  end if;

  -- The account whose grants are being removed must still be the account the
  -- baseline described: present, a plain member, not an admin. If somebody has
  -- since promoted it, stop and let a human look.
  select count(*) into v_count
  from public.users
  where id = v_dummy_sales and role = 'member';

  if v_count <> 1 then
    raise exception 'ACCESS_CONTROL_V1: user % is not the member account captured in the baseline (found % matching rows)',
      v_dummy_sales, v_count;
  end if;

  -- Its Orders overrides must be EXACTLY the five the baseline captured — no
  -- more, no fewer, none swapped. An exact-set comparison rather than a count:
  -- a count of five would also be satisfied by four expected rows plus one
  -- unexpected `delete`, which this migration would then revoke without anyone
  -- having decided to. Missing, unexpected and changed all fail here, before
  -- the first mutation.
  select coalesce(array_agg(pa.action_key order by pa.action_key), array[]::text[])
    into v_actions
  from public.employee_permission_overrides eo
  join public.permission_actions pa on pa.id = eo.action_id
  where eo.user_id = v_dummy_sales
    and eo.module_id = v_orders_id
    and eo.allowed
    and eo.revoked_at is null;

  if v_actions <> v_expected then
    raise exception 'ACCESS_CONTROL_V1: expected exactly the 5 baseline Orders overrides [%] for the test account, found [%]',
      array_to_string(v_expected, ', '), array_to_string(v_actions, ', ');
  end if;

  -- Snapshot every OTHER employee's active Orders overrides so the
  -- post-conditions can prove this migration touched nobody else. Transaction
  -- -local, so it evaporates whether the transaction commits or rolls back.
  select count(*) into v_count
  from public.employee_permission_overrides eo
  where eo.module_id = v_orders_id
    and eo.user_id <> v_dummy_sales
    and eo.allowed
    and eo.revoked_at is null;

  perform set_config('access_control_v1.orders_others', v_count::text, true);

  -- The Meetings role defaults being removed must still exist, in the shape the
  -- baseline recorded: member = view, manager = view/create/edit/manage.
  select count(*) into v_count
  from public.role_permissions rp
  join public.permission_actions pa on pa.id = rp.action_id
  where rp.module_id = v_meetings_id
    and rp.role in ('member', 'manager')
    and rp.allowed;

  if v_count <> 5 then
    raise exception 'ACCESS_CONTROL_V1: expected 5 Meetings role rows for member/manager, found %', v_count;
  end if;

  -- Nobody may already hold a Meetings employee override, or section 3 would be
  -- re-granting on top of an existing decision it cannot see.
  select count(*) into v_count
  from public.employee_permission_overrides
  where module_id = v_meetings_id and revoked_at is null;

  if v_count <> 0 then
    raise exception 'ACCESS_CONTROL_V1: % Meetings employee override(s) already exist; grandfathering would collide', v_count;
  end if;
end;
$$;

-- ─── 1. Revoke the test account's Orders grants ───────────────────────────────
--
-- SOFT revoke, not a delete: it matches the shape the Control Center API
-- already writes (revoked_by / revoked_at), keeps the audit trail, and is
-- undone by clearing two columns.
--
-- ALL FIVE — view, create, edit, approve and manage — per the owner decision at
-- the head of this file. approve and manage are the two 20260901000000 makes
-- live immediately; view, create and edit are inert today and are removed
-- anyway, so that wiring them up later cannot quietly hand this account Order
-- Management. The account keeps its user row and its login; what it loses is
-- every stored Orders decision.

update public.employee_permission_overrides eo
   set revoked_by = '6507df9f-cdeb-4ebd-849f-8498c165d596',  -- the system admin
       revoked_at = now()
  from public.permission_actions pa,
       public.permission_modules pm
 where pa.id = eo.action_id
   and pm.id = eo.module_id
   and eo.user_id = 'ac5e5888-cb72-4f9c-ab36-5b4d32efe54c'   -- Test Sales User (DUMMY)
   and pm.module_key = 'orders'
   and pa.action_key in ('view', 'create', 'edit', 'approve', 'manage')
   and eo.revoked_at is null;

-- ─── 2. Remove the broad Meetings role defaults ──────────────────────────────
--
-- These are what make Meetings visible to every employee in the company, and
-- they are the reason Meetings is not deny-by-default today. Section 3 re-grants
-- the same access per employee first-class, so no CURRENT employee loses
-- anything; what changes is that the NEXT employee to be created inherits
-- nothing.
--
-- The 'admin' role row is deliberately untouched — admins keep Meetings, as
-- they keep every module.

delete from public.role_permissions rp
 using public.permission_modules pm
 where pm.id = rp.module_id
   and pm.module_key = 'meetings'
   and rp.role in ('member', 'manager');

-- ─── 3. Grandfather the eleven active real employees ─────────────────────────
--
-- Exactly the access each of them resolves TODAY through the role defaults
-- removed above, re-expressed as an employee override so it survives:
--
--   Dhruv (manager)  view, create, edit, manage
--   the other ten    view
--
-- Dhruv's `manage` is a protected action and is granted here on purpose: it is
-- what he holds today, and this migration preserves current access rather than
-- re-deciding it. It will display as Custom in Access Control, which is correct.
--
-- The nine (DUMMY) and Objection test accounts identified in the baseline are
-- NOT in this list. They lose Meetings when section 2 runs, which is the point
-- and is now explicit owner policy: test accounts carry no operational access
-- by default. Post-condition 4g asserts all nine, through the engine, rather
-- than trusting their absence from this INSERT. They are listed in the Prompt 5
-- report and in the impact table in docs/Module Docs/ACCESS_CONTROL_V1.md.

insert into public.employee_permission_overrides
  (user_id, module_id, action_id, allowed, granted_by, granted_at)
select
  v.user_id,
  pm.id,
  pa.id,
  true,
  '6507df9f-cdeb-4ebd-849f-8498c165d596',   -- the system admin
  now()
from (values
  ('9322e802-7203-456d-8986-ca625f3a8b77'::uuid, 'view'),     -- Prerna
  ('b37c5ae7-b03f-4dd8-ad4c-3a210caff1f8'::uuid, 'view'),     -- Saksham
  ('9b3bc075-0652-469a-a93f-698652f0e727'::uuid, 'view'),     -- Rakesh Prajapat
  ('f8039454-9152-452d-8d33-261f58a471af'::uuid, 'view'),     -- Mohit Sharma
  ('fb6eec18-f60c-4210-a712-f265f6732557'::uuid, 'view'),     -- Shravi
  ('742c9b96-7c1c-4366-8272-99293f7ffa28'::uuid, 'view'),     -- Santosh Patel
  ('973b4337-9cae-4f66-8e7f-b158326cdc10'::uuid, 'view'),     -- Aditya
  ('fcf8bbf9-0cc4-4a6e-ba64-1143b14ef4a2'::uuid, 'view'),     -- Jasvi
  ('c725dcae-aee2-4891-875b-433f8eb6c03d'::uuid, 'view'),     -- Namrata
  ('a3d157da-9eef-4d81-9aa6-84b4aa6061d6'::uuid, 'view'),     -- Ashok Choudhary
  ('61f4a1f7-3c2a-435f-abca-f884301dcc96'::uuid, 'view'),     -- Dhruv
  ('61f4a1f7-3c2a-435f-abca-f884301dcc96'::uuid, 'create'),   -- Dhruv
  ('61f4a1f7-3c2a-435f-abca-f884301dcc96'::uuid, 'edit'),     -- Dhruv
  ('61f4a1f7-3c2a-435f-abca-f884301dcc96'::uuid, 'manage')    -- Dhruv
) as v(user_id, action_key)
join public.permission_modules pm on pm.module_key = 'meetings'
join public.permission_actions pa on pa.action_key = v.action_key
-- Only for employees who are still active and not soft-deleted. An employee
-- deactivated since the baseline is silently skipped rather than re-granted,
-- and the assertion below reports the shortfall.
join public.users u
  on u.id = v.user_id
 and u.is_active
 and coalesce(u.is_deleted, false) = false
on conflict (user_id, module_id, action_id) do nothing;

-- ─── 4. Post-conditions ──────────────────────────────────────────────────────
--
-- Proves the migration did what it claims before the transaction commits.

do $$
declare
  v_dummy_sales constant uuid := 'ac5e5888-cb72-4f9c-ab36-5b4d32efe54c';
  v_meetings_id uuid;
  v_orders_id   uuid;
  v_count       int;
  v_leaks       text;
  v_action      text;
begin
  select id into v_meetings_id from public.permission_modules where module_key = 'meetings';
  select id into v_orders_id   from public.permission_modules where module_key = 'orders';

  -- 4a. The test account holds no active Orders override AT ALL — not the five
  --     revoked above, and not some sixth row this migration never saw.
  select count(*) into v_count
  from public.employee_permission_overrides eo
  where eo.user_id = v_dummy_sales
    and eo.module_id = v_orders_id
    and eo.allowed
    and eo.revoked_at is null;

  if v_count <> 0 then
    raise exception 'ACCESS_CONTROL_V1: the test account still holds % active Orders override(s)', v_count;
  end if;

  -- 4b. And no Orders authority reaches it through ANY level of the engine.
  --     Clearing the overrides only closes one of four doors:
  --     resolve_effective_permissions walks employee override → department →
  --     role → system default and reports which level decided, so this catches
  --     a department or role grant that never appeared in
  --     employee_permission_overrides and would otherwise be invisible here.
  --     It sweeps every action the Orders module registers, so `delete`,
  --     `export` and `can_be_order_assignee` are covered without naming them.
  select coalesce(
           string_agg(r.action_key || ' via ' || r.source, ', ' order by r.action_key),
           ''
         )
    into v_leaks
  from public.resolve_effective_permissions(v_dummy_sales, 'orders') r
  where r.allowed;

  if v_leaks <> '' then
    raise exception 'ACCESS_CONTROL_V1: the test account still resolves Orders authority: %', v_leaks;
  end if;

  -- 4c. The four authorities the owner decision names explicitly, asserted BY
  --     NAME as well. 4b already covers the registered ones, but naming them
  --     means that if a later migration registers `orders.admin`, or drops and
  --     re-adds can_be_order_assignee, this file still fails loudly rather than
  --     silently narrowing its own sweep.
  foreach v_action in array array['delete', 'export', 'admin', 'can_be_order_assignee'] loop
    if public.resolve_permission(v_dummy_sales, 'orders', v_action) then
      raise exception 'ACCESS_CONTROL_V1: the test account resolves orders.% through some other source', v_action;
    end if;
  end loop;

  -- 4d. Every OTHER employee's Orders access is exactly what it was before this
  --     migration ran. The UPDATE is scoped by user_id so touching anyone else
  --     should be impossible; this proves it rather than trusting it.
  select count(*) into v_count
  from public.employee_permission_overrides eo
  where eo.module_id = v_orders_id
    and eo.user_id <> v_dummy_sales
    and eo.allowed
    and eo.revoked_at is null;

  if v_count <> current_setting('access_control_v1.orders_others')::int then
    raise exception 'ACCESS_CONTROL_V1: other employees'' active Orders overrides changed from % to %',
      current_setting('access_control_v1.orders_others'), v_count;
  end if;

  -- 4e. No Meetings role default survives for member or manager.
  select count(*) into v_count
  from public.role_permissions rp
  where rp.module_id = v_meetings_id and rp.role in ('member', 'manager');

  if v_count <> 0 then
    raise exception 'ACCESS_CONTROL_V1: % Meetings role default(s) survived', v_count;
  end if;

  -- 4f. All fourteen grandfathered rows landed (11 employees; Dhruv holds four).
  select count(*) into v_count
  from public.employee_permission_overrides
  where module_id = v_meetings_id and allowed and revoked_at is null;

  if v_count <> 14 then
    raise exception 'ACCESS_CONTROL_V1: expected 14 grandfathered Meetings rows, found % — an employee may have been deactivated since the baseline', v_count;
  end if;

  -- 4g. Not one of the nine captured (DUMMY)/Objection accounts resolves
  --     Meetings any more. Section 2 removed the role defaults that gave it to
  --     them and section 3 did not re-grant it, but the owner decision is
  --     explicit that these accounts end with no operational access, so it is
  --     asserted rather than inferred. Checked through the engine, so a
  --     department or override grant would be caught too.
  foreach v_action in array array[
    '890f0067-cef5-4d9c-9fdd-98fe407f3cbd',  -- Objection B
    '27e2f32b-f12b-4a6a-aebd-c44d2ce1db7f',  -- Test Management User (DUMMY)
    'ac5e5888-cb72-4f9c-ab36-5b4d32efe54c',  -- Test Sales User (DUMMY)
    'f4df0228-319c-4baa-947d-a3f709a0e8a3',  -- Test Operations User (DUMMY)
    '47b9bdc8-c73b-44f2-a675-aa3290a4e470',  -- Test HR User (DUMMY)
    'be0a101a-6bfb-495b-8e95-30a7c104be04',  -- Test Design User (DUMMY)
    'e2a14cb8-38ca-43e6-8703-3eb28b839375',  -- Objection A
    'eadf65b1-98c1-4c63-ba0f-816cc171f81e',  -- Test Admin Dept User (DUMMY)
    '57b11e89-a90b-407d-b92b-c4b0354f77fa'   -- Test Marketing User (DUMMY)
  ] loop
    select coalesce(
             string_agg(r.action_key || ' via ' || r.source, ', ' order by r.action_key),
             ''
           )
      into v_leaks
    from public.resolve_effective_permissions(v_action::uuid, 'meetings') r
    where r.allowed;

    if v_leaks <> '' then
      raise exception 'ACCESS_CONTROL_V1: test account % still resolves Meetings: %', v_action, v_leaks;
    end if;
  end loop;

  -- 4h. Dhruv keeps every Finance and Orders grant. This migration must not
  --     have touched them; if it did, stop.
  select count(*) into v_count
  from public.employee_permission_overrides eo
  join public.permission_modules pm on pm.id = eo.module_id
  where eo.user_id = '61f4a1f7-3c2a-435f-abca-f884301dcc96'
    and pm.module_key in ('finance', 'orders')
    and eo.allowed
    and eo.revoked_at is null;

  if v_count < 15 then
    raise exception 'ACCESS_CONTROL_V1: Dhruv holds only % active Finance/Orders grants; 15 were expected', v_count;
  end if;

  -- 4i. Aditya keeps Assets, `assign` included.
  select count(*) into v_count
  from public.employee_permission_overrides eo
  join public.permission_modules pm on pm.id = eo.module_id
  join public.permission_actions pa on pa.id = eo.action_id
  where eo.user_id = '973b4337-9cae-4f66-8e7f-b158326cdc10'
    and pm.module_key = 'assets_access'
    and pa.action_key = 'assign'
    and eo.allowed
    and eo.revoked_at is null;

  if v_count <> 1 then
    raise exception 'ACCESS_CONTROL_V1: Aditya no longer holds the Assets assign grant';
  end if;
end;
$$;

-- ─── 5. ROLLBACK PLAN ────────────────────────────────────────────────────────
--
-- Reversible in three statements. No row was destroyed except the two Meetings
-- role-default groups, which are recreated from the same values 20260814000000
-- seeded.
--
-- Step 1 — restore all five of the test account's Orders grants (soft revoke,
--          so this is just clearing two columns):
--
--   update public.employee_permission_overrides eo
--      set revoked_by = null, revoked_at = null
--     from public.permission_actions pa, public.permission_modules pm
--    where pa.id = eo.action_id and pm.id = eo.module_id
--      and eo.user_id = 'ac5e5888-cb72-4f9c-ab36-5b4d32efe54c'
--      and pm.module_key = 'orders'
--      and pa.action_key in ('view', 'create', 'edit', 'approve', 'manage')
--      and eo.revoked_by = '6507df9f-cdeb-4ebd-849f-8498c165d596'
--      and eo.revoked_at is not null;
--
--   EXPECT EXACTLY 5 ROWS. The revoked_by filter scopes the restore to rows
--   this migration revoked, so an Orders grant revoked earlier by someone else
--   is left revoked. If the count is not 5, the account's Orders overrides
--   moved after this migration ran — stop and reconcile by hand rather than
--   clearing more than was revoked here.
--
--   This restores the account to its pre-migration state exactly: five active
--   Orders overrides, view/create/edit/approve/manage, same rows, same
--   granted_by, same granted_at, audit trail intact.
--
-- Step 2 — restore the Meetings role defaults:
--
--   insert into public.role_permissions (role, module_id, action_id, allowed)
--   select 'manager', mpa.module_id, mpa.action_id, true
--   from public.module_permission_actions mpa
--   join public.permission_modules pm on pm.id = mpa.module_id and pm.module_key = 'meetings'
--   join public.permission_actions pa  on pa.id = mpa.action_id
--   where pa.action_key in ('view', 'create', 'edit', 'manage')
--   on conflict (role, module_id, action_id) do nothing;
--
--   insert into public.role_permissions (role, module_id, action_id, allowed)
--   select 'member', mpa.module_id, mpa.action_id, true
--   from public.module_permission_actions mpa
--   join public.permission_modules pm on pm.id = mpa.module_id and pm.module_key = 'meetings'
--   join public.permission_actions pa  on pa.id = mpa.action_id
--   where pa.action_key = 'view'
--   on conflict (role, module_id, action_id) do nothing;
--
-- Step 3 — remove the grandfathered overrides, which are then redundant:
--
--   delete from public.employee_permission_overrides eo
--    using public.permission_modules pm
--    where pm.id = eo.module_id and pm.module_key = 'meetings'
--      and eo.granted_by = '6507df9f-cdeb-4ebd-849f-8498c165d596';
--
-- Rolling back restores exactly the access that exists today, including all
-- five of the test account's Orders grants and the nine test accounts' Meetings
-- access. Nothing in this migration is one-way.
