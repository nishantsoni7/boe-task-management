-- Order Requests: restrict who may be selected as Assignee.
--
-- Business rule: an Order Request Assignee may be
--   (1) any active member of the Sales team, OR
--   (2) any active employee explicitly authorised via the permission engine.
--
-- Reuses the existing centralized permission engine
-- (20260660_create_permission_engine.sql) rather than inventing a parallel
-- mechanism: one new custom action_key, 'can_be_order_assignee', registered
-- under the existing 'orders' module (same pattern as Sample Tracking's
-- custom 'dispatch'/'receive'/'mark_lost'/'close' actions). Exceptions are
-- granted via employee_permission_overrides (level 4, per-user) — never via
-- role_permissions — so this deliberately does NOT broaden eligibility to
-- every admin/manager/operations/bdm employee; only people who separately
-- receive the explicit override qualify.
--
-- No names/emails/ids are hardcoded in application code or in any RLS/
-- trigger logic — the two SQL helpers below only ever reference users.team
-- and the permission engine. The one-time data grant for named individuals
-- (Part 4) is the sole place specific people are referenced, resolved by
-- employee_code (stable), never by full_name.

-- ── 1. Register the new permission action under the existing 'orders' module ──
-- Self-contained (does not depend on `npm run permissions:sync` having run
-- first): permission_actions/module_permission_actions rows are seeded here
-- directly, exactly the tables scripts/sync-permissions.ts would otherwise
-- populate from src/lib/permissions/modules.ts. That TS registry is updated
-- in the same change so `permissions:check` stays in sync.

insert into public.permission_actions (action_key, display_name, is_system)
values ('can_be_order_assignee', 'Can Be Order Assignee', false)
on conflict (action_key) do nothing;

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key = 'can_be_order_assignee'
where pm.module_key = 'orders'
on conflict (module_id, action_id) do nothing;

-- ── 2. Eligibility helper — single source of truth for the rule ──────────────

create or replace function public.is_eligible_order_assignee(p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.users u
    where u.id = p_user_id
      and u.is_active
      and (
        u.team = 'sales'
        or public.resolve_permission(u.id, 'orders', 'can_be_order_assignee')
      )
  );
$$;

revoke execute on function public.is_eligible_order_assignee(uuid) from public, anon;
grant  execute on function public.is_eligible_order_assignee(uuid) to authenticated;

-- ── 3. List function — feeds the frontend dropdown (Sales Team / Authorised) ─
-- SECURITY DEFINER so any authenticated user can see the eligible-assignee
-- list regardless of their own row-level visibility into other users' rows
-- (in particular, employee_permission_overrides only lets a user read their
-- own row — a plain client-side query could never build this list).
-- Exposes strictly less than the previous dropdown (which queried ALL active
-- users), so this is not a new visibility widening.

create or replace function public.list_eligible_order_assignees()
returns table (id uuid, full_name text, source text)
language sql
security definer
stable
set search_path = public
as $$
  select t.id, t.full_name, t.source
  from (
    select u.id, u.full_name, 'sales'::text as source
    from public.users u
    where u.is_active and u.team = 'sales'

    union all

    select u.id, u.full_name, 'override'::text as source
    from public.users u
    where u.is_active
      and u.team <> 'sales'
      and public.resolve_permission(u.id, 'orders', 'can_be_order_assignee')
  ) t
  order by t.source, t.full_name;
$$;

revoke execute on function public.list_eligible_order_assignees() from public, anon;
grant  execute on function public.list_eligible_order_assignees() to authenticated;

-- ── 4. Trusted validation on order_requests writes ───────────────────────────
-- Covers all three write paths in one place: the direct client INSERT used
-- by Submit, and the UPDATE statements inside resubmit_order_request /
-- reapply_order_request (both already SECURITY DEFINER) — no changes needed
-- inside either RPC body.
--
-- Only a CHANGED assigned_to is re-validated: on UPDATE, a value equal to
-- the existing row's assigned_to is left alone even if it would no longer
-- qualify today, so a legacy assignment already on a request is preserved
-- and never silently cleared or rejected by this migration.
--
-- Explicit IF/ELSIF branching (not an OR combining TG_OP with an OLD
-- reference): OLD is unassigned during INSERT, and PostgreSQL does not
-- guarantee AND/OR evaluation order, so a single combined boolean condition
-- risks "record \"old\" is not assigned yet" on every INSERT. Branching on
-- TG_OP first means the ELSIF arm — the only place OLD is referenced — is
-- never reached during INSERT, mirroring the existing, proven pattern in
-- log_order_request_activity() (20260683000000_add_order_request_clarification_workflow.sql).

create or replace function public.validate_order_request_assignee()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.assigned_to is not null and not public.is_eligible_order_assignee(new.assigned_to) then
      raise exception 'Assignee must be an active Sales team member or an authorised Order Assignee.'
        using errcode = 'P0001';
    end if;
  elsif new.assigned_to is distinct from old.assigned_to then
    if new.assigned_to is not null and not public.is_eligible_order_assignee(new.assigned_to) then
      raise exception 'Assignee must be an active Sales team member or an authorised Order Assignee.'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists order_requests_validate_assignee on public.order_requests;
create trigger order_requests_validate_assignee
  before insert or update on public.order_requests
  for each row execute function public.validate_order_request_assignee();

-- Invoked only by the trigger above, never called directly by application
-- code or PostgREST — no authenticated grant needed, unlike
-- is_eligible_order_assignee()/list_eligible_order_assignees() above.
revoke execute on function public.validate_order_request_assignee() from public, anon;

-- ── 5. Named exceptions — resolved by employee_code, never by full_name ──────
-- Confirmed via a live, read-only lookup before writing this migration:
--   Dhruv   -> employee_code 'BOE-002'  (email boebdm@gmail.com, team=management, role=manager)
--   Nishant -> employee_code 'TEST-001' (email admin@bestofexports.com, team=admin, role=admin)
-- "Nitish" (described as heading Operations) has NO matching user record in
-- this database under any spelling searched ('nitish', 'nit') and the only
-- row on team='operations' is a dummy test account — deliberately omitted
-- from this migration per explicit instruction; add a third VALUES row here
-- once that person's real identifier is confirmed.
--
-- granted_by is Nishant's own id (the admin account resolving this grant),
-- matching the NOT NULL FK on employee_permission_overrides.granted_by.

insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by, granted_at)
select u.id, pm.id, pa.id, true, g.id, now()
from (values
    ('BOE-002'),  -- Dhruv (BDM)
    ('TEST-001')  -- Nishant (admin)
  ) as grants(employee_code)
join public.users u on u.employee_code = grants.employee_code
cross join (select id from public.permission_modules where module_key = 'orders') pm
cross join (select id from public.permission_actions where action_key = 'can_be_order_assignee') pa
cross join (select id from public.users where employee_code = 'TEST-001') g
on conflict (user_id, module_id, action_id) do nothing;
