-- ═════════════════════════════════════════════════════════════════════════════
-- A PRODUCTION-SHAPED order_requests, for the retirement dry run
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS, AND WHY IT IS SEPARATE FROM _production_shaped_schema.sql
-- -------------------------------------------------------------------------
-- That file states, in its own words, that it does not model `order_requests`:
-- its two Finance policies anchored on the table are stubbed to `false` so the
-- policy COUNT is right without pretending the table is there. Retiring the
-- Order Request workflow is exactly the change that needs the table modelled,
-- so this is its companion rather than an edit to it — nothing that suite
-- proves about payment visibility changes here.
--
-- IT EXISTS BECAUSE A TEXT ASSERTION MISSED A REAL POLICY. Migration
-- 20261007000000 shipped with an apply-time check that counted every policy on
-- `order_requests` whose `cmd` was INSERT or ALL, and refused the apply when it
-- found any. The linked database has a policy with `cmd = ALL` —
-- `order_requests_module_entry_gate`, from 20260905000000 — so the migration
-- refused itself:
--
--     order_requests still has 1 INSERT-capable polic(ies);
--     the retired workflow would remain creatable
--
-- That gate is RESTRICTIVE. A restrictive policy is AND-ed with the permissive
-- ones and can only ever NARROW access; it grants nothing, and dropping it
-- would WIDEN the table rather than retire it. The defect was in the assertion,
-- which never asked whether the policy it found was permissive. No amount of
-- reading the migration text would have caught that — only running it against
-- the real policy set does, which is what this harness is for.
--
-- WHAT IS FAITHFUL
-- ----------------
-- Every policy that has ever been created on `public.order_requests`, applied
-- in migration order with the drops in between, so the final set is arrived at
-- the way production arrived at it rather than declared. `module_entry_open` is
-- 20260905000000 §1 verbatim in behaviour.
--
-- WHAT IS STUBBED
-- ---------------
-- `resolve_permission()`, backed by a plain grants table, exactly as the
-- payment harness stubs it — its real definition pulls in the permission
-- engine's whole table set and none of that is what is under test here.
--
-- The RPCs are NOT modelled. They are SECURITY DEFINER and therefore bypass RLS
-- entirely, which is the single fact the retirement relies on; a stub of one
-- would prove nothing about the real one. What IS modelled is the grant surface
-- they are revoked from, in the assertion suite.
--
-- NOT A BASELINE SCHEMA. It must never be added to supabase/migrations. It
-- creates only what the `order_requests` visibility rules touch, and it is built
-- to be thrown away.

create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role bypassrls; end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth   to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- ── Tables ───────────────────────────────────────────────────────────────────
--
-- Only the columns the policies, the provenance guard and the retirement's own
-- assertions actually read.

create table public.users (
  id uuid primary key, full_name text, role text, team text,
  is_active boolean not null default true, is_deleted boolean not null default false);

create table public.orders (
  id uuid primary key,
  display_number text,
  status text not null default 'running',
  client_name text,
  requested_by uuid,
  assigned_to uuid,
  -- The provenance a converted request leaves on the Order it became
  -- (20260701000000). The retirement must not remove either column, and the
  -- migration asserts both are still present.
  source_order_request_id uuid,
  source_request_number text);

create table public.order_requests (
  id uuid primary key default gen_random_uuid(),
  request_number text,
  status text not null default 'submitted',
  client_name text,
  created_by uuid,
  requested_by uuid,
  assigned_to uuid,
  -- 20260711000000: an upload-stage draft has no verified Main PI and is not a
  -- real submission. Three of the four SELECT policies read this.
  finalized_at timestamptz,
  converted_order_id uuid references public.orders(id),
  converted_at timestamptz,
  created_at timestamptz not null default now());

create table public.order_request_activity (
  id uuid primary key default gen_random_uuid(),
  order_request_id uuid not null references public.order_requests(id) on delete cascade,
  event_type text);

create table public.order_request_attachments (
  id uuid primary key default gen_random_uuid(),
  order_request_id uuid not null references public.order_requests(id) on delete cascade,
  storage_path text);

-- The Finance ledger, only far enough to prove the retirement leaves it alone
-- and to hold the retired linkage columns the guard watches.
create table public.finance_payment_requests (
  id uuid primary key default gen_random_uuid(),
  request_number text,
  client_name text,
  amount numeric,
  status text not null default 'pending_approval',
  submitted_by uuid,
  order_id uuid references public.orders(id),
  order_request_id uuid references public.order_requests(id),
  order_request_number text);

-- ── The permission stubs ─────────────────────────────────────────────────────

create table public.t_permission_grants (
  user_id uuid, module_key text, action_key text);

create or replace function public.resolve_permission(
  p_user_id uuid, p_module_key text, p_action_key text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.t_permission_grants g
    where g.user_id = p_user_id and g.module_key = p_module_key and g.action_key = p_action_key
  );
$$;

-- 20260905000000 §1, verbatim in behaviour.
create or replace function public.module_entry_open(p_module_key text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
    or public.resolve_permission(auth.uid(), p_module_key, 'view');
$$;

grant execute on function public.resolve_permission(uuid, text, text) to authenticated;
grant execute on function public.module_entry_open(text) to authenticated;

-- ── Table privileges, as the platform leaves them ────────────────────────────
--
-- Supabase bootstraps `alter default privileges ... grant all on tables to anon,
-- authenticated, service_role`, so a client role holds SELECT/INSERT/UPDATE/
-- DELETE on every table and RLS is the only thing standing between it and the
-- rows. Reproduced here, because a harness that withheld the privilege would
-- prove the retirement works for a reason production does not have.

grant select, insert, update, delete on
  public.order_requests, public.order_request_activity,
  public.order_request_attachments, public.orders,
  public.finance_payment_requests, public.users
  to authenticated;
grant select on public.t_permission_grants to authenticated;

alter table public.order_requests            enable row level security;
alter table public.order_request_activity    enable row level security;
alter table public.order_request_attachments enable row level security;
alter table public.orders                    enable row level security;
alter table public.finance_payment_requests  enable row level security;

-- ═════════════════════════════════════════════════════════════════════════════
-- The policy history of public.order_requests, replayed in migration order
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Applied the way production applied it — creates and drops in sequence — so the
-- final set is ARRIVED AT rather than declared. Declaring it would let a mistake
-- in this file's own reading of the history pass unnoticed.

-- ── 20260680000000: the table's original six ────────────────────────────────
create policy "order_requests_requester_select" on public.order_requests
  for select to authenticated
  using (requested_by = auth.uid() or created_by = auth.uid());

create policy "order_requests_admin_select" on public.order_requests
  for select to authenticated
  using (exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin'));

create policy "order_requests_requester_insert" on public.order_requests
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and status = 'submitted'
    and converted_order_id is null
    and converted_at is null
  );

create policy "order_requests_requester_update" on public.order_requests
  for update to authenticated
  using ((created_by = auth.uid() or requested_by = auth.uid())
         and status in ('submitted', 'needs_clarification'))
  with check ((created_by = auth.uid() or requested_by = auth.uid())
              and status in ('submitted', 'needs_clarification')
              and converted_order_id is null and converted_at is null);

create policy "order_requests_admin_update" on public.order_requests
  for update to authenticated
  using (exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin'))
  with check (exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin'));

create policy "order_requests_admin_delete" on public.order_requests
  for delete to authenticated
  using (exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin'));

-- ── 20260683000000 §3: the requester update bypass is closed ────────────────
drop policy if exists "order_requests_requester_update" on public.order_requests;

-- ── 20260687000000 §: the admin update bypass is closed ─────────────────────
drop policy if exists "order_requests_admin_update" on public.order_requests;

-- ── 20260705000000: the admin delete is NARROWED, not removed ───────────────
--
-- "deleting a mistakenly-submitted request that was never converted is
-- legitimate cleanup, not history destruction" — the migration's own words.
drop policy if exists "order_requests_admin_delete" on public.order_requests;

create policy "order_requests_admin_delete_unconverted" on public.order_requests
  for delete to authenticated
  using (
    status <> 'converted'
    and converted_order_id is null
    and exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );

-- ── 20260707000000 §: the assignee may see the request ──────────────────────
create policy "order_requests_assignee_select" on public.order_requests
  for select to authenticated
  using (assigned_to = auth.uid());

-- ── 20260710000000 §2: the insert gains the self-assign rule ────────────────
drop policy if exists "order_requests_requester_insert" on public.order_requests;

create policy "order_requests_requester_insert" on public.order_requests
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and status = 'submitted'
    and converted_order_id is null
    and converted_at is null
    and (
      assigned_to = auth.uid()
      or exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
    )
  );

-- ── 20260711000000 §3: an upload-stage draft is nobody else's business ──────
drop policy if exists "order_requests_admin_select" on public.order_requests;
create policy "order_requests_admin_select" on public.order_requests
  for select to authenticated
  using (
    finalized_at is not null
    and exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );

drop policy if exists "order_requests_assignee_select" on public.order_requests;
create policy "order_requests_assignee_select" on public.order_requests
  for select to authenticated
  using (finalized_at is not null and assigned_to = auth.uid());

-- ── 20260903000000 §: company-wide sight, on its own protected action ───────
create policy "order_requests_view_all_select" on public.order_requests
  for select to authenticated
  using (resolve_permission(auth.uid(), 'orders', 'view_all'));

-- ── 20260905000000 §2: THE RESTRICTIVE PARENT GATE ──────────────────────────
--
-- THIS IS THE `cmd = ALL` POLICY the failed apply found. It is RESTRICTIVE: it
-- is AND-ed with the permissive policies above and can only narrow them. It
-- grants nothing, and with the permissive INSERT policy gone there is no
-- permissive INSERT policy left for it to narrow — so INSERT is refused whether
-- this gate is present or not, and dropping it would remove a restriction
-- rather than add one.
--
-- Created by a DO block in the real migration, one gate per module data table,
-- named `<table>_module_entry_gate`.
create policy "order_requests_module_entry_gate" on public.order_requests
  as restrictive for all to authenticated
  using (public.module_entry_open('orders'))
  with check (public.module_entry_open('orders'));

-- The sibling gates, so the two child tables behave as they do in production.
create policy "order_request_activity_module_entry_gate" on public.order_request_activity
  as restrictive for all to authenticated
  using (public.module_entry_open('orders')) with check (public.module_entry_open('orders'));
create policy "order_request_activity_requester_select" on public.order_request_activity
  for select to authenticated
  using (exists (select 1 from public.order_requests r
                  where r.id = order_request_activity.order_request_id));

create policy "order_request_attachments_module_entry_gate" on public.order_request_attachments
  as restrictive for all to authenticated
  using (public.module_entry_open('orders')) with check (public.module_entry_open('orders'));
create policy "order_request_attachments_select" on public.order_request_attachments
  for select to authenticated
  using (exists (select 1 from public.order_requests r
                  where r.id = order_request_attachments.order_request_id));

-- Orders and Finance, far enough to prove the retirement leaves them working.
create policy "orders_admin_select" on public.orders
  for select to authenticated
  using (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin'));
create policy "orders_participant_select" on public.orders
  for select to authenticated
  using (requested_by = auth.uid() or assigned_to = auth.uid());
create policy "orders_module_entry_gate" on public.orders
  as restrictive for all to authenticated
  using (public.module_entry_open('orders')) with check (public.module_entry_open('orders'));

create policy "finance_payment_requests_own_select" on public.finance_payment_requests
  for select to authenticated using (submitted_by = auth.uid());
create policy "finance_payment_requests_own_insert" on public.finance_payment_requests
  for insert to authenticated with check (submitted_by = auth.uid());
create policy "finance_payment_requests_own_update" on public.finance_payment_requests
  for update to authenticated
  using (submitted_by = auth.uid() and status <> 'approved_linked')
  with check (submitted_by = auth.uid());
create policy "finance_payment_requests_module_entry_gate" on public.finance_payment_requests
  as restrictive for all to authenticated
  using (public.module_entry_open('finance')) with check (public.module_entry_open('finance'));

-- ═════════════════════════════════════════════════════════════════════════════
-- The retired RPCs, as GRANT SURFACE only
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Their bodies are irrelevant and a stub of one would prove nothing about the
-- real function. What the retirement does to them is REVOKE EXECUTE, and that
-- is a property of the catalog entry, so the catalog entry is what this creates:
-- the same names, the same argument counts, and the same grant to
-- `authenticated` that the deployed ones carry.
--
-- SECURITY DEFINER, like the originals, so the suite can also prove the thing
-- the whole retirement rests on: a definer function bypasses RLS, which is why
-- the cleanup and unlink paths keep working after every policy is narrowed.

do $$
declare
  v_name text;
begin
  foreach v_name in array array[
    -- The ten the retirement revokes.
    'finalize_order_request', 'resubmit_order_request', 'reapply_order_request',
    'respond_to_clarification', 'edit_order_request', 'edit_order_request_attachments',
    'request_order_request_clarification', 'reject_order_request',
    'convert_order_request_to_order', 'link_finance_payment_to_order_request',
    -- The four that must keep working, so nothing is stranded.
    'admin_delete_order_request', 'cleanup_unfinalized_order_request',
    'remove_unfinalized_order_request_attachment', 'unlink_finance_payment_from_order_request',
    -- Finance's own doors, which the retirement must leave alone.
    'approve_finance_payment_request', 'allocate_payment_to_target',
    'reverse_payment_allocation', 'link_finance_payment_to_order'
  ] loop
    execute format($f$
      create or replace function public.%I(p_id uuid default null)
      returns jsonb language plpgsql security definer set search_path = public, pg_temp as $body$
      begin return jsonb_build_object('stub', %L); end;
      $body$;
    $f$, v_name, v_name);
    execute format('grant execute on function public.%I(uuid) to authenticated', v_name);
  end loop;
end $$;

-- convert_order_request_to_order really does have two overloads in the catalog
-- (20260702000000 and 20260901000000), and so does reject_order_request. The
-- retirement revokes BY NAME across every overload, and revoking one while
-- leaving the other is the exact gap that would make it a no-op — so both are
-- present here.
create or replace function public.convert_order_request_to_order(
  p_order_request_id uuid, p_payment_request_ids uuid[])
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin return jsonb_build_object('stub', 'convert_order_request_to_order/2'); end;
$$;
grant execute on function public.convert_order_request_to_order(uuid, uuid[]) to authenticated;

create or replace function public.reject_order_request(p_order_request_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin return jsonb_build_object('stub', 'reject_order_request/2'); end;
$$;
grant execute on function public.reject_order_request(uuid, text) to authenticated;

-- A definer function that DELETES a request, so the suite can prove the cleanup
-- path still works once every client-facing DELETE policy is gone. This is the
-- shape admin_delete_order_request has: definer, admin-gated, and therefore
-- unaffected by RLS.
create or replace function public.t_definer_delete_request(p_id uuid)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count int;
begin
  delete from public.order_requests where id = p_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
grant execute on function public.t_definer_delete_request(uuid) to authenticated;

-- The same for clearing a retired payment linkage, which is how historical money
-- reaches a real target.
create or replace function public.t_definer_unlink_payment(p_id uuid)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count int;
begin
  update public.finance_payment_requests
     set order_request_id = null, order_request_number = null
   where id = p_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
grant execute on function public.t_definer_unlink_payment(uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- The allocation spine and the PRE-108 projection
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Only so the suite can prove the last thing that matters about ordering:
-- migration 20261008000000 still applies cleanly on top of the corrected
-- 20261007000000. It replaces `finance_received_payments` with CREATE OR
-- REPLACE, which requires the view to already exist with the same leading
-- columns — so the view has to be here in the shape 20261004000000 left it.
--
-- Faithful to 20261004000000 §1. Nothing here is under test in its own right;
-- payment_classification_assertions.sql is where the projection's behaviour is
-- proved.

create table public.order_submissions (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'submitted',
  client_name text,
  created_by uuid, submitted_by uuid, assigned_to uuid);

alter table public.finance_payment_requests
  add column if not exists payment_date date,
  add column if not exists payment_mode text,
  add column if not exists received_in text,
  add column if not exists proof_note text,
  add column if not exists order_number text,
  add column if not exists sales_note text,
  add column if not exists payment_against text default 'new_order',
  add column if not exists approved_by uuid,
  add column if not exists admin_note text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists approved_at timestamptz;

create table public.finance_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_request_id uuid not null references public.finance_payment_requests(id),
  order_submission_id uuid references public.order_submissions(id),
  order_id uuid references public.orders(id),
  allocated_amount numeric not null,
  status text not null default 'active',
  origin_target_type text not null default 'confirmed_order',
  created_by uuid,
  created_at timestamptz not null default now());

create index finance_payment_allocations_payment_active_idx
  on public.finance_payment_allocations (payment_request_id)
  where status = 'active';

create or replace function public.actor_has_module_permission(p_module_key text, p_action_key text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select
    exists (select 1 from public.users u
             where u.id = auth.uid() and u.role = 'admin'
               and u.is_active and coalesce(u.is_deleted, false) = false)
    or (exists (select 1 from public.users u
                 where u.id = auth.uid() and u.is_active
                   and coalesce(u.is_deleted, false) = false)
        and public.resolve_permission(auth.uid(), p_module_key, p_action_key));
$$;
grant execute on function public.actor_has_module_permission(text, text) to authenticated;

-- 20261004000000 §1, verbatim.
create or replace view public.finance_received_payments
with (security_invoker = true) as
select
  f.id, f.request_number, f.client_name, f.amount, f.payment_date, f.payment_mode,
  f.received_in, f.proof_note, f.order_number, f.order_id, f.order_request_id,
  f.order_request_number, f.sales_note, f.status, f.payment_against, f.submitted_by,
  f.approved_by, f.admin_note, f.created_at, f.approved_at,
  eb.full_name as submitted_by_name,
  ab.full_name as approved_by_name,
  alloc.order_id       as allocated_order_id,
  alloc.display_number as allocated_order_number,
  (alloc.order_id is not null) as is_order_allocated,
  coalesce(totals.allocated_total, 0) as allocated_total,
  case
    when coalesce(totals.allocated_total, 0) > 0 then coalesce(totals.allocated_total, 0)
    when f.order_id is not null                  then f.amount
    else 0
  end as attributed_total,
  case
    when f.amount is null then null
    when (case when coalesce(totals.allocated_total, 0) > 0 then coalesce(totals.allocated_total, 0)
               when f.order_id is not null                  then f.amount
               else 0 end) = 0                     then 'unallocated'
    when (case when coalesce(totals.allocated_total, 0) > 0 then coalesce(totals.allocated_total, 0)
               when f.order_id is not null                  then f.amount
               else 0 end) > f.amount              then 'over'
    when (case when coalesce(totals.allocated_total, 0) > 0 then coalesce(totals.allocated_total, 0)
               when f.order_id is not null                  then f.amount
               else 0 end) = f.amount              then 'full'
    else 'partial'
  end as allocation_state
from public.finance_payment_requests f
left join public.users eb on eb.id = f.submitted_by
left join public.users ab on ab.id = f.approved_by
left join lateral (
  select a.order_id, o.display_number
  from public.finance_payment_allocations a
  left join public.orders o on o.id = a.order_id
  where a.payment_request_id = f.id and a.status = 'active' and a.order_id is not null
  order by a.created_at, a.id limit 1
) alloc on true
left join lateral (
  select sum(a.allocated_amount) as allocated_total
  from public.finance_payment_allocations a
  where a.payment_request_id = f.id and a.status = 'active'
) totals on true;

revoke all privileges on public.finance_received_payments from public, anon, authenticated;
grant select on public.finance_received_payments to authenticated;
grant select on public.finance_payment_allocations, public.order_submissions to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- The fixtures
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Historical rows, as they exist on a database that ran the Order Request
-- workflow for real. They are seeded HERE, before the retirement, for two
-- reasons that both matter:
--
--   * migration 20261007000000's own behavioural probes (§5f) read a FINALIZED
--     request as an admin, as its owner and as an unrelated user. With no such
--     row the migration skips them with a NOTICE and proves nothing — so the
--     harness has to hand it one.
--   * the census the migration takes before its assertions and compares after
--     them is only load-bearing when the counts are non-zero.
--
-- Five people, because the visibility matrix needs five distinct answers:
--
--   ADMIN     users.role = 'admin'                  — sees it, and opens the module by role
--   OWNER     the request's requested_by/created_by — sees it, own row
--   ASSIGNEE  the request's assigned_to             — sees it, finalized only
--   VIEWALL   holds orders:view_all                 — sees it, company-wide sight
--   OUTSIDER  holds orders:view and nothing else    — opens the module, sees NO row
--   STRANGER  holds nothing                         — the module gate closes first
--
-- OUTSIDER is the one that catches a policy written too wide: they pass the
-- RESTRICTIVE module gate, so the permissive SELECT policies are the only thing
-- deciding, and the right answer is still zero rows.

insert into public.users (id, full_name, role) values
  ('11111111-0000-4000-8000-000000000001', 'Fixture Admin',    'admin'),
  ('11111111-0000-4000-8000-000000000002', 'Fixture Owner',    'user'),
  ('11111111-0000-4000-8000-000000000003', 'Fixture Assignee', 'user'),
  ('11111111-0000-4000-8000-000000000004', 'Fixture ViewAll',  'user'),
  ('11111111-0000-4000-8000-000000000005', 'Fixture Outsider', 'user'),
  ('11111111-0000-4000-8000-000000000006', 'Fixture Stranger', 'user');

insert into public.t_permission_grants (user_id, module_key, action_key) values
  ('11111111-0000-4000-8000-000000000002', 'orders', 'view'),
  ('11111111-0000-4000-8000-000000000003', 'orders', 'view'),
  ('11111111-0000-4000-8000-000000000004', 'orders', 'view'),
  ('11111111-0000-4000-8000-000000000004', 'orders', 'view_all'),
  ('11111111-0000-4000-8000-000000000005', 'orders', 'view'),
  ('11111111-0000-4000-8000-000000000002', 'finance', 'view'),
  ('11111111-0000-4000-8000-000000000005', 'finance', 'view');

-- The confirmed Order a request became, carrying the provenance the retirement
-- is forbidden to erase.
insert into public.orders (id, display_number, status, client_name, source_order_request_id, source_request_number)
values ('22222222-0000-4000-8000-0000000000a1', 'FIXTURE-ORDER-1', 'running', 'Fixture Client',
        '33333333-0000-4000-8000-0000000000b1', 'REQ-FIXTURE-1');

-- One FINALIZED historical request: the row every visibility assertion reads.
insert into public.order_requests
  (id, request_number, status, client_name, created_by, requested_by, assigned_to, finalized_at, converted_order_id, converted_at)
values
  ('33333333-0000-4000-8000-0000000000b1', 'REQ-FIXTURE-1', 'converted', 'Fixture Client',
   '11111111-0000-4000-8000-000000000002', '11111111-0000-4000-8000-000000000002',
   '11111111-0000-4000-8000-000000000003', now(), '22222222-0000-4000-8000-0000000000a1', now());

-- One UNFINALIZED upload-stage draft: the row the cleanup path deletes, and the
-- one the admin and the assignee must NOT see (20260711000000's rule).
insert into public.order_requests
  (id, request_number, status, client_name, created_by, requested_by, assigned_to, finalized_at)
values
  ('33333333-0000-4000-8000-0000000000b2', 'REQ-FIXTURE-2', 'draft', 'Fixture Client Two',
   '11111111-0000-4000-8000-000000000002', '11111111-0000-4000-8000-000000000002',
   '11111111-0000-4000-8000-000000000003', null);

insert into public.order_request_activity (order_request_id, event_type)
values ('33333333-0000-4000-8000-0000000000b1', 'finalized'),
       ('33333333-0000-4000-8000-0000000000b2', 'created');

insert into public.order_request_attachments (order_request_id, storage_path)
values ('33333333-0000-4000-8000-0000000000b1', 'order-requests/REQ-FIXTURE-1/main-pi.xlsx'),
       ('33333333-0000-4000-8000-0000000000b2', 'order-requests/REQ-FIXTURE-2/main-pi.xlsx');

-- Historical money still carrying the retired linkage. Under the canonical
-- attribution rule this payment has never been attributed to anything —
-- order_request_id is not an attribution input — so it reads as Available, and
-- the unlink path is how it reaches a real target.
insert into public.finance_payment_requests
  (id, request_number, client_name, amount, status, submitted_by, order_request_id, order_request_number)
values ('44444444-0000-4000-8000-0000000000c1', 'PAY-FIXTURE-1', 'Fixture Client', 50000, 'approved',
        '11111111-0000-4000-8000-000000000002',
        '33333333-0000-4000-8000-0000000000b1', 'REQ-FIXTURE-1');

-- A payment with no retired linkage at all, so the Finance assertions can prove
-- the ordinary ledger is untouched.
insert into public.finance_payment_requests
  (id, request_number, client_name, amount, status, submitted_by, order_id)
values ('44444444-0000-4000-8000-0000000000c2', 'PAY-FIXTURE-2', 'Fixture Client', 25000, 'approved',
        '11111111-0000-4000-8000-000000000002',
        '22222222-0000-4000-8000-0000000000a1');
