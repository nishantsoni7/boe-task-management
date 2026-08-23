-- ═════════════════════════════════════════════════════════════════════════════
-- A PRODUCTION-SHAPED SCHEMA, for migration dry runs and role-based RLS tests
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS. The migration set is not self-contained (see
-- docs/migrations-are-not-self-contained.md): four tables are referenced but
-- never created, so no database can be built by replaying supabase/migrations.
-- That has meant every security claim about Finance and Orders was argued from
-- SQL text rather than executed.
--
-- This file closes that gap for the payment-visibility surface. It is NOT a
-- baseline schema and must never be added to supabase/migrations — it creates
-- only what the payment, Order and PI visibility rules touch, and it is built to
-- be thrown away.
--
-- WHAT IS FAITHFUL, AND WHAT IS A STUB
-- ------------------------------------
--   FAITHFUL, copied from the applied migrations and load-bearing for the tests:
--     * every SELECT policy on orders, order_submissions,
--       finance_payment_requests, finance_payment_allocations and
--       payment_proof_attachments, plus the RESTRICTIVE module entry gates;
--     * module_entry_open, actor_has_permission, actor_has_module_permission,
--       can_verify_pi_finance, can_view_order_submission, can_view_order,
--       finance_payment_status_is_verified;
--     * the PRE-CORRECTION definitions of can_read_payment_as_participant
--       (20260919000000 §2) and order_linked_payment_total (20260816000000 §5),
--       so a run of this file alone reproduces both live exposures.
--
--   STUBBED, because their internals are irrelevant here and their real
--   definitions pull in the permission engine's whole table set:
--     * resolve_permission(), backed by a plain grants table.
--
-- Every table carries only the columns these rules and the
-- finance_received_payments projection actually read.

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

-- ─── Tables ──────────────────────────────────────────────────────────────────

create table public.users (
  id uuid primary key, full_name text, role text, team text,
  is_active boolean not null default true, is_deleted boolean not null default false);

create table public.orders (
  id uuid primary key, display_number text, status text not null default 'confirmed',
  requested_by uuid, assigned_to uuid);

create table public.order_submissions (
  id uuid primary key, status text not null default 'submitted',
  created_by uuid, submitted_by uuid, assigned_to uuid);

create table public.finance_payment_requests (
  id uuid primary key,
  request_number text, client_name text, amount numeric not null,
  payment_date date, payment_mode text, received_in text, proof_note text,
  order_number text, order_id uuid references public.orders(id),
  order_request_id uuid, order_request_number text, sales_note text,
  status text not null, payment_against text,
  submitted_by uuid, approved_by uuid, admin_note text,
  created_at timestamptz not null default now(), approved_at timestamptz);

create table public.finance_payment_allocations (
  id uuid primary key,
  payment_request_id uuid not null references public.finance_payment_requests(id),
  allocated_amount numeric not null,
  status text not null,
  order_id uuid references public.orders(id),
  order_submission_id uuid references public.order_submissions(id),
  created_at timestamptz not null default now());

create index finance_payment_allocations_payment_active_idx
  on public.finance_payment_allocations (payment_request_id) where status = 'active';
create index finance_payment_allocations_order_idx
  on public.finance_payment_allocations (order_id);

create table public.payment_proof_attachments (
  id uuid primary key,
  payment_request_id uuid not null references public.finance_payment_requests(id));

-- The permission-engine stand-in: one row per granted (user, module, action).
create table public.t_permission_grants (
  user_id uuid not null, module_key text not null, action_key text not null,
  primary key (user_id, module_key, action_key));

grant select on public.users, public.orders, public.order_submissions,
                public.finance_payment_requests, public.finance_payment_allocations,
                public.payment_proof_attachments
  to authenticated;

-- ─── Helper functions, copied from the applied migrations ────────────────────

-- STUB. The real one resolves role/user/department precedence (20260660 §7).
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

-- 20260901000000 §1, verbatim.
create or replace function public.actor_has_permission(p_module_key text, p_action_key text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.is_active and coalesce(u.is_deleted, false) = false
  ) and public.resolve_permission(auth.uid(), p_module_key, p_action_key);
$$;

create or replace function public.actor_has_module_permission(p_module_key text, p_action_key text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.role = 'admin' and u.is_active
        and coalesce(u.is_deleted, false) = false
    )
    or public.actor_has_permission(p_module_key, p_action_key);
$$;

-- 20260915000000 §8, verbatim.
create or replace function public.can_verify_pi_finance()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.role = 'admin' and u.is_active
        and coalesce(u.is_deleted, false) = false
    )
    or public.actor_has_permission('finance', 'verify');
$$;

-- 20260915000000 §9, verbatim.
create or replace function public.can_view_order_submission(p_submission_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.order_submissions s
    where s.id = p_submission_id
      and (
        s.created_by  = auth.uid()
        or s.submitted_by = auth.uid()
        or s.assigned_to  = auth.uid()
        or public.actor_has_module_permission('orders', 'approve_order')
        or (s.status in ('submitted', 'approved') and public.can_verify_pi_finance())
      )
  );
$$;

-- 20260924000000 §1, verbatim — SECURITY INVOKER on purpose.
create or replace function public.can_view_order(p_order_id uuid)
returns boolean language sql stable security invoker set search_path = public, pg_temp as $$
  select exists (select 1 from public.orders o where o.id = p_order_id);
$$;

-- 20260918000000 §5, verbatim.
create or replace function public.finance_payment_status_is_verified(p_status text)
returns boolean language sql immutable parallel safe set search_path = public, pg_temp as $$
  select coalesce(p_status in ('approved_unlinked', 'approved_linked'), false)
$$;

-- ═══ THE TWO DEFECTIVE DEFINITIONS, AS THEY ARE IN THE APPLIED SCHEMA ═══════
--
-- Installed unchanged so that running this file and nothing else reproduces
-- both exposures, and so the corrective migration is seen to close them.

-- 20260919000000 §2 — SECURITY DEFINER with a bare EXISTS on public.orders.
create or replace function public.can_read_payment_as_participant(p_payment_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
    from public.finance_payment_allocations a
    where a.payment_request_id = p_payment_id
      and (
        (a.order_submission_id is not null
         and public.module_entry_open('orders')
         and public.can_view_order_submission(a.order_submission_id))
        or
        (a.order_id is not null
         and exists (select 1 from public.orders o where o.id = a.order_id))
      )
  );
$$;
revoke execute on function public.can_read_payment_as_participant(uuid) from public, anon;
grant  execute on function public.can_read_payment_as_participant(uuid) to authenticated;

-- 20260816000000 §5 — SECURITY DEFINER, granted to authenticated, gated on
-- nothing. (The attribution rule itself is corrected by 20261005000000; this is
-- the pre-correction body, so a dry run shows both migrations doing their work.)
create or replace function public.order_linked_payment_total(p_order_id uuid)
returns numeric language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(amount), 0)
    from public.finance_payment_requests
   where order_id = p_order_id and status = 'approved_linked';
$$;
revoke execute on function public.order_linked_payment_total(uuid) from public, anon;
grant  execute on function public.order_linked_payment_total(uuid) to authenticated;

-- ─── Policies, copied from the applied migrations ────────────────────────────

alter table public.orders                      enable row level security;
alter table public.order_submissions           enable row level security;
alter table public.finance_payment_requests    enable row level security;
alter table public.finance_payment_allocations enable row level security;
alter table public.payment_proof_attachments   enable row level security;

-- public.orders — 20260655 / 20260666 / 20260903000000, plus the 20260905000000 gate.
create policy "orders_admin_select" on public.orders for select to authenticated
  using (exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin'));
create policy "orders_operations_select" on public.orders for select to authenticated
  using (exists (select 1 from public.users where users.id = auth.uid() and users.team = 'operations'));
create policy "orders_sales_select" on public.orders for select to authenticated
  using (requested_by = auth.uid() or assigned_to = auth.uid());
create policy "orders_permission_engine_select" on public.orders for select to authenticated
  using (resolve_permission(auth.uid(), 'orders', 'view_all'));
create policy "orders_module_entry_gate" on public.orders as restrictive for all to authenticated
  using (public.module_entry_open('orders')) with check (public.module_entry_open('orders'));

-- public.order_submissions — 20260908000000 §, as altered by 20260915000000 §9.
create policy "order_submissions_select" on public.order_submissions for select to authenticated
  using (
    created_by = auth.uid()
    or submitted_by = auth.uid()
    or assigned_to = auth.uid()
    or public.actor_has_module_permission('orders', 'approve_order')
    or (status in ('submitted', 'approved') and public.can_verify_pi_finance())
  );
create policy "order_submissions_module_entry_gate" on public.order_submissions
  as restrictive for all to authenticated
  using (public.module_entry_open('orders')) with check (public.module_entry_open('orders'));

-- public.finance_payment_requests — the six permissive SELECT policies and the
-- restated restrictive gate (20260628000200, 20260699000000, 20260707000000,
-- 20260903000000, 20260919000000 §2).
create policy "finance_payment_requests_own_select" on public.finance_payment_requests
  for select to authenticated using (submitted_by = auth.uid());
create policy "finance_payment_requests_admin_select" on public.finance_payment_requests
  for select to authenticated
  using (exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin'));
create policy "finance_payment_requests_view_all_select" on public.finance_payment_requests
  for select to authenticated using (resolve_permission(auth.uid(), 'finance', 'view_all'));
-- These two are anchored on public.order_requests, which this harness does not
-- model. They are present so the policy COUNT is right and so nothing here can
-- pretend they do not exist, but their predicate is `false`: no fixture below
-- reaches a payment through an order request, and a stub that granted anything
-- would make the tests weaker rather than stronger.
create policy "finance_payment_requests_order_request_owner_select" on public.finance_payment_requests
  for select to authenticated using (false);
create policy "finance_payment_requests_order_request_assignee_select" on public.finance_payment_requests
  for select to authenticated using (false);
create policy "finance_payment_requests_participant_select" on public.finance_payment_requests
  for select to authenticated
  using (public.can_read_payment_as_participant(finance_payment_requests.id));
create policy "finance_payment_requests_module_entry_gate" on public.finance_payment_requests
  as restrictive for all to authenticated
  using (
    public.module_entry_open('finance')
    or public.can_read_payment_as_participant(finance_payment_requests.id)
  )
  with check (public.module_entry_open('finance'));

-- public.payment_proof_attachments — 20260919000000 §2.
create policy "payment_proof_attachments_participant_select" on public.payment_proof_attachments
  for select to authenticated
  using (public.can_read_payment_as_participant(payment_proof_attachments.payment_request_id));
create policy "payment_proof_attachments_module_entry_gate" on public.payment_proof_attachments
  as restrictive for all to authenticated
  using (
    public.module_entry_open('finance')
    or public.can_read_payment_as_participant(payment_proof_attachments.payment_request_id)
  )
  with check (public.module_entry_open('finance'));

-- public.finance_payment_allocations — 20260918000000 §10. No RESTRICTIVE
-- policy, deliberately, and no INSERT/UPDATE/DELETE policy for any role.
create policy "finance_payment_allocations_admin_select" on public.finance_payment_allocations
  for select to authenticated
  using (exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin'));
create policy "finance_payment_allocations_view_all_select" on public.finance_payment_allocations
  for select to authenticated using (resolve_permission(auth.uid(), 'finance', 'view_all'));
create policy "finance_payment_allocations_payment_owner_select" on public.finance_payment_allocations
  for select to authenticated
  using (exists (select 1 from public.finance_payment_requests r
                  where r.id = finance_payment_allocations.payment_request_id
                    and r.submitted_by = auth.uid()));
create policy "finance_payment_allocations_submission_participant_select" on public.finance_payment_allocations
  for select to authenticated
  using (finance_payment_allocations.order_submission_id is not null
         and public.module_entry_open('orders')
         and public.can_view_order_submission(finance_payment_allocations.order_submission_id));
create policy "finance_payment_allocations_order_participant_select" on public.finance_payment_allocations
  for select to authenticated
  using (finance_payment_allocations.order_id is not null
         and exists (select 1 from public.orders o where o.id = finance_payment_allocations.order_id));
